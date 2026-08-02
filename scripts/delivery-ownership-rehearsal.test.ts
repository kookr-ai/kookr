import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type ChildRecord,
  assertOwnershipBeforePush,
  claimDelivery,
  deliverUnit,
  leaseFile,
  readChildren,
  REQUIRED_DOC_PATTERNS,
  seedChildren,
  simulateRestart,
  standDownLog,
  validateDeliveryDocs,
} from './delivery-ownership-rehearsal';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/delivery-ownership-rehearsal.ts');
const tsxLoader = import.meta.resolve('tsx');

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'kookr-delivery-rehearsal-'));
}

function seedUnit(stateDir: string, unitId: string): void {
  const records: ChildRecord[] = [
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
    },
  ];
  seedChildren(stateDir, records);
}

function readPrAttempts(stateDir: string): string[] {
  const path = join(stateDir, 'pr-attempts.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
}

/** Run one delivery attempt as a real, separate OS process (the `deliver` CLI
 * mode). Used to prove durability across a process/restart boundary. Captures
 * stderr too so a crashed child surfaces a diagnosable failure instead of a bare
 * `JSON.parse('')` SyntaxError. */
function runDeliverProcess(
  stateDir: string,
  unitId: string,
  actor: string,
  nowIso: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, scriptPath, 'deliver', stateDir, unitId, actor, nowIso],
      { env: { ...process.env, TSX_DISABLE_CACHE: '1' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

// --- INV-1: single-writer -------------------------------------------------
describe('INV-1 single-writer delivery ownership', () => {
  it('a second in-process actor loses the claim to the first', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      const first = claimDelivery(dir, 'u-1656', 'parent', '2026-07-26T10:00:00Z');
      const second = claimDelivery(dir, 'u-1656', 'kookr-child-abc', '2026-07-26T10:02:00Z');

      expect(first.won).toBe(true);
      expect(second.won).toBe(false);
      // The loser reads back the winner's identity, not its own.
      expect(second.delivery.owner).toBe('parent');
      expect(second.delivery.at).toBe('2026-07-26T10:00:00Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contention: N genuinely-concurrent OS processes racing one unit yield exactly one winner and one PR attempt', async () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1659');
      const actors = ['parent', 'kookr-child-a', 'kookr-child-b', 'kookr-child-c'];
      // Launch every actor as a real OS process at once (no await between
      // spawns) so they genuinely overlap in the kernel and race on the O_EXCL
      // lock create. The atomic lock makes exactly one win regardless of
      // interleaving, so this is contention-real yet non-flaky.
      const runs = actors.map(
        (actor, i) =>
          new Promise<{ status: number; stdout: string }>((resolve) => {
            const child = spawn(
              process.execPath,
              ['--import', tsxLoader, scriptPath, 'deliver', dir, 'u-1659', actor, `2026-07-26T11:0${i}:00Z`],
              { env: { ...process.env, TSX_DISABLE_CACHE: '1' } },
            );
            let stdout = '';
            child.stdout.on('data', (d) => {
              stdout += d;
            });
            child.on('close', (status) => resolve({ status: status ?? -1, stdout }));
          }),
      );
      const children = await Promise.all(runs);

      const delivered = children.filter((c) => c.status === 0);
      const stoodDown = children.filter((c) => c.status === 1);
      // Exactly one winner regardless of scheduling.
      expect(delivered.length).toBe(1);
      expect(stoodDown.length).toBe(actors.length - 1);
      // Exactly one PR attempt reached the log — the whole point of #1570.
      expect(readPrAttempts(dir).length).toBe(1);

      // Every loser printed the explicit stand-down line.
      for (const c of stoodDown) {
        const outcome = JSON.parse(c.stdout.trim());
        expect(outcome.delivered).toBe(false);
        expect(outcome.standDownLine).toMatch(/standing down$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- INV-2: read-before-push / stand-down ---------------------------------
describe('INV-2 read-before-push stand-down', () => {
  it('the parent sweep delivers and a same-task second actor stands down with the explicit log line', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1660');
      const parent = deliverUnit(dir, 'u-1660', 'parent', '2026-07-26T12:00:00Z');
      const second = deliverUnit(dir, 'u-1660', 'kookr-child-xyz', '2026-07-26T12:03:00Z');

      expect(parent.delivered).toBe(true);
      expect(second.delivered).toBe(false);
      expect(second.standDownLine).toBe(standDownLog('parent', '2026-07-26T12:00:00Z'));

      // Exactly one PR attempt occurred (AC-2).
      expect(readPrAttempts(dir).length).toBe(1);

      // The rehearsal log carries the stand-down evidence a human can grep.
      const log = readFileSync(join(dir, 'delivery.log'), 'utf8');
      expect(log).toContain('delivery owned by parent since 2026-07-26T12:00:00Z; standing down');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assertOwnershipBeforePush throws (blocks the PR) for a non-owner and passes for the owner', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      claimDelivery(dir, 'u-1656', 'parent', '2026-07-26T10:00:00Z');

      expect(() => assertOwnershipBeforePush(dir, 'u-1656', 'kookr-child-abc')).toThrow(/standing down/);
      expect(assertOwnershipBeforePush(dir, 'u-1656', 'parent').owner).toBe('parent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assertOwnershipBeforePush stands down when no owner is recorded at all', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      expect(() => assertOwnershipBeforePush(dir, 'u-1656', 'parent')).toThrow(/no delivery owner recorded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- INV-3: write-ordering (record lands before push) ---------------------
describe('INV-3 ownership persisted before push', () => {
  it('the delivery record is durable in children.json before any PR attempt is recorded', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1656');
      // Claim writes children.json; only then may a PR attempt be recorded.
      claimDelivery(dir, 'u-1656', 'parent', '2026-07-26T10:00:00Z');
      const rec = readChildren(dir).find((r) => r.unit_id === 'u-1656');
      expect(rec?.delivery).toEqual({ owner: 'parent', at: '2026-07-26T10:00:00Z' });
      // No PR attempt is recorded by claimDelivery itself.
      expect(readPrAttempts(dir).length).toBe(0);

      // deliverUnit records the PR attempt only after the read-before-push gate,
      // which reads the already-persisted record.
      const out = deliverUnit(dir, 'u-1656', 'parent', '2026-07-26T10:00:00Z');
      expect(out.delivered).toBe(true);
      expect(readPrAttempts(dir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- INV-4: completeness (jq over children.json) --------------------------
describe('INV-4 every delivered unit carries a non-null delivery owner', () => {
  it('a rehearsal children.json shows non-null delivery for every delivered unit (JS + jq)', () => {
    const dir = freshStateDir();
    try {
      const records: ChildRecord[] = [
        { unit_id: 'u-1656', issue: 1656, issues: [1656], task_id: null, delivery: null },
        { unit_id: 'u-1659', issue: 1659, issues: [1659], task_id: null, delivery: null },
        { unit_id: 'u-1660', issue: 1660, issues: [1660], task_id: null, delivery: null },
      ];
      seedChildren(dir, records);

      for (const [i, r] of records.entries()) {
        deliverUnit(dir, r.unit_id, 'parent', `2026-07-26T13:0${i}:00Z`);
      }

      const after = readChildren(dir);
      // JS assertion of AC-3.
      const delivered = after.filter((r) => r.delivery != null);
      expect(delivered.length).toBe(3);
      expect(delivered.every((r) => r.delivery && typeof r.delivery.owner === 'string')).toBe(true);

      // The literal AC-3 jq query, run for real when jq is on PATH.
      const jq = spawnSync('jq', ['-e', '[.[] | select(.delivery == null)] | length == 0', join(dir, 'children.json')], {
        encoding: 'utf8',
      });
      if (jq.error && (jq.error as NodeJS.ErrnoException).code === 'ENOENT') {
        // jq not installed on this runner — the JS assertion above already covers it.
        return;
      }
      expect(jq.status, `jq stdout=${jq.stdout} stderr=${jq.stderr}`).toBe(0);
      expect(jq.stdout.trim()).toBe('true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- AC3 (#1904): restart during a batch produces no duplicate PRs --------
// A faithful restart crosses a real boundary: `simulateRestart` drops the
// in-memory lease CAS (deletes the `*.claim.lease` files) and replays the durable
// `delivery` projection from children.json for the still-live owners only —
// exactly the server's `rebuildFromTasks`. The dedup is therefore driven by the
// durable projection, not by a lease file that happened to survive.
describe('AC3 restart during a batch yields no duplicate PRs', () => {
  it('rebuilds the lease from the durable projection so a live owner still dedups the re-run', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1904');
      // Pre-restart: the lease holder delivers once.
      const before = deliverUnit(dir, 'u-1904', 'kookr-child-1904', '2026-08-02T10:00:00Z');
      expect(before.delivered).toBe(true);
      expect(readPrAttempts(dir).length).toBe(1);

      // Restart: the in-memory lease is lost. The owning child is still
      // non-terminal, so its claim is replayed from the durable children.json
      // projection — the rebuilt lease is the load-bearing evidence.
      simulateRestart(dir, ['kookr-child-1904']);
      expect(existsSync(leaseFile(dir, 'u-1904'))).toBe(true);

      // The re-run (a parent sweep, or a re-spawn) finds the rebuilt lease and
      // MUST stand down — no second PR across the restart boundary.
      const afterRestart = deliverUnit(dir, 'u-1904', 'parent', '2026-08-02T10:05:00Z');
      expect(afterRestart.delivered).toBe(false);
      expect(afterRestart.standDownLine).toBe(standDownLog('kookr-child-1904', '2026-08-02T10:00:00Z'));
      expect(readPrAttempts(dir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the dedup rides the durable projection: without the persisted owner, the lease is not rebuilt', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1904b');
      deliverUnit(dir, 'u-1904b', 'kookr-child-1904b', '2026-08-02T10:00:00Z');

      // Erase the durable projection, THEN restart: with nothing to replay, the
      // lease cannot be rebuilt — proving the previous test's dedup came from the
      // durable children.json record, not a stray surviving lease file.
      const records = readChildren(dir);
      const rec = records.find((r) => r.unit_id === 'u-1904b');
      if (rec) rec.delivery = null;
      seedChildren(dir, records);

      simulateRestart(dir, ['kookr-child-1904b']);
      expect(existsSync(leaseFile(dir, 'u-1904b'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a terminated owner auto-releases its lease on restart (no held-forever), matching dead_reclaim', () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1905');
      deliverUnit(dir, 'u-1905', 'kookr-child-1905', '2026-08-02T11:00:00Z');

      // Restart with the owning child TERMINATED (not in the live set): its claim
      // auto-released, so rebuildFromTasks does NOT replay it — the lease is free.
      simulateRestart(dir, []);
      expect(existsSync(leaseFile(dir, 'u-1905'))).toBe(false);

      // The parent reclaims the free lease cleanly (exit 0 in production) and
      // becomes the single writer — consistent with the playbook's auto-release
      // semantics, not a lease held forever by a dead owner.
      const reclaim = claimDelivery(dir, 'u-1905', 'parent', '2026-08-02T11:05:00Z');
      expect(reclaim.won).toBe(true);
      expect(reclaim.delivery.owner).toBe('parent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a genuinely restarted OS process stands down against the rebuilt lease (no second PR)', async () => {
    const dir = freshStateDir();
    try {
      seedUnit(dir, 'u-1906');
      // First process delivers and exits — the pre-restart owner, still live.
      const first = await runDeliverProcess(dir, 'u-1906', 'kookr-child-1906', '2026-08-02T12:00:00Z');
      expect(first.status, `stdout:${first.stdout}\nstderr:${first.stderr}`).toBe(0);
      expect(readPrAttempts(dir).length).toBe(1);

      // Restart across the process boundary: in-memory lease lost, then replayed
      // from the durable projection for the still-live owner.
      simulateRestart(dir, ['kookr-child-1906']);
      expect(existsSync(leaseFile(dir, 'u-1906'))).toBe(true);

      // A fresh process after the restart finds the rebuilt lease and stands
      // down. One PR attempt total across the restart boundary.
      const second = await runDeliverProcess(dir, 'u-1906', 'parent', '2026-08-02T12:05:00Z');
      expect(second.status, `stdout:${second.stdout}\nstderr:${second.stderr}`).toBe(1);
      const outcome = JSON.parse(second.stdout.trim());
      expect(outcome.delivered).toBe(false);
      expect(outcome.standDownLine).toMatch(/standing down$/);
      expect(readPrAttempts(dir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- INV-5: doc-presence (anti-drift guard) -------------------------------
describe('INV-5 playbook documents the delivery-ownership contract', () => {
  it('passes on the real shipped playbook', () => {
    const { errors } = validateDeliveryDocs(repoRoot);
    expect(errors, errors.map((e) => `${e.file}: ${e.message}`).join('\n')).toEqual([]);
  });

  it('locks the contract shape (>=5 required patterns)', () => {
    expect(REQUIRED_DOC_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });

  it('CLI validate exits 0 on the real repo', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, 'validate', repoRoot], {
      encoding: 'utf8',
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('delivery-ownership doc validation passed.');
  });

  it('CLI validate exits 1 when the contract is stripped from the playbook', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-delivery-docguard-'));
    try {
      const dest = join(root, 'plugin/playbooks');
      spawnSync('mkdir', ['-p', dest]);
      // A playbook with none of the required contract text.
      spawnSync('sh', ['-c', `printf '# empty playbook\\n' > ${join(dest, 'parallel-issue-batch.md')}`]);
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, 'validate', root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('delivery-ownership doc validation failed:');
    } finally {
      rmSync(root, { recursive: true, force: true });
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
