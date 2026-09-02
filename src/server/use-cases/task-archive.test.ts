import { appendFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskStore, type Task } from '../../core/tasks.js';
import {
  archiveTerminalTasks,
  compactTaskArchive,
  countArchivedTasks,
  DEFAULT_TASK_ARCHIVE_RETENTION_DAYS,
  readArchivedTasks,
} from './task-archive.js';

const NOW = new Date('2026-09-15T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

const tmpDirs: string[] = [];
async function makeArchiveDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-archive-'));
  tmpDirs.push(dir);
  return join(dir, 'task-archive');
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Build a terminal task with a specific last-activity time. */
function makeTerminalTask(id: string, lastActivity: Date): Task {
  const store = new TaskStore();
  const created = store.createTask({ prompt: `prompt ${id}`, cwd: '/repo' });
  store.addSession(created.id, {
    tmuxSession: `sess-${id}`,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date(lastActivity.getTime() - 60_000),
  });
  store.completeTask(created.id);
  const task = store.getTaskForMutation(created.id)!;
  task.id = id; // stable, assertable id for archive tests (store keeps its UUID key)
  task.updatedAt = lastActivity;
  task.finishedAt = lastActivity;
  return task;
}

describe('archiveTerminalTasks', () => {
  it('appends records to the current month segment and is a no-op for an empty batch', async () => {
    const dir = await makeArchiveDir();
    const empty = await archiveTerminalTasks(dir, [], { now: () => NOW });
    expect(empty).toEqual({ archivedCount: 0 });

    const task = makeTerminalTask('a', new Date(NOW - DAY));
    const result = await archiveTerminalTasks(dir, [task], { now: () => NOW });
    expect(result.archivedCount).toBe(1);
    expect(result.segmentPath?.endsWith('202609.jsonl')).toBe(true);

    const files = await readdir(dir);
    expect(files).toEqual(['202609.jsonl']);
  });

  it('archives every terminal record handed to it', async () => {
    const dir = await makeArchiveDir();
    const tasks = ['a', 'b', 'c'].map((id, i) => makeTerminalTask(id, new Date(NOW - (i + 1) * DAY)));
    await archiveTerminalTasks(dir, tasks, { now: () => NOW });
    expect(await countArchivedTasks(dir)).toBe(3);
  });
});

describe('readArchivedTasks', () => {
  it('returns records newest-first', async () => {
    const dir = await makeArchiveDir();
    const older = makeTerminalTask('older', new Date(NOW - 10 * DAY));
    const newer = makeTerminalTask('newer', new Date(NOW - 2 * DAY));
    await archiveTerminalTasks(dir, [older, newer], { now: () => NOW });

    const { records } = await readArchivedTasks(dir);
    expect(records.map((r) => r.task.id)).toEqual(['newer', 'older']);
  });

  it('pages by cursor without dropping or repeating records', async () => {
    const dir = await makeArchiveDir();
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTerminalTask(`t${i}`, new Date(NOW - (i + 1) * DAY)),
    );
    await archiveTerminalTasks(dir, tasks, { now: () => NOW });

    const page1 = await readArchivedTasks(dir, { limit: 2 });
    expect(page1.records.map((r) => r.task.id)).toEqual(['t0', 't1']);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await readArchivedTasks(dir, { limit: 2, cursor: page1.nextCursor });
    expect(page2.records.map((r) => r.task.id)).toEqual(['t2', 't3']);
    expect(page2.nextCursor).toBeDefined();

    const page3 = await readArchivedTasks(dir, { limit: 2, cursor: page2.nextCursor });
    expect(page3.records.map((r) => r.task.id)).toEqual(['t4']);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('emits no cursor when the record count is an exact multiple of the limit', async () => {
    const dir = await makeArchiveDir();
    const tasks = Array.from({ length: 4 }, (_, i) =>
      makeTerminalTask(`t${i}`, new Date(NOW - (i + 1) * DAY)),
    );
    await archiveTerminalTasks(dir, tasks, { now: () => NOW });

    const page1 = await readArchivedTasks(dir, { limit: 2 });
    expect(page1.records.map((r) => r.task.id)).toEqual(['t0', 't1']);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await readArchivedTasks(dir, { limit: 2, cursor: page1.nextCursor });
    expect(page2.records.map((r) => r.task.id)).toEqual(['t2', 't3']);
    // Exact fill on the last page: no phantom trailing cursor / empty page.
    expect(page2.nextCursor).toBeUndefined();
  });

  it('filters by beforeMs (exclusive)', async () => {
    const dir = await makeArchiveDir();
    const recent = makeTerminalTask('recent', new Date(NOW - DAY));
    const old = makeTerminalTask('old', new Date(NOW - 30 * DAY));
    await archiveTerminalTasks(dir, [recent, old], { now: () => NOW });

    const { records } = await readArchivedTasks(dir, { beforeMs: NOW - 5 * DAY });
    expect(records.map((r) => r.task.id)).toEqual(['old']);
  });

  it('revives task Date fields on read', async () => {
    const dir = await makeArchiveDir();
    const task = makeTerminalTask('dates', new Date(NOW - DAY));
    await archiveTerminalTasks(dir, [task], { now: () => NOW });

    const { records } = await readArchivedTasks(dir);
    expect(records[0].task.createdAt).toBeInstanceOf(Date);
    expect(records[0].task.updatedAt).toBeInstanceOf(Date);
    expect(records[0].task.finishedAt).toBeInstanceOf(Date);
    expect(records[0].task.sessions[0].createdAt).toBeInstanceOf(Date);
  });

  it('returns an empty page for a missing archive dir', async () => {
    const dir = await makeArchiveDir();
    const result = await readArchivedTasks(dir);
    expect(result.records).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  // Acceptance (#2765): records older than the 7-day snapshot window remain
  // retrievable — they are the whole reason the archive exists.
  it('retains records older than the 7-day snapshot window', async () => {
    const dir = await makeArchiveDir();
    const beyondSnapshot = makeTerminalTask('ancient', new Date(NOW - 30 * DAY));
    await archiveTerminalTasks(dir, [beyondSnapshot], { now: () => NOW - 30 * DAY });

    const { records } = await readArchivedTasks(dir);
    expect(records.map((r) => r.task.id)).toEqual(['ancient']);
  });
});

describe('idempotency', () => {
  it('does not surface duplicates when the same task is re-archived (crash retry)', async () => {
    const dir = await makeArchiveDir();
    const task = makeTerminalTask('dup', new Date(NOW - DAY));
    await archiveTerminalTasks(dir, [task], { now: () => NOW });
    await archiveTerminalTasks(dir, [task], { now: () => NOW + 1000 });

    // Physically two lines...
    expect(await countArchivedTasks(dir)).toBe(2);
    // ...but the read path collapses them to one, keeping the newest archivedAt.
    const { records } = await readArchivedTasks(dir);
    expect(records).toHaveLength(1);
    expect(records[0].task.id).toBe('dup');
    expect(records[0].archivedAt).toBe(new Date(NOW + 1000).toISOString());
  });
});

describe('corruption handling', () => {
  it('skips malformed lines and reports the skip count', async () => {
    const dir = await makeArchiveDir();
    const task = makeTerminalTask('ok', new Date(NOW - DAY));
    await archiveTerminalTasks(dir, [task], { now: () => NOW });
    // Append junk lines exercising several parseRecordLine reject branches:
    // non-JSON, missing lastActivityMs/task, a non-object task, and a task
    // object with no string id (the most realistic schema-drift corruption).
    await appendFile(
      join(dir, '202609.jsonl'),
      [
        'not json',
        '{"archivedAt":"x"}',
        '{"archivedAt":"x","lastActivityMs":1,"task":"nope"}',
        '{"archivedAt":"x","lastActivityMs":1,"task":{}}',
      ].join('\n') + '\n',
      'utf-8',
    );

    const { records, skippedLines } = await readArchivedTasks(dir);
    expect(records.map((r) => r.task.id)).toEqual(['ok']);
    expect(skippedLines).toBe(4);
  });

  // Correctness-review guard: a valid-JSON record with a string id but no
  // sessions array must not crash downstream consumers — it is returned with an
  // empty sessions list so the route's normalizeTaskForApi never throws.
  it('normalizes a sessions-less record to an empty sessions array', async () => {
    const dir = await makeArchiveDir();
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, '202609.jsonl'),
      `${JSON.stringify({
        archivedAt: new Date(NOW).toISOString(),
        lastActivityMs: NOW - DAY,
        task: { id: 'no-sessions', status: 'completed', createdAt: new Date(NOW - DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString() },
      })}\n`,
      'utf-8',
    );

    const { records } = await readArchivedTasks(dir);
    expect(records.map((r) => r.task.id)).toEqual(['no-sessions']);
    expect(Array.isArray(records[0].task.sessions)).toBe(true);
    expect(records[0].task.sessions).toEqual([]);
  });

  // Correctness-review guard: a terminal record missing its date fields must not
  // yield an Invalid Date (which would make a downstream `.toISOString()`, e.g.
  // projectTerminalReceipt, throw and 500 the read). Dates are coerced to valid
  // ones (required → lastActivityMs fallback; optional → dropped).
  it('coerces missing/garbage dates to valid Dates on read', async () => {
    const dir = await makeArchiveDir();
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, '202609.jsonl'),
      `${JSON.stringify({
        archivedAt: new Date(NOW).toISOString(),
        lastActivityMs: NOW - DAY,
        task: { id: 'dateless', status: 'completed', finishedAt: 'not-a-date' },
      })}\n`,
      'utf-8',
    );

    const { records } = await readArchivedTasks(dir);
    expect(records.map((r) => r.task.id)).toEqual(['dateless']);
    const t = records[0].task;
    expect(Number.isFinite(t.createdAt.getTime())).toBe(true);
    expect(Number.isFinite(t.updatedAt.getTime())).toBe(true);
    // Required dates fall back to lastActivityMs; the garbage finishedAt is dropped.
    expect(t.updatedAt.getTime()).toBe(NOW - DAY);
    expect(t.finishedAt).toBeUndefined();
    // The value must survive a JSON round-trip and a toISOString() with no throw.
    expect(() => t.updatedAt.toISOString()).not.toThrow();
  });
});

