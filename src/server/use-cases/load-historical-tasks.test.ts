import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHistoricalTasks } from './load-historical-tasks.js';
import type { Task } from '../../core/tasks.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    prompt: overrides.prompt ?? `task ${overrides.id}`,
    cwd: overrides.cwd ?? '/cwd',
    agentType: overrides.agentType ?? 'claude-code',
    status: overrides.status ?? 'completed',
    sessions: overrides.sessions ?? [],
    autonomy: overrides.autonomy ?? 'supervised',
    createdAt: overrides.createdAt ?? new Date('2026-05-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  } as Task;
}

function writeSnapshot(path: string, tasks: Task[], mtimeMs: number): void {
  writeFileSync(path, JSON.stringify({ version: 2, lifetimeSpendUsd: 0, tasks }));
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

describe('loadHistoricalTasks', () => {
  let tempDir: string;
  let tasksFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-hist-test-'));
    tasksFile = join(tempDir, 'tasks.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('no snapshots: returns liveTasks unchanged', async () => {
    const live = [makeTask({ id: 'L1' })];
    const result = await loadHistoricalTasks(live, tasksFile);
    expect(result).toEqual(live);
  });

  test('directory does not exist: returns liveTasks (no throw)', async () => {
    const result = await loadHistoricalTasks([makeTask({ id: 'L1' })], '/nonexistent/dir/tasks.json');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('L1');
  });

  test('snapshot adds historical tasks not in live store', async () => {
    const live = [makeTask({ id: 'L1' })];
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260507'),
      [makeTask({ id: 'H1' }), makeTask({ id: 'H2' })],
      Date.parse('2026-05-07T12:00:00Z'),
    );
    const result = await loadHistoricalTasks(live, tasksFile);
    expect(result.map(t => t.id).sort()).toEqual(['H1', 'H2', 'L1']);
  });

  test('live wins on id collision (snapshot copy is dropped)', async () => {
    const live = [makeTask({ id: 'X', prompt: 'live-version', status: 'inProgress' })];
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260507'),
      [makeTask({ id: 'X', prompt: 'snapshot-version', status: 'completed' })],
      Date.parse('2026-05-07T12:00:00Z'),
    );
    const result = await loadHistoricalTasks(live, tasksFile);
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe('live-version');
    expect(result[0].status).toBe('inProgress');
  });

  test('among snapshots: last-seen-by-mtime wins', async () => {
    // Same task in two snapshots, the newer one has feedback set.
    const earlierMs = Date.parse('2026-05-05T00:00:00Z');
    const laterMs = Date.parse('2026-05-07T00:00:00Z');
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260505'),
      [makeTask({ id: 'Y', completionFeedback: undefined })],
      earlierMs,
    );
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260507'),
      [makeTask({ id: 'Y', completionFeedback: { rating: 'up', recordedAt: '2026-05-07T01:00:00.000Z' } })],
      laterMs,
    );
    const result = await loadHistoricalTasks([], tasksFile);
    expect(result).toHaveLength(1);
    expect(result[0].completionFeedback?.rating).toBe('up');
  });

  test('predelete snapshot recovers a swept task missing from later daily', async () => {
    // Realistic timeline:
    //   T1: task Z is live, predelete snapshot taken before clearCompleted.
    //   T2: clearCompleted removes Z from live store.
    //   T3: next-day daily snapshot reflects the post-sweep state (no Z).
    // Z must survive the union via the predelete snapshot.
    const t1 = Date.parse('2026-05-06T17:33:02Z');
    const t3 = Date.parse('2026-05-07T00:01:00Z');
    writeSnapshot(
      join(tempDir, 'tasks.json.predelete.20260506T173302'),
      [makeTask({ id: 'Z', agentType: 'codex-cli', status: 'completed' })],
      t1,
    );
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260507'),
      [],
      t3,
    );
    const result = await loadHistoricalTasks([], tasksFile);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('Z');
    expect(result[0].agentType).toBe('codex-cli');
  });

  test('corrupt snapshot is skipped, others still read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(tempDir, 'tasks.json.daily.20260505'), 'not json!!!');
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260507'),
      [makeTask({ id: 'OK1' })],
      Date.parse('2026-05-07T00:00:00Z'),
    );
    const result = await loadHistoricalTasks([], tasksFile);
    expect(result.map(t => t.id)).toEqual(['OK1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping corrupt snapshot'));
    warn.mockRestore();
  });

  test('only files with the snapshot prefix are picked up', async () => {
    // Sibling files that are NOT snapshots must be ignored — there's other
    // state in ~/.kookr/ (achievements.json, oss-attempts.json, etc.) and
    // misreading those would trigger CorruptTaskFileError on every cost route call.
    writeFileSync(join(tempDir, 'achievements.json'), '{"foo":1}');
    writeFileSync(join(tempDir, 'tasks.json.tmp-deadbeef'), 'in-flight write');
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260507'),
      [makeTask({ id: 'OK' })],
      Date.parse('2026-05-07T00:00:00Z'),
    );
    const result = await loadHistoricalTasks([], tasksFile);
    expect(result.map(t => t.id)).toEqual(['OK']);
  });

  test('mixed daily + predelete: ordered by mtime, live wins, snapshot tail-merges', async () => {
    const live = [makeTask({ id: 'L', prompt: 'live' })];
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260505'),
      [makeTask({ id: 'L', prompt: 'old-live' }), makeTask({ id: 'A' })],
      Date.parse('2026-05-05T00:00:00Z'),
    );
    writeSnapshot(
      join(tempDir, 'tasks.json.predelete.20260506T120000'),
      [makeTask({ id: 'A', prompt: 'A-newer' }), makeTask({ id: 'B' })],
      Date.parse('2026-05-06T12:00:00Z'),
    );
    writeSnapshot(
      join(tempDir, 'tasks.json.daily.20260507'),
      [makeTask({ id: 'C' })],
      Date.parse('2026-05-07T00:00:00Z'),
    );
    const result = await loadHistoricalTasks(live, tasksFile);
    const byId = new Map(result.map(t => [t.id, t]));
    expect([...byId.keys()].sort()).toEqual(['A', 'B', 'C', 'L']);
    expect(byId.get('L')!.prompt).toBe('live');           // live wins
    expect(byId.get('A')!.prompt).toBe('A-newer');         // last-seen wins among snapshots
  });
});
