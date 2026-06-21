#!/usr/bin/env node
/**
 * Hook-event JSONL replay harness (issue #701).
 *
 * Feeds a recorded hook-event JSONL file — a captured real session or a crafted
 * fixture — into a running dev instance so a developer can deterministically
 * reproduce a specific detector firing without spinning up a real agent and
 * recreating conditions by hand.
 *
 * It reuses the same batch-framing seam the HTTP route uses:
 * `splitHookRequestBody` parses JSONL / concatenated records, and the
 * `POST /api/hook-event/:sessionId` ingestion endpoint pushes each record.
 * Every record is pushed against a dedicated *synthetic* session id whose name
 * starts with `kookr-replay-`; ingestion derives `origin: 'replay'` from that
 * prefix, so replayed records are tagged replay-not-live and are scoped to a
 * session that can never collide with a live agent's state. See KB lessons
 * `distinguish-replayed-events-from-fresh-events` and
 * `scope-replay-streams-by-negotiated-epochs`.
 *
 * Usage:
 *   node --import tsx scripts/replay-hooks.ts <hooks.jsonl> [options]
 *
 * Options:
 *   --session <id>     Target Kookr session id. Forced into a synthetic
 *                      `kookr-replay-` session (prefix prepended if missing).
 *                      Default: derived from the file name.
 *   --base-url <url>   Target instance base URL. Default: KOOKR_API_BASE_URL,
 *                      else http://127.0.0.1:$KOOKR_PORT, else probe 4800/4801.
 *   --delay-ms <n>     Fixed delay between records (default 0).
 *   --limit <n>        Replay only the first N records.
 *   --dry-run          Parse + classify records and print a summary; do NOT POST.
 *   -h, --help         Show this help.
 *
 * Examples:
 *   node --import tsx scripts/replay-hooks.ts ~/.kookr/hooks/kookr-task-abc.jsonl
 *   node --import tsx scripts/replay-hooks.ts fixture.jsonl --session repro-660 --delay-ms 50
 *   node --import tsx scripts/replay-hooks.ts fixture.jsonl --dry-run
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitHookRequestBody } from '../src/server/hook-record-framing.js';
import { REPLAY_SESSION_PREFIX } from '../src/server/hook-ingestion.js';
import { parseHookEvent, HookParseError } from '../src/core/hook-parser.js';

const PORTS_TO_TRY = [4800, 4801];

interface Options {
  file: string;
  session?: string;
  baseUrl?: string;
  delayMs: number;
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options | { help: true } {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const opts: Options = { file: '', delayMs: 0, dryRun: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--session': opts.session = argv[++i]; break;
      case '--base-url': opts.baseUrl = argv[++i]; break;
      case '--delay-ms': opts.delayMs = parseNonNegativeInt(argv[++i], '--delay-ms'); break;
      case '--limit': opts.limit = parseNonNegativeInt(argv[++i], '--limit'); break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        positionals.push(arg);
    }
  }
  if (positionals.length !== 1) {
    throw new Error('Expected exactly one JSONL file argument. See --help.');
  }
  opts.file = positionals[0];
  return opts;
}

function parseNonNegativeInt(raw: string | undefined, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} expects a non-negative integer (got: ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * Force the id into a dedicated synthetic replay session (KB epoch scoping).
 * The result is capped at 128 chars so it always satisfies the server's
 * `/^[A-Za-z0-9_-]{1,128}$/` session-id guard (diagnostics-routes.ts).
 */
function toReplaySessionId(raw: string | undefined, file: string): string {
  if (raw && raw.startsWith(REPLAY_SESSION_PREFIX)) return raw.slice(0, 128);
  const budget = 128 - REPLAY_SESSION_PREFIX.length;
  const stem = ((raw ?? basename(file).replace(/\.jsonl$/i, ''))
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'session').slice(0, budget);
  return `${REPLAY_SESSION_PREFIX}${stem}`;
}

async function healthy(base: string, timeoutMs = 500): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Mirror kookr-spawn / kookr-status discovery: KOOKR_API_BASE_URL, then
 *  KOOKR_PORT, then probe the default ports. */
