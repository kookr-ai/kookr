import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planAndPruneMaintenance, PRESERVED_STORES } from './maintenance-prune.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Fixed "now" so age math is deterministic regardless of wall clock.
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const now = () => NOW;
const daysAgo = (n: number) => new Date(NOW - n * MS_PER_DAY).toISOString();

interface SeedSession {
  tmuxSession: string;
  lastEventAt?: number;
}
interface SeedTask {
  id: string;
  status: string;
  updatedAt?: string;
  terminatedAt?: string;
  createdAt?: string;
  sessions: SeedSession[];
}

describe('planAndPruneMaintenance', () => {
  let dataDir: string;
  let hooksDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kookr-maint-'));
    hooksDir = join(dataDir, 'hooks');
    await mkdir(hooksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeTasks(tasks: SeedTask[]): Promise<void> {
    await writeFile(
      join(dataDir, 'tasks.json'),
      JSON.stringify({ version: 2, lifetimeSpendUsd: 0, tasks }),
      'utf8',
    );
  }

  async function writeHook(tmuxSession: string, mtimeDaysAgo?: number): Promise<string> {
    const path = join(hooksDir, `${tmuxSession}.jsonl`);
    await writeFile(path, `{"event":"Stop","session":"${tmuxSession}"}\n`, 'utf8');
    if (mtimeDaysAgo !== undefined) {
      const when = new Date(NOW - mtimeDaysAgo * MS_PER_DAY);
      await utimes(path, when, when);
    }
    return path;
  }

  async function writeDataFile(fileName: string, contents: string, mtimeDaysAgo?: number): Promise<string> {
    const path = join(dataDir, fileName);
    await writeFile(path, contents, 'utf8');
    if (mtimeDaysAgo !== undefined) {
      const when = new Date(NOW - mtimeDaysAgo * MS_PER_DAY);
      await utimes(path, when, when);
    }
    return path;
  }

  async function writeActivity(session: string, opts: { rotated?: boolean; mtimeDaysAgo?: number } = {}): Promise<string> {
    const activityDir = join(dataDir, 'activity');
    await mkdir(activityDir, { recursive: true });
    const path = join(activityDir, `${session}.jsonl${opts.rotated ? '.1' : ''}`);
    await writeFile(path, `{"envelope":{"kookrSessionId":"${session}"}}\n`, 'utf8');
    if (opts.mtimeDaysAgo !== undefined) {
      const when = new Date(NOW - opts.mtimeDaysAgo * MS_PER_DAY);
      await utimes(path, when, when);
    }
    return path;
  }

  async function writePlaybookRun(playbook: string, runKey: string, mtimeDaysAgo?: number): Promise<string> {
    const runDir = join(dataDir, 'playbook-state', playbook, runKey);
    await mkdir(join(runDir, 'recommendations'), { recursive: true });
    await writeFile(join(runDir, 'state.json'), `{"runKey":"${runKey}"}`, 'utf8');
    await writeFile(join(runDir, 'recommendations', 'report.md'), '# report\n', 'utf8');
    if (mtimeDaysAgo !== undefined) {
      const when = new Date(NOW - mtimeDaysAgo * MS_PER_DAY);
      // Set mtime on the run dir itself — that is what the planner ages by.
      await utimes(runDir, when, when);
    }
    return runDir;
  }

  const exists = async (path: string): Promise<boolean> =>
    stat(path).then(() => true).catch(() => false);

  test('removes hook logs for aged completed-task artifacts', async () => {
    await writeTasks([
      { id: 't-aged', status: 'completed', updatedAt: daysAgo(45), sessions: [{ tmuxSession: 'kookr-aged' }] },
    ]);
    const hookPath = await writeHook('kookr-aged');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]).toMatchObject({
      kind: 'hook-log',
      reason: 'completed-task-aged',
      taskId: 't-aged',
      tmuxSession: 'kookr-aged',
    });
    expect(result.removed).toHaveLength(1);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await exists(hookPath)).toBe(false);
  });

  test('preserves artifacts for active and recent tasks', async () => {
    await writeTasks([
      // active task — never eligible regardless of age
      { id: 't-active', status: 'inProgress', updatedAt: daysAgo(90), sessions: [{ tmuxSession: 'kookr-active' }] },
      // completed but recent — under the threshold
      { id: 't-recent', status: 'completed', updatedAt: daysAgo(5), sessions: [{ tmuxSession: 'kookr-recent' }] },
    ]);
    const activePath = await writeHook('kookr-active');
    const recentPath = await writeHook('kookr-recent');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(await exists(activePath)).toBe(true);
    expect(await exists(recentPath)).toBe(true);
  });

  test('dry-run reports planned removals without mutating', async () => {
    await writeTasks([
      { id: 't-aged', status: 'terminated', terminatedAt: daysAgo(60), sessions: [{ tmuxSession: 'kookr-aged' }] },
    ]);
    const hookPath = await writeHook('kookr-aged');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, dryRun: true, now });

    expect(result.dryRun).toBe(true);
    expect(result.planned).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
    expect(result.reclaimedBytes).toBeGreaterThan(0); // reclaimable
    expect(await exists(hookPath)).toBe(true); // untouched
  });

  test('clean state is a silent no-op', async () => {
    await writeTasks([]);
    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(result.planned).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.reclaimedBytes).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('missing hooks directory is a no-op (no tasks dir either)', async () => {
    await rm(hooksDir, { recursive: true, force: true });
    await writeTasks([]);
    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(result.planned).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('is idempotent — a second run finds nothing left to prune', async () => {
    await writeTasks([
      { id: 't-aged', status: 'completed', updatedAt: daysAgo(45), sessions: [{ tmuxSession: 'kookr-aged' }] },
    ]);
    await writeHook('kookr-aged');

    const first = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(first.removed).toHaveLength(1);

    const second = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(second.planned).toHaveLength(0);
    expect(second.removed).toHaveLength(0);
  });

  async function writeRotatedHook(tmuxSession: string, generation: number, mtimeDaysAgo?: number): Promise<string> {
    const path = join(hooksDir, `${tmuxSession}.jsonl.${generation}`);
    await writeFile(path, `{"event":"PostToolUse","session":"${tmuxSession}","gen":${generation}}\n`, 'utf8');
    if (mtimeDaysAgo !== undefined) {
      const when = new Date(NOW - mtimeDaysAgo * MS_PER_DAY);
      await utimes(path, when, when);
    }
    return path;
  }

  test('prunes rotated hook-log generations alongside the base for an aged completed task (#1433)', async () => {
    await writeTasks([
      { id: 't-aged', status: 'completed', updatedAt: daysAgo(45), sessions: [{ tmuxSession: 'kookr-aged' }] },
    ]);
    const base = await writeHook('kookr-aged');
    const g1 = await writeRotatedHook('kookr-aged', 1);
    const g2 = await writeRotatedHook('kookr-aged', 2);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.removed).toHaveLength(3);
    const generations = result.planned
      .filter((p) => p.kind === 'hook-log')
      .map((p) => (p as { generation?: number }).generation);
    // Base file carries no generation; the two rotated segments carry 1 and 2.
    expect(generations.filter((g) => g === undefined)).toHaveLength(1);
    expect(generations.filter((g) => typeof g === 'number').sort()).toEqual([1, 2]);
    for (const p of result.planned) {
      expect(p).toMatchObject({ kind: 'hook-log', reason: 'completed-task-aged', taskId: 't-aged', tmuxSession: 'kookr-aged' });
    }
    expect(await exists(base)).toBe(false);
    expect(await exists(g1)).toBe(false);
    expect(await exists(g2)).toBe(false);
  });

  test('never prunes rotated generations of an active session (#1433)', async () => {
    await writeTasks([
      { id: 't-live', status: 'inProgress', updatedAt: daysAgo(90), sessions: [{ tmuxSession: 'kookr-live' }] },
    ]);
    const base = await writeHook('kookr-live');
    const g1 = await writeRotatedHook('kookr-live', 1);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(0);
    expect(await exists(base)).toBe(true);
    expect(await exists(g1)).toBe(true);
  });

  test('prunes aged orphan rotated generations by mtime (#1433)', async () => {
    await writeTasks([]); // no task references this session
    const agedGen = await writeRotatedHook('kookr-orphan-old', 1, 60);
    const freshGen = await writeRotatedHook('kookr-orphan-new', 1, 2);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]).toMatchObject({ reason: 'orphan-aged', tmuxSession: 'kookr-orphan-old', generation: 1 });
    expect(await exists(agedGen)).toBe(false);
    expect(await exists(freshGen)).toBe(true);
  });

  test('prunes aged orphan hook logs but preserves recent orphans', async () => {
    await writeTasks([]); // no task references either file
    const agedOrphan = await writeHook('kookr-orphan-old', 60);
    const freshOrphan = await writeHook('kookr-orphan-new', 2);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]).toMatchObject({ reason: 'orphan-aged', tmuxSession: 'kookr-orphan-old' });
    expect(result.planned[0].taskId).toBeUndefined();
    expect(await exists(agedOrphan)).toBe(false);
    expect(await exists(freshOrphan)).toBe(true);
  });

  test('a session shared with an active task is never pruned', async () => {
    // Same tmuxSession name appears on both an aged-terminal task and an active task.
    await writeTasks([
      { id: 't-done', status: 'completed', updatedAt: daysAgo(90), sessions: [{ tmuxSession: 'kookr-shared' }] },
      { id: 't-live', status: 'inProgress', updatedAt: daysAgo(90), sessions: [{ tmuxSession: 'kookr-shared' }] },
    ]);
    const path = await writeHook('kookr-shared');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(0);
    expect(await exists(path)).toBe(true);
  });

  test('uses the latest session lastEventAt when it is more recent than updatedAt', async () => {
    // updatedAt is old, but a session event is recent → task is NOT aged out.
    await writeTasks([
      {
        id: 't-touch',
        status: 'completed',
        updatedAt: daysAgo(90),
        sessions: [{ tmuxSession: 'kookr-touch', lastEventAt: NOW - 3 * MS_PER_DAY }],
      },
    ]);
    const path = await writeHook('kookr-touch');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(0);
    expect(await exists(path)).toBe(true);
  });

  test('unreadable tasks.json prunes nothing and warns', async () => {
    await writeFile(join(dataDir, 'tasks.json'), '{ this is not json', 'utf8');
    const orphan = await writeHook('kookr-orphan-old', 90);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(await exists(orphan)).toBe(true); // safety: nothing deleted when state is unknown
  });

  test('leaves non-hook stores intact and documents them as preserved', async () => {
    await writeTasks([
      { id: 't-aged', status: 'completed', updatedAt: daysAgo(45), sessions: [{ tmuxSession: 'kookr-aged' }] },
    ]);
    await writeHook('kookr-aged');
    // Seed sibling stores the sweep must never touch.
    await writeFile(join(dataDir, 'detection-stats.json'), '{"schemaVersion":"detection-stats.v1"}', 'utf8');
    await writeFile(join(dataDir, 'oss-attempts.json'), '{"attempts":[]}', 'utf8');
    await mkdir(join(dataDir, 'activity'), { recursive: true });
    await writeFile(join(dataDir, 'activity', 'sess.jsonl'), '{}\n', 'utf8');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.removed).toHaveLength(1); // only the aged hook log
    expect(await exists(join(dataDir, 'detection-stats.json'))).toBe(true);
    expect(await exists(join(dataDir, 'oss-attempts.json'))).toBe(true);
    expect(await exists(join(dataDir, 'activity', 'sess.jsonl'))).toBe(true);
    expect(await exists(join(dataDir, 'tasks.json'))).toBe(true);
    expect(result.preserved).toEqual([...PRESERVED_STORES]);
    expect(result.preserved.length).toBeGreaterThan(0);
  });

  test('prunes aged server.log generations without deleting the current log', async () => {
    await writeTasks([]);
    const current = await writeDataFile('server.log', 'current\n', 90);
    const agedGeneration = await writeDataFile('server.log.1', 'old\n', 60);
    const recentGeneration = await writeDataFile('server.log.2', 'recent\n', 2);
    const nonGeneration = await writeDataFile('server.log.previous', 'manual copy\n', 90);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]).toMatchObject({
      kind: 'server-log-generation',
      reason: 'server-log-generation-aged',
      generation: 1,
    });
    expect(await exists(agedGeneration)).toBe(false);
    expect(await exists(current)).toBe(true);
    expect(await exists(recentGeneration)).toBe(true);
    expect(await exists(nonGeneration)).toBe(true);
  });

  test('dry-run reports aged server.log generations without deleting them', async () => {
    await writeTasks([]);
    const agedGeneration = await writeDataFile('server.log.3', 'old\n', 60);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, dryRun: true, now });

    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]).toMatchObject({ kind: 'server-log-generation', generation: 3 });
    expect(result.removed).toHaveLength(0);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await exists(agedGeneration)).toBe(true);
  });

  test('malformed tasks.json still allows server.log generation pruning', async () => {
    await writeFile(join(dataDir, 'tasks.json'), '{ this is not json', 'utf8');
    const orphan = await writeHook('kookr-orphan-old', 90);
    const agedGeneration = await writeDataFile('server.log.1', 'old\n', 60);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.warnings.join('\n')).toMatch(/tasks\.json is unreadable/);
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]).toMatchObject({ kind: 'server-log-generation' });
    expect(await exists(orphan)).toBe(true);
    expect(await exists(agedGeneration)).toBe(false);
  });

  test('absent tasks.json still prunes aged orphans (ENOENT != malformed)', async () => {
    // No tasks.json at all → readTasks returns [] (not undefined), so orphan
    // pruning proceeds and no "unreadable" warning is emitted.
    const orphan = await writeHook('kookr-orphan-old', 60);
    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(result.warnings).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].reason).toBe('orphan-aged');
    expect(await exists(orphan)).toBe(false);
  });

  test('skips a non-regular-file entry that looks like a hook log', async () => {
    await writeTasks([
      { id: 't-aged', status: 'completed', updatedAt: daysAgo(45), sessions: [{ tmuxSession: 'kookr-dir' }] },
    ]);
    // A directory named like a hook file must never be treated as removable.
    await mkdir(join(hooksDir, 'kookr-dir.jsonl'), { recursive: true });
    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(result.planned).toHaveLength(0);
    expect(await exists(join(hooksDir, 'kookr-dir.jsonl'))).toBe(true);
  });

  test('accepts ISO-string session lastEventAt', async () => {
    await writeTasks([
      {
        id: 't-touch',
        status: 'completed',
        updatedAt: daysAgo(90),
        // lastEventAt as an ISO string (not ms) — recent, so the task is not aged.
        sessions: [{ tmuxSession: 'kookr-touch', lastEventAt: daysAgo(3) as unknown as number }],
      },
    ]);
    await writeHook('kookr-touch');
    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(result.planned).toHaveLength(0);
  });

  test('rejects a non-positive maxAgeDays', async () => {
    await writeTasks([]);
    await expect(planAndPruneMaintenance({ dataDir, maxAgeDays: 0, now })).rejects.toThrow(/positive/);
  });

  test('tolerates a bare task array (legacy shape)', async () => {
    await writeFile(
      join(dataDir, 'tasks.json'),
      JSON.stringify([{ id: 't-aged', status: 'completed', updatedAt: daysAgo(45), sessions: [{ tmuxSession: 'kookr-aged' }] }]),
      'utf8',
    );
    await writeHook('kookr-aged');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(result.removed).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Activity-ledger orphan GC (idea-scout rank 1)
  // ---------------------------------------------------------------------------

  test('removes aged orphan activity-ledger files (primary + rotated companion)', async () => {
    await writeTasks([]); // no task references this session
    const primary = await writeActivity('kookr-orphan', { mtimeDaysAgo: 60 });
    const rotated = await writeActivity('kookr-orphan', { rotated: true, mtimeDaysAgo: 60 });

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    const activity = result.planned.filter((p) => p.kind === 'activity-ledger');
    expect(activity).toHaveLength(2);
    expect(activity.every((p) => p.reason === 'orphan-aged')).toBe(true);
    expect(activity.every((p) => p.taskId === undefined)).toBe(true);
    expect(await exists(primary)).toBe(false);
    expect(await exists(rotated)).toBe(false);
  });

  test('removes activity-ledger files for aged completed tasks and maps the task id', async () => {
    await writeTasks([
      { id: 't-done', status: 'completed', updatedAt: daysAgo(45), sessions: [{ tmuxSession: 'kookr-done' }] },
    ]);
    const primary = await writeActivity('kookr-done');

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    const activity = result.planned.filter((p) => p.kind === 'activity-ledger');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ kind: 'activity-ledger', reason: 'completed-task-aged', kookrSessionId: 'kookr-done' });
    expect((activity[0] as { taskId?: string }).taskId).toBe('t-done');
    expect(await exists(primary)).toBe(false);
  });

  test('never deletes activity-ledger for a live (active) session, even when aged', async () => {
    await writeTasks([
      { id: 't-live', status: 'inProgress', updatedAt: daysAgo(90), sessions: [{ tmuxSession: 'kookr-live' }] },
    ]);
    const primary = await writeActivity('kookr-live', { mtimeDaysAgo: 90 });
    const rotated = await writeActivity('kookr-live', { rotated: true, mtimeDaysAgo: 90 });

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned.filter((p) => p.kind === 'activity-ledger')).toHaveLength(0);
    expect(await exists(primary)).toBe(true);
    expect(await exists(rotated)).toBe(true);
  });

  test('preserves recent orphan activity-ledger files (age gate)', async () => {
    await writeTasks([]);
    const fresh = await writeActivity('kookr-fresh', { mtimeDaysAgo: 2 });

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.planned.filter((p) => p.kind === 'activity-ledger')).toHaveLength(0);
    expect(await exists(fresh)).toBe(true);
  });

  test('dry-run plans activity-ledger removals without unlinking', async () => {
    await writeTasks([]);
    const primary = await writeActivity('kookr-orphan', { mtimeDaysAgo: 60 });

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, dryRun: true, now });

    expect(result.planned.filter((p) => p.kind === 'activity-ledger')).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await exists(primary)).toBe(true);
  });

  test('activity ledger is no longer listed as a preserved store', async () => {
    await writeTasks([]);
    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });
    expect(result.preserved.some((p) => /activity/i.test(p.store))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Playbook-state retention (idea-scout rank 6)
  // ---------------------------------------------------------------------------

  test('removes aged playbook-state run dirs but preserves recent ones', async () => {
    await writeTasks([]);
    const oldRun = await writePlaybookRun('repository-idea-scout', 'run-old', 60);
    const freshRun = await writePlaybookRun('repository-idea-scout', 'run-new', 3);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    const runs = result.planned.filter((p) => p.kind === 'playbook-state-run');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'playbook-state-run', reason: 'playbook-run-aged', playbook: 'repository-idea-scout', runKey: 'run-old' });
    expect(runs[0].bytes).toBeGreaterThan(0);
    expect(await exists(oldRun)).toBe(false);
    expect(await exists(freshRun)).toBe(true);
  });

  test('keep-last-K protects the newest runs per playbook even when aged', async () => {
    await writeTasks([]);
    const older = await writePlaybookRun('scout', 'run-1', 90);
    const newer = await writePlaybookRun('scout', 'run-2', 60);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, playbookStateKeepLast: 1, now });

    const runs = result.planned.filter((p) => p.kind === 'playbook-state-run');
    expect(runs).toHaveLength(1);
    expect(runs[0].path).toBe(older);
    expect(await exists(older)).toBe(false);
    expect(await exists(newer)).toBe(true); // newest kept by keep-last
  });

  test('never removes a playbook run whose key matches a still-active task id', async () => {
    await writeTasks([
      { id: 'run-active', status: 'inProgress', updatedAt: daysAgo(90), sessions: [{ tmuxSession: 'kookr-x' }] },
    ]);
    const activeRun = await writePlaybookRun('scout', 'run-active', 90);
    const deadRun = await writePlaybookRun('scout', 'run-dead', 90);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    const runs = result.planned.filter((p) => p.kind === 'playbook-state-run');
    expect(runs.map((r) => (r as { runKey: string }).runKey)).toEqual(['run-dead']);
    expect(await exists(activeRun)).toBe(true);
    expect(await exists(deadRun)).toBe(false);
  });

  test('dry-run plans playbook-state removals without deleting the directory', async () => {
    await writeTasks([]);
    const oldRun = await writePlaybookRun('scout', 'run-old', 60);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, dryRun: true, now });

    expect(result.planned.filter((p) => p.kind === 'playbook-state-run')).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
    expect(await exists(oldRun)).toBe(true);
  });

  test('playbookStateMaxAgeDays overrides maxAgeDays for run dirs only', async () => {
    await writeTasks([]);
    // 10 days old: kept under a 30-day playbook threshold, removed under 7.
    const run = await writePlaybookRun('scout', 'run-mid', 10);

    const kept = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, playbookStateMaxAgeDays: 30, now });
    expect(kept.planned.filter((p) => p.kind === 'playbook-state-run')).toHaveLength(0);
    expect(await exists(run)).toBe(true);

    const pruned = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, playbookStateMaxAgeDays: 7, now });
    expect(pruned.planned.filter((p) => p.kind === 'playbook-state-run')).toHaveLength(1);
    expect(await exists(run)).toBe(false);
  });

  test('malformed tasks.json skips activity + playbook pruning but still prunes server.log', async () => {
    await writeFile(join(dataDir, 'tasks.json'), '{ this is not json', 'utf8');
    const activity = await writeActivity('kookr-orphan', { mtimeDaysAgo: 90 });
    const run = await writePlaybookRun('scout', 'run-old', 90);
    const agedGeneration = await writeDataFile('server.log.1', 'old\n', 60);

    const result = await planAndPruneMaintenance({ dataDir, maxAgeDays: 30, now });

    expect(result.warnings.join('\n')).toMatch(/tasks\.json is unreadable/);
    expect(result.planned.filter((p) => p.kind === 'activity-ledger')).toHaveLength(0);
    expect(result.planned.filter((p) => p.kind === 'playbook-state-run')).toHaveLength(0);
    expect(result.planned.filter((p) => p.kind === 'server-log-generation')).toHaveLength(1);
    expect(await exists(activity)).toBe(true);
    expect(await exists(run)).toBe(true);
    expect(await exists(agedGeneration)).toBe(false);
  });

  test('rejects a negative playbookStateKeepLast', async () => {
    await writeTasks([]);
    await expect(planAndPruneMaintenance({ dataDir, maxAgeDays: 30, playbookStateKeepLast: -1, now })).rejects.toThrow(/non-negative/);
  });
});
