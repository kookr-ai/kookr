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
 * A built-in *scenario catalog* (`src/__fixtures__/replay-scenarios.json`) maps
 * named, discoverable detector-development cases to a fixture, the detector path
 * they exercise, and the anomaly a developer should expect — so you can list and
 * replay them by name without hunting for fixture paths. See `--list-scenarios`
 * and `--scenario <name>`.
 *
 * Usage:
 *   node --import tsx scripts/replay-hooks.ts <hooks.jsonl> [options]
 *   node --import tsx scripts/replay-hooks.ts --scenario <name> [options]
 *   node --import tsx scripts/replay-hooks.ts --list-scenarios
 *
 * Options:
 *   --scenario <name>  Replay a named built-in scenario instead of a file.
 *   --list-scenarios   Print the built-in scenario catalog and exit.
 *   --session <id>     Target Kookr session id. Forced into a synthetic
 *                      `kookr-replay-` session (prefix prepended if missing).
 *                      Default: derived from the scenario / file name.
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
 *   node --import tsx scripts/replay-hooks.ts --list-scenarios
 *   node --import tsx scripts/replay-hooks.ts --scenario billing-stop --dry-run
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splitHookRequestBody } from '../src/server/hook-record-framing.js';
import { REPLAY_SESSION_PREFIX } from '../src/server/hook-ingestion.js';
import { parseHookEvent, HookParseError } from '../src/core/hook-parser.js';

const PORTS_TO_TRY = [4800, 4801];

/** Directory holding the built-in fixtures and the scenario manifest. */
const FIXTURES_DIR = new URL('../src/__fixtures__/', import.meta.url);
const SCENARIO_MANIFEST = new URL('replay-scenarios.json', FIXTURES_DIR);

/** One entry from the built-in hook-replay scenario catalog (issue #1043). */
interface Scenario {
  name: string;
  fixture: string;
  purpose: string;
  expected: string;
}

interface Options {
  file?: string;
  scenario?: string;
  listScenarios?: boolean;
  session?: string;
  baseUrl?: string;
  delayMs: number;
  dryRun: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Options | { help: true } {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const opts: Options = { delayMs: 0, dryRun: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--scenario': opts.scenario = takeValue(argv, ++i, '--scenario'); break;
      case '--list-scenarios': opts.listScenarios = true; break;
      case '--session': opts.session = takeValue(argv, ++i, '--session'); break;
      case '--base-url': opts.baseUrl = takeValue(argv, ++i, '--base-url'); break;
      case '--delay-ms': opts.delayMs = parseNonNegativeInt(argv[++i], '--delay-ms'); break;
      case '--limit': opts.limit = parseNonNegativeInt(argv[++i], '--limit'); break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        positionals.push(arg);
    }
  }
  if (opts.listScenarios) {
    if (positionals.length > 0 || opts.scenario !== undefined) {
      throw new Error('--list-scenarios takes no file argument and cannot combine with --scenario.');
    }
    return opts;
  }
  if (opts.scenario !== undefined) {
    if (positionals.length > 0) {
      throw new Error('Pass either a JSONL file or --scenario <name>, not both. See --help.');
    }
    return opts;
  }
  if (positionals.length !== 1) {
    throw new Error('Expected exactly one JSONL file argument, or --scenario <name> / --list-scenarios. See --help.');
  }
  opts.file = positionals[0];
  return opts;
}

/** Consume a flag's value, rejecting a missing value or a following flag
 *  (e.g. `--scenario --dry-run` should error, not swallow `--dry-run`). */
function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
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

/**
 * Validate the raw parsed manifest into a typed scenario list. Throws a
 * descriptive error on any structural problem so a broken catalog fails loudly
 * rather than silently resolving to the wrong fixture.
 */
