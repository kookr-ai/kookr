/**
 * `kookr lesson` — operator CLI for the durable lesson-write spool (#1519).
 *
 *   kookr lesson status [--json] [--dir PATH]
 *   kookr lesson drain  [--json] [--dir PATH] [--dry-run]
 *   kookr lesson remember --title=… [--kb=agent-task-lessons] [--stdin] [--yes]
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendLessonWrite,
  applyDegradationProbe,
  buildLessonEntry,
  defaultSpoolDir,
  drainLessonSpool,
  readPendingLessons,
  readSpoolState,
  writeSpoolState,
  type DrainLessonResult,
  type LessonSpoolState,
} from '../core/lesson-write-spool.js';
import { createKbRememberWriteFn } from '../core/lesson-write-runner.js';

const USAGE = `kookr lesson — durable lesson-write spool (issue #1519).

Usage:
  kookr lesson status   [--json] [--dir PATH]
  kookr lesson drain    [--json] [--dir PATH] [--dry-run]
  kookr lesson remember --title=<title> [--kb=agent-task-lessons] --stdin --yes

status   Show pending spool entries and degradation streak state.
drain    Replay pending lessons via \`kb remember\` (idempotent).
remember Write a lesson now; on KB failure, append to the spool.

Options:
  --dir PATH   Spool directory (default: ~/.kookr/playbook-state/lesson-write-spool).
  --json       Machine-readable output.
  --dry-run    drain only: list what would be written without calling kb.
  -h, --help   Show this help.
`;

export interface LessonCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  stdin?: NodeJS.ReadableStream;
  now?: () => Date;
}

export async function runLessonCli(
  argv: string[],
  io: LessonCliIo = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const now = io.now ?? (() => new Date());

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    out.log(USAGE);
    return 0;
  }

  const verb = argv[0];
  const rest = argv.slice(1);

  if (verb === 'status') {
    return runStatus(rest, { env, out, err });
  }
  if (verb === 'drain') {
    return runDrain(rest, { env, out, err, now });
  }
  if (verb === 'remember') {
    return runRemember(rest, { env, out, err, stdin: io.stdin ?? process.stdin });
  }

  err.error(`[kookr lesson] Unknown verb: ${verb}`);
  err.error(USAGE);
  return 2;
}

async function runStatus(
  argv: string[],
  io: { env: NodeJS.ProcessEnv; out: { log: (...a: unknown[]) => void }; err: { error: (...a: unknown[]) => void } },
): Promise<number> {
  const { dir, json, error } = parseCommon(argv);
  if (error) {
    io.err.error(error);
    return 2;
  }
  const spoolDir = dir ?? defaultSpoolDir(io.env);
  const pending = await readPendingLessons(spoolDir);
  const state = await readSpoolState(spoolDir);
  const payload = {
    spoolDir,
    pendingCount: pending.length,
    pending: pending.map((e) => ({
      contentHash: e.contentHash,
      title: e.title,
      kb: e.kb,
      createdAt: e.createdAt,
      taskId: e.taskId,
      lastError: e.lastError,
    })),
    state,
  };
  if (json) {
    io.out.log(JSON.stringify(payload, null, 2));
  } else {
    io.out.log(`Spool: ${spoolDir}`);
    io.out.log(`Pending: ${pending.length}`);
    io.out.log(
      `KB probe: ${state.lastProbeStatus ?? 'unknown'}`
        + (state.kbDegradedSince ? ` (degraded since ${state.kbDegradedSince})` : ''),
    );
    if (state.alertFiredAt) io.out.log(`Alert fired at: ${state.alertFiredAt}`);
    for (const e of pending) {
      io.out.log(`  - ${e.createdAt} ${e.contentHash.slice(0, 12)}… ${e.title}`);
    }
  }
  return 0;
}

async function runDrain(
  argv: string[],
  io: {
    env: NodeJS.ProcessEnv;
    out: { log: (...a: unknown[]) => void };
    err: { error: (...a: unknown[]) => void };
    now: () => Date;
  },
): Promise<number> {
  const { dir, json, dryRun, error } = parseCommon(argv);
  if (error) {
    io.err.error(error);
    return 2;
  }
  const spoolDir = dir ?? defaultSpoolDir(io.env);
  if (dryRun) {
    const pending = await readPendingLessons(spoolDir);
    const payload = {
      dryRun: true,
      spoolDir,
      pendingCount: pending.length,
      titles: pending.map((e) => e.title),
    };
    if (json) io.out.log(JSON.stringify(payload, null, 2));
    else {
      io.out.log(`Would drain ${pending.length} lesson(s) from ${spoolDir}`);
      for (const t of payload.titles) io.out.log(`  - ${t}`);
    }
    return 0;
  }

  const result = await drainLessonSpool({
    spoolDir,
    write: createKbRememberWriteFn({ env: io.env }),
  });

  const state = await readSpoolState(spoolDir);
  const next: LessonSpoolState = {
    ...state,
    lastPendingCount: result.remaining,
    lastProbeAt: io.now().toISOString(),
  };
  await writeSpoolState(spoolDir, next);

  if (json) {
    io.out.log(JSON.stringify({ spoolDir, ...result }, null, 2));
  } else {
    io.out.log(
      `Drain: attempted=${result.attempted} written=${result.written} `
        + `failed=${result.failed} remaining=${result.remaining}`,
    );
  }
  return result.failed > 0 ? 1 : 0;
}

async function runRemember(
  argv: string[],
  io: {
    env: NodeJS.ProcessEnv;
    out: { log: (...a: unknown[]) => void };
    err: { error: (...a: unknown[]) => void };
    stdin: NodeJS.ReadableStream;
  },
): Promise<number> {
  let title: string | undefined;
  let kb = 'agent-task-lessons';
  let stdinFlag = false;
  let yes = false;
  let dir: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--stdin') stdinFlag = true;
    else if (arg === '--yes') yes = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('--title=')) title = arg.slice('--title='.length);
    else if (arg === '--title') title = argv[++i];
    else if (arg.startsWith('--kb=')) kb = arg.slice(5);
    else if (arg === '--kb') kb = argv[++i] ?? kb;
    else if (arg === '--dir') dir = argv[++i];
    else if (arg.startsWith('--dir=')) dir = arg.slice(6);
    else if (arg === '-h' || arg === '--help') {
      io.out.log(USAGE);
      return 0;
    } else {
      io.err.error(`[kookr lesson remember] Unknown arg: ${arg}`);
      return 2;
    }
  }

  if (!title || !stdinFlag || !yes) {
    io.err.error('[kookr lesson remember] requires --title=… --stdin --yes');
    return 2;
  }

  const body = await readStream(io.stdin);
  if (!body.trim()) {
    io.err.error('[kookr lesson remember] empty stdin body');
    return 2;
  }

  const write = createKbRememberWriteFn({ env: io.env });
  const attempt = await write({ kb, title, body });
  if (attempt.ok) {
    if (json) io.out.log(JSON.stringify({ ok: true, spooled: false, title, kb }));
    else io.out.log(`Wrote lesson "${title}" to kb=${kb}`);
    return 0;
  }

  const spoolDir = dir ?? defaultSpoolDir(io.env);
  const entry = buildLessonEntry({
    kb,
    title,
    body,
    taskId: io.env.KOOKR_TASK_ID,
    source: 'kookr-lesson',
    lastError: attempt.error,
  });
  const appended = await appendLessonWrite(spoolDir, entry);
  if (json) {
    io.out.log(JSON.stringify({
      ok: true,
      spooled: true,
      reason: appended.reason,
      contentHash: entry.contentHash,
      path: appended.path,
    }));
  } else {
    io.out.log(
      `KB write failed; lesson ${appended.reason} to spool `
        + `(${entry.contentHash.slice(0, 12)}…) at ${appended.path}`,
    );
  }
  return 0;
}

function parseCommon(argv: string[]): {
  dir?: string;
  json: boolean;
  dryRun: boolean;
  error?: string;
} {
  let dir: string | undefined;
  let json = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--dir') dir = argv[++i];
    else if (arg.startsWith('--dir=')) dir = arg.slice(6);
    else if (arg === '-h' || arg === '--help') return { json, dryRun, error: USAGE };
    else return { json, dryRun, error: `Unknown arg: ${arg}` };
  }
  return { dir, json, dryRun };
}

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    stream.setEncoding('utf8');
    stream.on('data', (c: string) => chunks.push(c));
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', reject);
  });
}

/** Resolve default spool dir for tests that need HOME isolation. */
export function resolveDefaultSpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOME) return join(env.HOME, '.kookr', 'playbook-state', 'lesson-write-spool');
  return defaultSpoolDir(env);
}

// Re-export applyDegradationProbe for server wiring convenience.
export { applyDegradationProbe, type DrainLessonResult, type LessonSpoolState };
void homedir;
