import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readChildren, seedChildren, type ChildRecord } from './delivery-ownership-rehearsal';
import {
  type FallbackRecord,
  REQUIRED_FALLBACK_DOC_PATTERNS,
  SPAWN_FAILURE_REASONS,
  auditFallbackAccounting,
  mergeSweep,
  rehearseFallback,
  runParentImplementerFallback,
  simulateSpawn,
  transitionStatus,
  validateFallbackDocs,
} from './parent-implementer-fallback-rehearsal';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/parent-implementer-fallback-rehearsal.ts');
const tsxLoader = import.meta.resolve('tsx');

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'kookr-fallback-rehearsal-'));
}

function seedUnit(stateDir: string, unitId: string): void {
  const records: FallbackRecord[] = [
    {
      unit_id: unitId,
      issue: 1656,
      issues: [1656],
      task_id: null,
      status: 'spawned',
      pr: null,
      merged: false,
      blocker: null,
      delivery: null,
      status_trail: [{ status: 'spawned', at: '2026-07-26T09:00:00Z' }],
    },
  ];
  seedChildren(stateDir, records as ChildRecord[]);
}

const STAMPS = [
  '2026-07-26T10:00:00Z',
  '2026-07-26T10:10:00Z',
  '2026-07-26T10:20:00Z',
  '2026-07-26T10:30:00Z',
];

