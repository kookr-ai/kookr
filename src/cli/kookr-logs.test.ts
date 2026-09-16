import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import Database from 'better-sqlite3';

import { parseLogsArgs, runLogsCli } from './kookr-logs.js';

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (msg?: unknown) => logs.push(String(msg ?? '')) },
    err: { error: (msg?: unknown) => errors.push(String(msg ?? '')) },
    logs,
    errors,
  };
}

const record = (fields: Record<string, unknown>): string => JSON.stringify(fields);

describe('parseLogsArgs', () => {
  test('defaults: 20 lines, human output', () => {
    expect(parseLogsArgs(['task-1'])).toEqual({ taskId: 'task-1', lines: 20, json: false });
  });

  test('-h / --help short-circuits', () => {
    expect(parseLogsArgs(['--help']).help).toBe(true);
    expect(parseLogsArgs(['-h', 'task-1']).help).toBe(true);
  });

  test('-n / --lines set the tail size', () => {
    expect(parseLogsArgs(['task-1', '-n', '5']).lines).toBe(5);
    expect(parseLogsArgs(['task-1', '--lines', '100']).lines).toBe(100);
  });

  test('--json and --dir', () => {
    const opts = parseLogsArgs(['--json', '--dir', '/tmp/x', 'task-1']);
    expect(opts.json).toBe(true);
    expect(opts.dir).toBe('/tmp/x');
    expect(opts.taskId).toBe('task-1');
  });

  test('rejects a non-positive / non-integer --lines', () => {
    expect(parseLogsArgs(['task-1', '-n', '0']).error).toMatch(/positive integer/);
    expect(parseLogsArgs(['task-1', '-n', 'abc']).error).toMatch(/positive integer/);
    expect(parseLogsArgs(['task-1', '-n', '-3']).error).toMatch(/positive integer/);
  });

  test('rejects unknown option and missing/extra positionals', () => {
    expect(parseLogsArgs(['task-1', '--nope']).error).toMatch(/Unknown option/);
    expect(parseLogsArgs([]).error).toMatch(/Expected a <taskId>/);
    expect(parseLogsArgs(['a', 'b']).error).toMatch(/exactly one <taskId>/);
  });
});