function parseScenarioManifest(raw: unknown): Scenario[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { scenarios?: unknown }).scenarios)) {
    throw new Error('Scenario manifest must be an object with a "scenarios" array.');
  }
  const seen = new Set<string>();
  return (raw as { scenarios: unknown[] }).scenarios.map((entry, i) => {
    const where = `scenarios[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${where} must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of ['name', 'fixture', 'purpose', 'expected'] as const) {
      if (typeof e[key] !== 'string' || (e[key] as string).length === 0) {
        throw new Error(`${where}.${key} must be a non-empty string.`);
      }
    }
    const name = e.name as string;
    if (seen.has(name)) throw new Error(`Duplicate scenario name: ${name}`);
    seen.add(name);
    const fixture = e.fixture as string;
    // Must be a bare filename living next to the manifest — no path separators,
    // no `..`, no absolute/URL paths. This is what `scenarioFixturePath` relies
    // on to never resolve outside src/__fixtures__/.
    if (!/^[A-Za-z0-9._-]+$/.test(fixture)) {
      throw new Error(
        `${where}.fixture must be a bare filename in src/__fixtures__/ (got: ${JSON.stringify(fixture)}).`,
      );
    }
    return { name, fixture, purpose: e.purpose as string, expected: e.expected as string };
  });
}

/** Load and validate the built-in scenario catalog from the manifest. */
async function loadScenarios(manifestUrl: URL = SCENARIO_MANIFEST): Promise<Scenario[]> {
  const content = await readFile(manifestUrl, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Scenario manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseScenarioManifest(raw);
}

/** Resolve a scenario by name, or throw listing the available names. */
function resolveScenario(name: string, scenarios: Scenario[]): Scenario {
  const found = scenarios.find((s) => s.name === name);
  if (!found) {
    const names = scenarios.map((s) => s.name).join(', ');
    throw new Error(`Unknown scenario: ${name}. Available: ${names || '(none)'}. Run --list-scenarios.`);
  }
  return found;
}

/** Absolute filesystem path of a scenario's fixture (relative to the manifest). */
function scenarioFixturePath(scenario: Scenario, fixturesDir: URL = FIXTURES_DIR): string {
  return fileURLToPath(new URL(scenario.fixture, fixturesDir));
}

/** Render the catalog for `--list-scenarios`. */
function formatScenarioList(scenarios: Scenario[]): string {
  const lines = [`Built-in hook-replay scenarios (${scenarios.length}):`, ''];
  for (const s of scenarios) {
    lines.push(`  ${s.name}  (${s.fixture})`);
    lines.push(`    purpose:  ${s.purpose}`);
    lines.push(`    expected: ${s.expected}`);
    lines.push('');
  }
  lines.push('Replay one with:  node --import tsx scripts/replay-hooks.ts --scenario <name>');
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    printHelp();
    return 0;
  }
  const opts = parsed;

  if (opts.listScenarios) {
    console.log(formatScenarioList(await loadScenarios()));
    return 0;
  }

  let file = opts.file;
  let scenario: Scenario | undefined;
  if (opts.scenario !== undefined) {
    scenario = resolveScenario(opts.scenario, await loadScenarios());
    file = scenarioFixturePath(scenario);
  }
  // parseArgs guarantees a file is resolved unless we returned above.
  const resolvedFile = file as string;

  const content = await readFile(resolvedFile, 'utf-8');
  let records = splitReplayRecords(content);
  if (opts.limit !== undefined) records = records.slice(0, opts.limit);

  const sessionId = toReplaySessionId(opts.session ?? scenario?.name, resolvedFile);

  if (records.length === 0) {
    console.error(`No hook records found in ${resolvedFile}.`);
    return 1;
  }

  if (scenario) {
    console.log(`Scenario "${scenario.name}" — ${scenario.purpose}`);
    console.log(`  expected: ${scenario.expected}`);
  }

  if (opts.dryRun) {
    const tally = { parsed: 0, unknown: 0, malformed: 0 };
    for (const record of records) tally[classify(record)] += 1;
    console.log(`Dry run — ${records.length} record(s) in ${resolvedFile}`);
    console.log(`  would replay into session: ${sessionId} (origin=replay)`);
    console.log(`  parsed=${tally.parsed} unknown=${tally.unknown} malformed=${tally.malformed}`);
    return 0;
  }

  const base = await resolveBaseUrl(opts.baseUrl);
  console.log(`Replaying ${records.length} record(s) from ${resolvedFile}`);
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
      '       node --import tsx scripts/replay-hooks.ts --scenario <name> [options]',
      '       node --import tsx scripts/replay-hooks.ts --list-scenarios',
      '',
      'Replay a recorded hook-event JSONL file (or a named built-in scenario) into',
      'a running Kookr dev instance to reproduce detector behavior. Records are',
      `pushed against a synthetic \`${REPLAY_SESSION_PREFIX}\` session, tagged origin=replay.`,
      '',
      'Options:',
      '  --scenario <name> Replay a named built-in scenario (see --list-scenarios)',
      '  --list-scenarios  Print the built-in scenario catalog and exit',
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

export {
  parseArgs,
  toReplaySessionId,
  resolveBaseUrl,
  classify,
  splitReplayRecords,
  parseScenarioManifest,
  loadScenarios,
  resolveScenario,
  scenarioFixturePath,
  formatScenarioList,
};
export type { Scenario };
