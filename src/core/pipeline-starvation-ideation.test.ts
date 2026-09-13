import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from './tasks.js';
import {
  countEligibleIssueCreatedInRunDir,
  countTerminatedAtLaunchIdeaScoutsForRepo,
  findRecentSuccessfulIdeationAtMs,
  findRecentSuccessfulIdeationDetails,
  isIdeaScoutInFlightForRepo,
} from './pipeline-starvation-ideation.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('scout completion timestamp selection', () => {
  const nowMs = Date.UTC(2026, 8, 1);
  const windowStart = nowMs - 60_000;
  const dirMs = nowMs - 20_000;
  const stateMs = nowMs - 10_000;
  const states = [
    { name: 'DONE', body: '<promise>DONE</promise>', atMs: stateMs },
    { name: 'non-DONE', body: 'Still scouting', atMs: stateMs },
    { name: 'empty', body: '', atMs: stateMs },
    { name: 'absent', body: null, atMs: dirMs },
    { name: 'stale DONE', body: 'DONE', mtimeMs: windowStart - 1, atMs: dirMs },
    { name: 'stale non-DONE', body: 'Still scouting', mtimeMs: windowStart - 1, atMs: dirMs },
    { name: 'window boundary', body: 'STOP: COMPLETE', mtimeMs: windowStart, atMs: windowStart },
    { name: 'unreadable', body: 'DONE', atMs: dirMs },
    { name: 'directory', body: null, atMs: dirMs },
  ];

  for (const state of states) {
    test.skipIf(state.name === 'unreadable' && process.getuid?.() === 0).each([
      { receipt: 'published', raw: '{"number":99,"title":"Useful issue"}', eligible: true },
      { receipt: 'legacy', raw: '{"title":"Useful issue"}', eligible: true },
      { receipt: 'umbrella', raw: '{"number":100,"title":"Umbrella: rollout"}', eligible: false },
      { receipt: 'invalid', raw: 'not JSON', eligible: false },
      { receipt: 'absent', raw: null, eligible: false },
    ])(`${state.name} state with $receipt receipt preserves selection`, async ({ raw, eligible }) => {
      const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-clock-'));
      onTestFinished(() => rm(base, { recursive: true, force: true }));
      const runDir = join(base, 'candidate');
      await mkdir(runDir);
      const statePath = join(runDir, 'state.md');
      if (state.body !== null) await writeFile(statePath, state.body);
      if (state.name === 'directory') await mkdir(statePath);
      if (state.body !== null || state.name === 'directory') {
        await utimes(statePath, new Date(stateMs), new Date(state.mtimeMs ?? stateMs));
      }
      if (state.name === 'unreadable') {
        await chmod(statePath, 0);
        await expect(readFile(statePath)).rejects.toMatchObject({ code: 'EACCES' });
      }
      if (raw !== null) await writeFile(join(runDir, 'issue-created.json'), raw);
      await utimes(runDir, new Date(dirMs), new Date(dirMs));

      const opts = { nowMs, lookbackMs: nowMs - windowStart, ideaScoutStateDir: base };
      const expected = eligible ? { runKey: 'candidate', atMs: state.atMs, issueCreatedCount: 1 } : null;
      expect(await findRecentSuccessfulIdeationDetails('owner/repo', opts)).toEqual(expected);
      expect(await findRecentSuccessfulIdeationAtMs('owner/repo', opts)).toBe(expected?.atMs ?? null);

      // A second run makes using the wrong clock observable in the selected run too.
      const otherDir = join(base, 'other');
      const otherMs = nowMs - 15_000;
      await mkdir(otherDir);
      await writeFile(join(otherDir, 'issue-created.json'), '{"number":101}');
      await utimes(otherDir, new Date(otherMs), new Date(otherMs));
      expect(await findRecentSuccessfulIdeationDetails('owner/repo', opts)).toEqual(
        eligible && state.atMs > otherMs
          ? expected
          : { runKey: 'other', atMs: otherMs, issueCreatedCount: 1 },
      );
    });
  }

  test('a recent state cannot revive a run whose directory is outside the window', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-clock-'));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const runDir = join(base, 'old-run');
    await mkdir(runDir);
    await writeFile(join(runDir, 'state.md'), 'DONE');
    await writeFile(join(runDir, 'issue-created.json'), '{"number":99}');
    await utimes(join(runDir, 'state.md'), new Date(stateMs), new Date(stateMs));
    await utimes(runDir, new Date(windowStart - 1), new Date(windowStart - 1));
    expect(await findRecentSuccessfulIdeationDetails('owner/repo', {
      nowMs, lookbackMs: nowMs - windowStart, ideaScoutStateDir: base,
    })).toBeNull();
  });

  test('selects a large readable state without a whole-document read', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-clock-'));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const runDir = join(base, 'large-run');
    await mkdir(runDir);
    const statePath = join(runDir, 'state.md');
    await writeFile(statePath, 'DONE');
    await truncate(statePath, 16 * 1024 * 1024);
    await writeFile(join(runDir, 'issue-created.json'), '{"number":99}');
    await utimes(statePath, new Date(stateMs), new Date(stateMs));
    await utimes(runDir, new Date(dirMs), new Date(dirMs));
    vi.mocked(readFile).mockClear();

    expect(await findRecentSuccessfulIdeationDetails('owner/repo', {
      nowMs, lookbackMs: nowMs - windowStart, ideaScoutStateDir: base,
    })).toEqual({ runKey: 'large-run', atMs: stateMs, issueCreatedCount: 1 });
    expect(vi.mocked(readFile).mock.calls.some(([path]) => path === statePath)).toBe(false);
  });
});