describe('runLogsCli', () => {
  let dataDir: string;
  const env = { HOME: '/unused', KOOKR_PORT: '' } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kookr-logs-'));
    await mkdir(join(dataDir, 'hooks'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeTasks(tasks: unknown[]): Promise<void> {
    await writeFile(join(dataDir, 'tasks.json'), JSON.stringify({ version: 2, tasks }), 'utf8');
  }

  async function writeHooks(stem: string, records: string[]): Promise<void> {
    await writeFile(join(dataDir, 'hooks', `${stem}.jsonl`), records.map((r) => `${r}\n`).join(''), 'utf8');
  }

  test('help prints usage and returns 0', async () => {
    const c = captureConsole();
    const code = await runLogsCli(['--help'], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/kookr logs/);
  });

  test('usage error returns 2', async () => {
    const c = captureConsole();
    const code = await runLogsCli(['--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/Expected a <taskId>/);
  });

  test('resolves a task id to its session hook log and tails the last N records', async () => {
    await writeTasks([{ id: 'task-A', sessions: [{ tmuxSession: 'kookr-aaaa' }] }]);
    await writeHooks('kookr-aaaa', [
      record({ hook_event_name: 'SessionStart' }),
      record({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      record({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
      record({ hook_event_name: 'Stop' }),
    ]);

    const c = captureConsole();
    const code = await runLogsCli(['task-A', '-n', '2', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const output = c.logs.join('\n');
    expect(output).toMatch(/4 hook record\(s\).*showing last 2/);
    expect(output).toContain('PostToolUse (Bash)');
    expect(output).toContain('Stop');
    // Older records outside the tail window are not shown.
    expect(output).not.toContain('SessionStart');
  });

  test('reads rotated hook generations oldest-first so history is not lost (#1433)', async () => {
    await writeTasks([{ id: 'task-rot', sessions: [{ tmuxSession: 'kookr-rot' }] }]);
    // Oldest history lives in the highest-numbered generation; the active base
    // file holds the newest records. `kookr logs` must stitch them together in
    // chronological order (`.2` → `.1` → base), not read the base alone.
    await writeFile(join(dataDir, 'hooks', 'kookr-rot.jsonl.2'), `${record({ hook_event_name: 'SessionStart' })}\n`, 'utf8');
    await writeFile(join(dataDir, 'hooks', 'kookr-rot.jsonl.1'), `${record({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })}\n`, 'utf8');
    await writeHooks('kookr-rot', [record({ hook_event_name: 'Stop' })]);

    const c = captureConsole();
    const code = await runLogsCli(['task-rot', '--json', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const envelope = JSON.parse(c.logs[0]) as {
      totalRecords: number;
      records: Array<{ event: Record<string, unknown> }>;
    };
    // All three generations are read, oldest-first.
    expect(envelope.totalRecords).toBe(3);
    expect(envelope.records.map((r) => r.event.hook_event_name)).toEqual([
      'SessionStart',
      'PreToolUse',
      'Stop',
    ]);
  });

  test('--json emits an envelope and redacts secrets in payloads', async () => {
    await writeTasks([{ id: 'task-B', sessions: [{ tmuxSession: 'kookr-bbbb' }] }]);
    const secret = 'ghp_0123456789abcdefghij';
    await writeHooks('kookr-bbbb', [
      record({ hook_event_name: 'Stop', last_assistant_message: `my key is ${secret}` }),
    ]);

    const c = captureConsole();
    const code = await runLogsCli(['task-B', '--json', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const envelope = JSON.parse(c.logs[0]) as {
      taskId: string;
      hookLogs: string[];
      totalRecords: number;
      records: Array<{ session: string; event: Record<string, unknown> }>;
    };
    expect(envelope.taskId).toBe('task-B');
    expect(envelope.hookLogs).toEqual(['kookr-bbbb']);
    expect(envelope.totalRecords).toBe(1);
    expect(envelope.records[0].session).toBe('kookr-bbbb');
    expect(envelope.records[0].event.hook_event_name).toBe('Stop');
    // Secret scrubbed on the read path; raw token never reaches the output.
    expect(c.logs[0]).not.toContain(secret);
    expect(String(envelope.records[0].event.last_assistant_message)).toContain('[REDACTED]');
  });

  test('redacting a minified record does not corrupt it into an unparseable event', async () => {
    // The key-value credential pattern (`token=<value>`) would eat structural
    // JSON chars if applied to raw text; deep-redacting the parsed object keeps
    // the record valid so it still shows as a normal event.
    await writeTasks([{ id: 'task-D', sessions: [{ tmuxSession: 'kookr-dddd' }] }]);
    await writeHooks('kookr-dddd', [
      record({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'deploy --token=abc123def456ghij', flag: true }, cwd: '/x' }),
    ]);

    const cJson = captureConsole();
    expect(await runLogsCli(['task-D', '--json', '--dir', dataDir], { env, out: cJson.out, err: cJson.err })).toBe(0);
    const envelope = JSON.parse(cJson.logs[0]) as { records: Array<{ event: Record<string, unknown> }> };
    const event = envelope.records[0].event;
    expect(event.malformed).toBeUndefined();
    expect(event.hook_event_name).toBe('PreToolUse');
    // Structure preserved past the redacted field.
    expect(event.cwd).toBe('/x');
    expect(String((event.tool_input as Record<string, unknown>).command)).toContain('[REDACTED]');
    expect(cJson.logs[0]).not.toContain('abc123def456ghij');

    const cHuman = captureConsole();
    await runLogsCli(['task-D', '--dir', dataDir], { env, out: cHuman.out, err: cHuman.err });
    expect(cHuman.logs.join('\n')).toContain('PreToolUse (Bash)');
    expect(cHuman.logs.join('\n')).not.toContain('<unparseable');
  });

  test('merges records across multiple sessions in session order, tagging each', async () => {
    await writeTasks([
      { id: 'task-C', sessions: [{ tmuxSession: 'kookr-c1' }, { tmuxSession: 'kookr-c2' }] },
    ]);
    await writeHooks('kookr-c1', [record({ hook_event_name: 'SessionStart' })]);
    await writeHooks('kookr-c2', [record({ hook_event_name: 'Stop' })]);

    const c = captureConsole();
    const code = await runLogsCli(['task-C', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const output = c.logs.join('\n');
    expect(output).toContain('[kookr-c1] SessionStart');
    expect(output).toContain('[kookr-c2] Stop');
  });

  test('falls back to treating the argument as a direct session/hook-log id', async () => {
    await writeTasks([{ id: 'other-task', sessions: [{ tmuxSession: 'kookr-zzzz' }] }]);
    await writeHooks('kookr-direct', [record({ hook_event_name: 'PreToolUse', tool_name: 'Read' })]);

    const c = captureConsole();
    const code = await runLogsCli(['kookr-direct', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toContain('PreToolUse (Read)');
  });

  test('unknown id with no hook log returns 1', async () => {
    await writeTasks([]);
    const c = captureConsole();
    const code = await runLogsCli(['nope', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/No task or hook log found for 'nope'/);
  });

  test('known task with no recorded hook activity returns 0', async () => {
    await writeTasks([{ id: 'task-empty', sessions: [{ tmuxSession: 'kookr-empty' }] }]);
    const c = captureConsole();
    const code = await runLogsCli(['task-empty', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/No hook activity recorded/);
  });

  test('known task with no sessions returns 0 with a clear message', async () => {
    await writeTasks([{ id: 'task-nosess', sessions: [] }]);
    const c = captureConsole();
    const code = await runLogsCli(['task-nosess', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/no sessions with hook logs yet/);
  });
});

describe('runLogsCli — SQLite task store (#3214)', () => {
  let dataDir: string;
  // Default env leaves KOOKR_TASK_STORE unset, so the store defaults to SQLite.
  const env = { HOME: '/unused', KOOKR_PORT: '' } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kookr-logs-sqlite-'));
    await mkdir(join(dataDir, 'hooks'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * Build a minimal `tasks.sqlite` matching the columns the CLI's read-only
   * lookup touches (`id`, `data`). Uses WAL + a truncating checkpoint so the
   * fixture mirrors the production store's journal mode and the read-only
   * reader is exercised against a real WAL-mode database file.
   */
  function writeSqliteTasks(
    tasks: Array<{ id: string; sessions: Array<{ tmuxSession: string }> }>,
  ): void {
    const db = new Database(join(dataDir, 'tasks.sqlite'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO tasks (id, data) VALUES (?, ?)');
      for (const t of tasks) insert.run(t.id, JSON.stringify(t));
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }

  async function writeJsonTasks(tasks: unknown[]): Promise<void> {
    await writeFile(join(dataDir, 'tasks.json'), JSON.stringify({ version: 2, tasks }), 'utf8');
  }

  async function writeHooks(stem: string, records: string[]): Promise<void> {
    await writeFile(
      join(dataDir, 'hooks', `${stem}.jsonl`),
      records.map((r) => `${r}\n`).join(''),
      'utf8',
    );
  }

  test('resolves a SQLite-only task with multiple sessions and reads its hook records', async () => {
    // No tasks.json at all — the mapping lives solely in SQLite (acceptance #1).
    writeSqliteTasks([
      { id: 'task-sql', sessions: [{ tmuxSession: 'kookr-s1' }, { tmuxSession: 'kookr-s2' }] },
    ]);
    await writeHooks('kookr-s1', [record({ hook_event_name: 'SessionStart' })]);
    await writeHooks('kookr-s2', [record({ hook_event_name: 'Stop' })]);

    const c = captureConsole();
    const code = await runLogsCli(['task-sql', '--json', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const envelope = JSON.parse(c.logs[0]) as {
      hookLogs: string[];
      totalRecords: number;
      records: Array<{ session: string; event: Record<string, unknown> }>;
    };
    // Both sessions resolved from SQLite, in stored order (acceptance: order preserved).
    expect(envelope.hookLogs).toEqual(['kookr-s1', 'kookr-s2']);
    expect(envelope.totalRecords).toBe(2);
    expect(envelope.records.map((r) => r.session)).toEqual(['kookr-s1', 'kookr-s2']);
    expect(envelope.records.map((r) => r.event.hook_event_name)).toEqual(['SessionStart', 'Stop']);
  });

  test('resolves against a live WAL database with uncheckpointed frames', async () => {
    // Production runs `synchronous = NORMAL` and only checkpoints periodically,
    // so between checkpoints the latest task→session mapping lives in the `-wal`
    // sidecar, not yet merged into the main file. Keep a writer connection open
    // (no checkpoint) so `-wal`/`-shm` are live on disk, and prove the read-only
    // reader still resolves the pending mapping in order.
    const writer = new Database(join(dataDir, 'tasks.sqlite'));
    try {
      writer.pragma('journal_mode = WAL');
      writer.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      writer.prepare('INSERT INTO tasks (id, data) VALUES (?, ?)').run(
        'task-wal',
        JSON.stringify({
          id: 'task-wal',
          sessions: [{ tmuxSession: 'kookr-w1' }, { tmuxSession: 'kookr-w2' }],
        }),
      );
      await writeHooks('kookr-w1', [record({ hook_event_name: 'SessionStart' })]);
      await writeHooks('kookr-w2', [record({ hook_event_name: 'Stop' })]);

      const c = captureConsole();
      const code = await runLogsCli(['task-wal', '--json', '--dir', dataDir], { env, out: c.out, err: c.err });
      expect(code).toBe(0);
      const envelope = JSON.parse(c.logs[0]) as {
        hookLogs: string[];
        records: Array<{ event: Record<string, unknown> }>;
      };
      expect(envelope.hookLogs).toEqual(['kookr-w1', 'kookr-w2']);
      expect(envelope.records.map((r) => r.event.hook_event_name)).toEqual(['SessionStart', 'Stop']);
    } finally {
      writer.close();
    }
  });

  test('a stale tasks.json export does not override the current SQLite mapping', async () => {
    // SQLite maps the task to its live session; a stale JSON export points at a
    // different, older session. The stale session's hook file is present and
    // *would* resolve if JSON were consulted — so the test proves SQLite wins,
    // not merely that the stale path happened to dead-end (acceptance #2).
    writeSqliteTasks([{ id: 'task-x', sessions: [{ tmuxSession: 'kookr-current' }] }]);
    await writeJsonTasks([{ id: 'task-x', sessions: [{ tmuxSession: 'kookr-stale' }] }]);
    await writeHooks('kookr-current', [record({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })]);
    await writeHooks('kookr-stale', [record({ hook_event_name: 'SessionStart' })]);

    const c = captureConsole();
    const code = await runLogsCli(['task-x', '--json', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const envelope = JSON.parse(c.logs[0]) as {
      hookLogs: string[];
      records: Array<{ event: Record<string, unknown> }>;
    };
    // The live SQLite session wins; the stale JSON session is never consulted.
    expect(envelope.hookLogs).toEqual(['kookr-current']);
    expect(envelope.records.map((r) => r.event.hook_event_name)).toEqual(['PreToolUse']);
  });

  test('lookup reads only the requested task’s mapping', async () => {
    // Two tasks in the same store; only the requested one's sessions are read.
    writeSqliteTasks([
      { id: 'task-a', sessions: [{ tmuxSession: 'kookr-a' }] },
      { id: 'task-b', sessions: [{ tmuxSession: 'kookr-b' }] },
    ]);
    await writeHooks('kookr-a', [record({ hook_event_name: 'PreToolUse', tool_name: 'Read' })]);
    await writeHooks('kookr-b', [record({ hook_event_name: 'PreToolUse', tool_name: 'Write' })]);

    const c = captureConsole();
    const code = await runLogsCli(['task-a', '--json', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const envelope = JSON.parse(c.logs[0]) as { hookLogs: string[] };
    expect(envelope.hookLogs).toEqual(['kookr-a']);
    // The other task's session is not resolved or read.
    expect(c.logs[0]).not.toContain('kookr-b');
    expect(c.logs[0]).not.toContain('Write');
  });

  test('explicit KOOKR_TASK_STORE=json reads tasks.json even when tasks.sqlite exists', async () => {
    // Both stores present but disagree; explicit JSON mode uses tasks.json (acceptance #3).
    const jsonEnv = { ...env, KOOKR_TASK_STORE: 'json' } as NodeJS.ProcessEnv;
    writeSqliteTasks([{ id: 'task-j', sessions: [{ tmuxSession: 'kookr-sqlite' }] }]);
    await writeJsonTasks([{ id: 'task-j', sessions: [{ tmuxSession: 'kookr-json' }] }]);
    await writeHooks('kookr-json', [record({ hook_event_name: 'Stop' })]);

    const c = captureConsole();
    const code = await runLogsCli(['task-j', '--json', '--dir', dataDir], { env: jsonEnv, out: c.out, err: c.err });
    expect(code).toBe(0);
    const envelope = JSON.parse(c.logs[0]) as { hookLogs: string[] };
    expect(envelope.hookLogs).toEqual(['kookr-json']);
  });

  test('falls back to tasks.json when no tasks.sqlite is present', async () => {
    // Default (SQLite) mode, but the DB is absent — the legacy JSON snapshot is
    // still honored so existing single-store deployments keep working.
    await writeJsonTasks([{ id: 'task-legacy', sessions: [{ tmuxSession: 'kookr-legacy' }] }]);
    await writeHooks('kookr-legacy', [record({ hook_event_name: 'SessionStart' })]);

    const c = captureConsole();
    const code = await runLogsCli(['task-legacy', '--json', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    const envelope = JSON.parse(c.logs[0]) as { hookLogs: string[] };
    expect(envelope.hookLogs).toEqual(['kookr-legacy']);
  });

  test('a direct session id still resolves when SQLite has no matching task', async () => {
    writeSqliteTasks([{ id: 'other-task', sessions: [{ tmuxSession: 'kookr-other' }] }]);
    await writeHooks('kookr-direct', [record({ hook_event_name: 'PreToolUse', tool_name: 'Grep' })]);

    const c = captureConsole();
    const code = await runLogsCli(['kookr-direct', '--dir', dataDir], { env, out: c.out, err: c.err });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toContain('PreToolUse (Grep)');
  });

  test('a corrupt SQLite store gives a defined diagnostic outcome without masking it or mutating files', async () => {
    // A non-database file at the store path. The lookup must not silently fall
    // back to a (stale) tasks.json, and must not create/rename/checkpoint the DB
    // (acceptance #4 + risk: avoid masking DB failures with stale JSON).
    const corrupt = 'this is not a sqlite database';
    await writeFile(join(dataDir, 'tasks.sqlite'), corrupt, 'utf8');
    // A tasks.json that WOULD resolve — it must be ignored, not used to mask.
    await writeJsonTasks([{ id: 'task-c', sessions: [{ tmuxSession: 'kookr-json-c' }] }]);
    await writeHooks('kookr-json-c', [record({ hook_event_name: 'Stop' })]);

    const before = await readdir(dataDir);
    const c = captureConsole();
    const code = await runLogsCli(['task-c', '--dir', dataDir], { env, out: c.out, err: c.err });
    // No task resolved and no direct hook log named 'task-c' → exit 1 with a hint.
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/No task or hook log found for 'task-c'/);
    expect(c.errors.join('\n')).toMatch(/could not read tasks\.sqlite/);
    // The stale JSON mapping was never consulted.
    expect(c.logs.join('\n')).not.toContain('Stop');
    // The store file is untouched and no sidecar/backup files were created.
    expect(await readFile(join(dataDir, 'tasks.sqlite'), 'utf8')).toBe(corrupt);
    expect((await readdir(dataDir)).sort()).toEqual(before.sort());
  });
});