describe('compactTaskArchive', () => {
  it('deletes segments past retention but keeps within-retention and current months', async () => {
    const dir = await makeArchiveDir();
    await mkdir(dir, { recursive: true });
    // A segment well past retention (must die).
    await appendFile(
      join(dir, '202601.jsonl'), // Jan 2026 — > 90 days before mid-Sep 2026
      `${JSON.stringify({ archivedAt: '2026-01-15T00:00:00Z', lastActivityMs: new Date('2026-01-15').getTime(), task: { id: 'jan' } })}\n`,
      'utf-8',
    );
    // A non-current segment INSIDE the retention horizon (must survive) — guards
    // against a horizon comparison that is too aggressive. Aug 2026 ends Sep 1,
    // which is after the ~Jun horizon, so it is retained.
    await appendFile(
      join(dir, '202608.jsonl'),
      `${JSON.stringify({ archivedAt: '2026-08-16T00:00:00Z', lastActivityMs: new Date('2026-08-16').getTime(), task: { id: 'aug' } })}\n`,
      'utf-8',
    );
    const current = makeTerminalTask('sept', new Date(NOW - DAY));
    await archiveTerminalTasks(dir, [current], { now: () => NOW });

    const result = await compactTaskArchive(dir, { now: () => NOW });
    expect(result.removedSegments).toEqual(['202601.jsonl']);
    expect(result.removedRecords).toBe(1);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(['202608.jsonl', '202609.jsonl']);
    const { records } = await readArchivedTasks(dir);
    expect(records.map((r) => r.task.id).sort()).toEqual(['aug', 'sept']);
  });

  it('collapses duplicate task ids in a retained segment', async () => {
    const dir = await makeArchiveDir();
    const task = makeTerminalTask('dup', new Date(NOW - DAY));
    await archiveTerminalTasks(dir, [task], { now: () => NOW });
    await archiveTerminalTasks(dir, [task], { now: () => NOW + 1000 });
    expect(await countArchivedTasks(dir)).toBe(2);

    const result = await compactTaskArchive(dir, { now: () => NOW });
    expect(result.compactedSegments).toEqual(['202609.jsonl']);
    expect(result.removedRecords).toBe(1);
    expect(await countArchivedTasks(dir)).toBe(1);
    // The surviving copy is the newest archivedAt (NOW + 1000), not the older one.
    const { records } = await readArchivedTasks(dir);
    expect(records[0].archivedAt).toBe(new Date(NOW + 1000).toISOString());
  });

  it('is a no-op on an already-compact archive', async () => {
    const dir = await makeArchiveDir();
    const task = makeTerminalTask('solo', new Date(NOW - DAY));
    await archiveTerminalTasks(dir, [task], { now: () => NOW });

    const result = await compactTaskArchive(dir, { now: () => NOW });
    expect(result.removedSegments).toEqual([]);
    expect(result.compactedSegments).toEqual([]);
    expect(result.removedRecords).toBe(0);
  });

  it('is a no-op on a missing archive dir', async () => {
    const dir = await makeArchiveDir();
    const result = await compactTaskArchive(dir, { now: () => NOW });
    expect(result.removedRecords).toBe(0);
  });

  it('uses the documented default retention when none is given', async () => {
    const dir = await makeArchiveDir();
    await mkdir(dir, { recursive: true });
    // A segment far past the default retention horizon is deleted.
    const farOld = new Date(NOW - (DEFAULT_TASK_ARCHIVE_RETENTION_DAYS + 40) * DAY);
    const stamp = `${farOld.getFullYear()}${String(farOld.getMonth() + 1).padStart(2, '0')}`;
    await appendFile(
      join(dir, `${stamp}.jsonl`),
      `${JSON.stringify({ archivedAt: farOld.toISOString(), lastActivityMs: farOld.getTime(), task: { id: 'x' } })}\n`,
      'utf-8',
    );

    const result = await compactTaskArchive(dir, { now: () => NOW });
    expect(result.removedSegments).toEqual([`${stamp}.jsonl`]);
  });
});