// --- FB-1: trigger conditions -> bookkeeping -------------------------------
describe('FB-1 spawn failure triggers auditable bookkeeping', () => {
  it('simulateSpawn distinguishes a live task id from every documented failure trigger', () => {
    expect(simulateSpawn({ taskId: 'kookr-abc' })).toEqual({ ok: true, taskId: 'kookr-abc' });
    for (const reason of SPAWN_FAILURE_REASONS) {
      expect(simulateSpawn(reason)).toEqual({ ok: false, taskId: null, reason });
    }
  });

  it('the fallback records a status transition trail from spawn-failed through delivered', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      const outcome = runParentImplementerFallback(dir, 'u-1656', 'spawn-timeout', STAMPS);

      expect(outcome.delivered).toBe(true);
      const statuses = outcome.statusTrail.map((t) => t.status);
      expect(statuses).toEqual(['spawned', 'spawn-failed', 'parent-takeover', 'delivering', 'delivered']);
      // The trigger reason is captured in the trail so a human can audit why the
      // parent took over.
      expect(outcome.statusTrail.find((t) => t.status === 'spawn-failed')?.note).toContain('spawn-timeout');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- FB-2: parent takes over delivery as a single-writer owner -------------
describe('FB-2 parent takes over delivery only as the recorded owner', () => {
  it('a fallback-delivered unit carries delivery owner "parent" and exactly one PR', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      const outcome = runParentImplementerFallback(dir, 'u-1656', 'spawn-http-500', STAMPS);
      expect(outcome.deliveryOwner).toBe('parent');

      const rec = readChildren(dir).find((r) => r.unit_id === 'u-1656') as FallbackRecord;
      expect(rec.delivery?.owner).toBe('parent');
      expect(rec.pr).toBe(outcome.pr);

      // Exactly one PR attempt reached the delivery log — the fallback reuses
      // the #1570 single-writer delivery path, it does not double-deliver.
      const prAttempts = readFileSync(join(dir, 'pr-attempts.log'), 'utf8').trim().split('\n').filter(Boolean);
      expect(prAttempts.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- FB-3/FB-4: no orphan delivery, every delivered unit is trailed --------
describe('FB-3/FB-4 idempotency accounting forbids the 2026-07-26 orphan state', () => {
  it('auditFallbackAccounting flags a delivered unit with task_id: null AND no delivery owner', () => {
    // The exact incident state: parent implementer, no task, no delivery owner.
    const orphan: FallbackRecord[] = [
      { unit_id: 'u-x', task_id: null, delivery: null, delivered: true, status_trail: [{ status: 'delivered', at: 't' }] },
    ];
    const violations = auditFallbackAccounting(orphan);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('task_id: null AND no recorded delivery owner');
  });

  it('auditFallbackAccounting flags a delivered unit with no status transition trail', () => {
    const untrailed: FallbackRecord[] = [
      { unit_id: 'u-y', task_id: null, delivery: { owner: 'parent', at: 't' }, delivered: true, status_trail: [] },
    ];
    const violations = auditFallbackAccounting(untrailed);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('no status transition trail');
  });

  it('a properly booked fallback unit passes the audit', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      runParentImplementerFallback(dir, 'u-1656', 'task-lost-before-session', STAMPS);
      const violations = auditFallbackAccounting(readChildren(dir) as FallbackRecord[]);
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- FB-5: merge sweep picks up task_id: null fallback units ----------------
describe('FB-5 merge sweep matches fallback units by delivery owner', () => {
  it('a delivered task_id: null unit is merged by the sweep and trailed', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      runParentImplementerFallback(dir, 'u-1656', 'spawn-timeout', STAMPS);

      // Before the sweep: delivered but not merged.
      let rec = readChildren(dir).find((r) => r.unit_id === 'u-1656') as FallbackRecord;
      expect(rec.merged).toBe(false);
      expect(rec.task_id).toBeNull();

      mergeSweep(dir, '2026-07-26T11:00:00Z');

      rec = readChildren(dir).find((r) => r.unit_id === 'u-1656') as FallbackRecord;
      expect(rec.merged).toBe(true);
      expect(rec.status).toBe('merged');
      expect(rec.status_trail?.map((t) => t.status)).toContain('merged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- AC end-to-end: rehearsal + literal jq assertion -----------------------
describe('end-to-end fallback rehearsal (spawn fail -> takeover -> deliver -> merge)', () => {
  it('drives multiple units through the fallback with consistent state at each step', () => {
    const dir = freshStateDir();
    try {
      const { outcomes, records, violations } = rehearseFallback(dir);

      // Every unit delivered under the fallback, each with a distinct trigger.
      expect(outcomes.every((o) => o.delivered)).toBe(true);
      expect(new Set(outcomes.map((o) => o.triggeredBy)).size).toBe(SPAWN_FAILURE_REASONS.length);

      // Every unit was never spawned (task_id null) yet is owned by parent and merged.
      expect(records.every((r) => r.task_id == null)).toBe(true);
      expect(records.every((r) => r.delivery?.owner === 'parent')).toBe(true);
      expect(records.every((r) => r.merged === true)).toBe(true);

      // No accounting violation anywhere.
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the literal AC jq assertion holds: no delivered unit with task_id: null AND no delivery owner', () => {
    const dir = freshStateDir();
    try {
      rehearseFallback(dir);

      const jq = spawnSync(
        'jq',
        ['-e', '[.[] | select(.delivered == true and .task_id == null and .delivery == null)] | length == 0', join(dir, 'children.json')],
        { encoding: 'utf8' },
      );
      if (jq.error && (jq.error as NodeJS.ErrnoException).code === 'ENOENT') {
        // jq not installed on this runner — the JS audit above already covers it.
        return;
      }
      expect(jq.status, `jq stdout=${jq.stdout} stderr=${jq.stderr}`).toBe(0);
      expect(jq.stdout.trim()).toBe('true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a hand-planted orphan makes the same jq assertion fail (guard is not vacuous)', () => {
    const dir = freshStateDir();
    try {
      // Reproduce the 2026-07-26 orphan directly in children.json.
      seedChildren(dir, [
        { unit_id: 'u-orphan', task_id: null, delivery: null, delivered: true } as unknown as ChildRecord,
      ]);
      const jq = spawnSync(
        'jq',
        ['-e', '[.[] | select(.delivered == true and .task_id == null and .delivery == null)] | length == 0', join(dir, 'children.json')],
        { encoding: 'utf8' },
      );
      if (jq.error && (jq.error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // `-e` makes jq exit non-zero when the result is false.
      expect(jq.status).not.toBe(0);
      expect(jq.stdout.trim()).toBe('false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- FB-6: doc-presence (anti-drift guard) ---------------------------------
describe('FB-6 playbook documents the parent-implementer fallback', () => {
  it('passes on the real shipped playbook', () => {
    const { errors } = validateFallbackDocs(repoRoot);
    expect(errors, errors.map((e) => `${e.file}: ${e.message}`).join('\n')).toEqual([]);
  });

  it('locks the contract shape (>=6 required patterns)', () => {
    expect(REQUIRED_FALLBACK_DOC_PATTERNS.length).toBeGreaterThanOrEqual(6);
  });

  it('CLI validate exits 0 on the real repo', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, 'validate', repoRoot], {
      encoding: 'utf8',
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('parent-implementer fallback doc validation passed.');
  });

  it('CLI validate exits 1 when the fallback contract is stripped from the playbook', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-fallback-docguard-'));
    try {
      const dest = join(root, 'plugin/playbooks');
      spawnSync('mkdir', ['-p', dest]);
      spawnSync('sh', ['-c', `printf '# empty playbook\\n' > ${join(dest, 'parallel-issue-batch.md')}`]);
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, 'validate', root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('parent-implementer fallback doc validation failed:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI rehearse exits 0 and reports no violations', () => {
    const dir = freshStateDir();
    try {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, 'rehearse', dir], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI exits 2 on an unknown flag', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, 'validate', '--bogus'], {
      encoding: 'utf8',
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown flag(s): --bogus');
  });
});