describe('pipeline-starvation ideation discovery (#1715 / overnight-throughput PR1)', () => {
  test('DONE alone without issue-created is NOT successful ideation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');

    const found = await findRecentSuccessfulIdeationAtMs('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(found).toBeNull();
  });

  test('DONE + non-umbrella issue-created counts as successful ideation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-ok');
    await mkdir(join(runDir, 'recommendations', '01-leaf'), { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\nDONE\n', 'utf-8');
    await writeFile(
      join(runDir, 'recommendations', '01-leaf', 'issue-created.json'),
      JSON.stringify({ number: 99, title: 'feat: bound control-room feed caches' }),
      'utf-8',
    );

    const details = await findRecentSuccessfulIdeationDetails('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(details).not.toBeNull();
    expect(details!.issueCreatedCount).toBe(1);
    expect(details!.runKey).toBe('run-ok');
  });

  test('umbrella-only issue-created does NOT count as eligible ideation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-umb');
    await mkdir(join(runDir, 'recommendations', '01-umb'), { recursive: true });
    await writeFile(join(runDir, 'state.md'), '<promise>DONE</promise>\n', 'utf-8');
    await writeFile(
      join(runDir, 'recommendations', '01-umb', 'issue-created.json'),
      JSON.stringify({ number: 100, title: 'Umbrella: trustworthy gates' }),
      'utf-8',
    );

    const found = await findRecentSuccessfulIdeationAtMs('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(found).toBeNull();
    expect(await countEligibleIssueCreatedInRunDir(runDir)).toBe(0);
  });

  test('ignores runs without a DONE marker and without issue-created', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-wip');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout still running\n', 'utf-8');

    const found = await findRecentSuccessfulIdeationAtMs('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(found).toBeNull();
  });

  test('detects in-flight scout by playbookId + projectId', () => {
    const store = new TaskStore();
    store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
    });
    expect(isIdeaScoutInFlightForRepo('jeanibarz/lucy', store.listTasks())).toBe(true);
    expect(isIdeaScoutInFlightForRepo('kookr-ai/kookr', store.listTasks())).toBe(false);
  });

  test('counts idea-scouts that died at launch inside the window (#2744)', () => {
    const store = new TaskStore();
    const live = store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
    });
    const dead = store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
    });
    store.setDisposition(dead.id, {
      reason: 'launch_error',
      at: new Date().toISOString(),
      source: 'launch-service',
      detail: 'Grok authentication expired',
    });
    store.terminateTask(dead.id);
    const otherRepo = store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/kookr-ai/kookr',
    });
    store.setDisposition(otherRepo.id, {
      reason: 'launch_error',
      at: new Date().toISOString(),
      source: 'launch-service',
    });
    store.terminateTask(otherRepo.id);

    const sinceMs = live.createdAt.getTime() - 1;
    expect(countTerminatedAtLaunchIdeaScoutsForRepo('jeanibarz/lucy', store.listTasks(), sinceMs)).toBe(1);
    expect(countTerminatedAtLaunchIdeaScoutsForRepo('jeanibarz/lucy', store.listTasks(), Date.now() + 60_000)).toBe(0);
    expect(isIdeaScoutInFlightForRepo('jeanibarz/lucy', store.listTasks())).toBe(true);
  });
});