async function resolveBaseUrl(explicit: string | undefined, env = process.env): Promise<string> {
  if (explicit) return explicit.replace(/\/$/, '');
  if (env.KOOKR_API_BASE_URL) return env.KOOKR_API_BASE_URL.replace(/\/$/, '');
  if (env.KOOKR_PORT) {
    const port = Number(env.KOOKR_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`KOOKR_PORT must be an integer between 1 and 65535 (got: ${JSON.stringify(env.KOOKR_PORT)})`);
    }
    return `http://127.0.0.1:${port}`;
  }
  for (const port of PORTS_TO_TRY) {
    const base = `http://127.0.0.1:${port}`;
    if (await healthy(base)) return base;
  }
  throw new Error(
    `No running Kookr instance found on ports ${PORTS_TO_TRY.join(', ')}. ` +
    'Start one with `pnpm dev`, or set KOOKR_API_BASE_URL / KOOKR_PORT.',
  );
}

/** Classify a record for the dry-run summary, never throwing on bad input. */
function classify(record: string): 'parsed' | 'unknown' | 'malformed' {
  try {
    return parseHookEvent(record) ? 'parsed' : 'unknown';
  } catch (err) {
    return err instanceof HookParseError ? 'malformed' : 'unknown';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function splitReplayRecords(content: string): string[] {
  return splitHookRequestBody(content).filter((record) => record.trim());
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    printHelp();
    return 0;
  }
  const opts = parsed;

  const content = await readFile(opts.file, 'utf-8');
  let records = splitReplayRecords(content);
  if (opts.limit !== undefined) records = records.slice(0, opts.limit);

  const sessionId = toReplaySessionId(opts.session, opts.file);

  if (records.length === 0) {
    console.error(`No hook records found in ${opts.file}.`);
    return 1;
  }

  if (opts.dryRun) {
    const tally = { parsed: 0, unknown: 0, malformed: 0 };
    for (const record of records) tally[classify(record)] += 1;
    console.log(`Dry run — ${records.length} record(s) in ${opts.file}`);
    console.log(`  would replay into session: ${sessionId} (origin=replay)`);
    console.log(`  parsed=${tally.parsed} unknown=${tally.unknown} malformed=${tally.malformed}`);
    return 0;
  }

  const base = await resolveBaseUrl(opts.baseUrl);
  console.log(`Replaying ${records.length} record(s) from ${opts.file}`);
  console.log(`  -> ${base}/api/hook-event/${sessionId} (origin=replay)`);

  let dispatched = 0;
  let deduped = 0;
  let failed = 0;
  for (let i = 0; i < records.length; i += 1) {
    if (i > 0 && opts.delayMs > 0) await sleep(opts.delayMs);
    try {
      const res = await fetch(`${base}/api/hook-event/${sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: records[i],
      });
      if (!res.ok) {
        failed += 1;
        console.error(`  record ${i + 1}: HTTP ${res.status} ${res.statusText}`);
        continue;
      }
      const json = (await res.json()) as { dispatched?: boolean };
      if (json.dispatched) dispatched += 1;
      else deduped += 1;
    } catch (err) {
      failed += 1;
      console.error(`  record ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Done. dispatched=${dispatched} deduped=${deduped} failed=${failed}`);
  return failed > 0 ? 1 : 0;
}

function printHelp(): void {
  console.log(
    [
      'Usage: node --import tsx scripts/replay-hooks.ts <hooks.jsonl> [options]',
      '',
      'Replay a recorded hook-event JSONL file into a running Kookr dev instance',
      'to reproduce detector behavior. Records are pushed against a synthetic',
      `\`${REPLAY_SESSION_PREFIX}\` session and tagged origin=replay.`,
      '',
      'Options:',
      '  --session <id>    Target session id (forced into a kookr-replay- session)',
      '  --base-url <url>  Target instance (default: env discovery / probe 4800,4801)',
      '  --delay-ms <n>    Fixed delay between records (default 0)',
      '  --limit <n>       Replay only the first N records',
      '  --dry-run         Parse + classify records and print a summary; do not POST',
      '  -h, --help        Show this help',
    ].join('\n'),
  );
}

// Only run when invoked directly (so the module can be imported in tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}

export { parseArgs, toReplaySessionId, resolveBaseUrl, classify, splitReplayRecords };
