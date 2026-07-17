import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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
