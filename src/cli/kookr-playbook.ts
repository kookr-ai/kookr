/**
 * `kookr playbook` — read-only terminal view of the playbook catalog
 * (issue #3126). Every other CLI subsystem (`schedule`, `issue`, `emission`,
 * `queue-feeder`) has a terminal `list` verb; this brings the same
 * CLI/dashboard parity to playbooks so a terminal-first user or a script can
 * discover which playbooks are installed at project, user, or plugin scope
 * without opening the dashboard launch dialog.
 *
 *   kookr playbook list [--json]
 *
 * Discovery reads the local filesystem directly (project / user / plugin
 * tiers) via `discoverPlaybooks`, so no running server is required. Strictly
 * read-only: there is no `run` / `launch` subverb here.
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import {
  discoverPlaybooks,
  findPlaybookTierShadows,
  type PlaybookTierShadow,
} from '../core/playbook-discovery.js';
import { playbookScopeDir } from '../core/playbook-paths.js';
import type { Playbook, PlaybookScope } from '../core/playbook.js';
import { resolveKookrDataDir } from './kookr-maintenance.js';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
/** Discovery failed to read the filesystem (rare: EACCES, TOCTOU). */
export const EXIT_DISCOVERY_ERROR = 1;

const PLAYBOOK_HELP_TEXT = `kookr playbook — inspect the playbook catalog.

Usage:
  kookr playbook list [--json]

list  Print available playbooks (name · scope · description) resolved from the
      project (\`<cwd>/.kookr/playbooks\`), user (\`~/.kookr/playbooks\`), and
      plugin tiers. Read-only. When the same file name exists in more than
      one tier, the line ends with the other tiers, and says so when their
      contents differ. A launch from this directory runs the highest tier's
      copy (project > user > plugin). An enabled schedule runs the tier it is
      pinned to (playbook.scope), or the project tier of its own cwd when it
      has no pin; the note names the copy each such schedule runs, and calls
      a copy ignored only when nothing runs it.

Options:
  --json       Print one machine-readable JSON envelope to stdout.
  -h, --help   Show this help.

Exit codes:
  0  Success.
  1  Discovery failed to read the playbook directories.
  2  User error (bad flags / unknown verb).
`;

// ── Which tier copy each schedule runs (issue #4228) ─────────────────────────
//
// A launch from a directory runs the highest tier's copy of a playbook
// (project > user > plugin). A schedule does not: it resolves exactly one tier,
// `playbook.scope ?? 'project'`, inside `playbook.sourceCwd ?? cwd`, with no
// fallback (see ScheduleValidator.resolveLaunch and preparePlaybookLaunch). So a
// schedule pinned to `user` runs the user copy even where a project copy
// exists, and an unpinned schedule runs the project copy of its own checkout.
// `kookr doctor` and `kookr playbook list` use these helpers so neither calls a
// copy "ignored" while an enabled schedule runs it.

/** The fields of an enabled schedule that decide which playbook file it runs. */
export interface TierCheckSchedule {
  id: string;
  name: string;
  /** `playbook.path` as stored: a file name inside the tier directory. */
  playbookPath: string;
  /** `playbook.scope` when the schedule pins a tier; absent means project. */
  pinnedScope?: string;
  /** `playbook.sourceCwd ?? cwd`: the checkout whose project tier it reads. */
  playbookCwd: string;
}

/** Enabled schedules, or why they could not be read. */
export type TierCheckSchedules =
  | { ok: true; schedules: TierCheckSchedule[] }
  | { ok: false; error: string };

/** One enabled schedule that runs a playbook id with copies in several tiers. */
export interface ScheduleCopyRun {
  scheduleId: string;
  name: string;
  /** Tier the schedule reads: its pin, or `project` when it has none. */
  scope: string;
  pinned: boolean;
  /** File the schedule runs; absent when that tier has no directory. */
  filePath?: string;
  /**
   * Tier of the reported copy this file is, or absent when it is none of them
   * (an unpinned schedule whose cwd is another checkout runs that checkout's
   * project copy, which this report did not compare).
   */
  copyScope?: PlaybookScope;
}

/**
 * Read the enabled, unarchived schedules from `<dataDir>/schedules.json`
 * without a server and without loading the schedule store (which also
 * reconciles rollup files). A missing file means no schedules. Pass the
 * server's own data dir, `resolveKookrDataDir(env)` (`~/.kookr`, or
 * `~/.kookr-<port>`): the server ignores `KOOKR_DIR`.
 */
export async function readEnabledSchedules(dataDir: string): Promise<TierCheckSchedules> {
  const filePath = join(dataDir, 'schedules.json');
  let data: unknown;
  try {
    data = JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { ok: true, schedules: [] };
    return { ok: false, error: `${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(data)) return { ok: false, error: `${filePath}: not a JSON array` };
  const schedules: TierCheckSchedule[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      id?: unknown; name?: unknown; enabled?: unknown; archived?: unknown; cwd?: unknown;
      playbook?: { path?: unknown; scope?: unknown; sourceCwd?: unknown };
    };
    // Same defaults as the schedule store: `enabled` absent means enabled.
    if (entry.enabled === false || entry.archived === true) continue;
    if (typeof entry.id !== 'string' || typeof entry.cwd !== 'string') continue;
    if (typeof entry.playbook?.path !== 'string') continue;
    schedules.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : 'Unnamed schedule',
      playbookPath: entry.playbook.path,
      ...(typeof entry.playbook.scope === 'string' ? { pinnedScope: entry.playbook.scope } : {}),
      playbookCwd: typeof entry.playbook.sourceCwd === 'string' ? entry.playbook.sourceCwd : entry.cwd,
    });
  }
  return { ok: true, schedules };
}

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The enabled schedules that run `shadow.id`, and which file each one runs. */
export function scheduleRunsForShadow(
  shadow: PlaybookTierShadow,
  schedules: TierCheckSchedule[],
): ScheduleCopyRun[] {
  const runs: ScheduleCopyRun[] = [];
  for (const schedule of schedules) {
    if (normalize(schedule.playbookPath) !== shadow.id) continue;
    const scope = schedule.pinnedScope ?? 'project';
    const dir = playbookScopeDir(scope as PlaybookScope, schedule.playbookCwd);
    const filePath = dir === undefined ? undefined : join(dir, schedule.playbookPath);
    const copy = filePath === undefined
      ? undefined
      : shadow.copies.find((candidate) => samePath(candidate.filePath, filePath));
    runs.push({
      scheduleId: schedule.id,
      name: schedule.name,
      scope,
      pinned: schedule.pinnedScope !== undefined,
      ...(filePath !== undefined ? { filePath } : {}),
      ...(copy ? { copyScope: copy.scope } : {}),
    });
  }
  return runs;
}

function quotedScheduleNames(runs: ScheduleCopyRun[]): string {
  const names = runs.map((run) => `"${run.name}"`).join(', ');
  return `${runs.length === 1 ? 'schedule' : 'schedules'} ${names}`;
}

/**
 * Say which copy runs and which is ignored, tier by tier, e.g.
 * `project runs; user ignored` with no schedules, or
 * `project runs only for launches from this directory; user runs for schedule "Feeder"`.
 * `runs` is `undefined` when the schedules could not be read: then no copy is
 * called ignored, because a schedule may run it.
 */
export function describeTierCopies(
  shadow: PlaybookTierShadow,
  runs: ScheduleCopyRun[] | undefined,
): string {
  const anyRun = (runs ?? []).length > 0;
  return shadow.copies.map((copy, index) => {
    const runners = (runs ?? []).filter((run) => run.copyScope === copy.scope);
    if (index === 0) {
      if (runners.length > 0) return `${copy.scope} runs for launches from this directory and ${quotedScheduleNames(runners)}`;
      return anyRun || runs === undefined
        ? `${copy.scope} runs only for launches from this directory`
        : `${copy.scope} runs`;
    }
    if (runners.length > 0) return `${copy.scope} runs for ${quotedScheduleNames(runners)}`;
    return runs === undefined ? `${copy.scope} not run from this directory` : `${copy.scope} ignored`;
  }).join('; ');
}

/** One line per schedule run: which copy, and why (its pin or its cwd). */
export function describeScheduleRun(run: ScheduleCopyRun): string {
  const why = run.pinned ? `pinned to ${run.scope}` : 'no pin, so the project tier of its cwd';
  const what = run.copyScope !== undefined
    ? `the ${run.copyScope} copy`
    : run.filePath !== undefined
      ? `${run.filePath} (not one of the copies compared here)`
      : `nothing (no ${run.scope} tier directory)`;
  return `schedule "${run.name}" (${run.scheduleId}) runs ${what}: ${why}`;
}

/** Projected list row — a lean view of a Playbook (drops body/parameters). */
interface PlaybookListRow {
  id: string;
  name: string;
  scope: PlaybookScope;
  description: string;
  /**
   * Every tier holding a file with this id, highest precedence first, so
   * `tiers[0]` is `scope` (issue #4142). One entry when no other tier has it.
   */
  tiers: PlaybookScope[];
  /** True when another tier's copy has different content from the one that runs. */
  tierContentDiffers: boolean;
  /**
   * Enabled schedules that run this id while its copies differ, and the copy
   * each runs (issue #4228). Present only when non-empty.
   */
  scheduleRuns?: ScheduleCopyRun[];
}

export interface PlaybookCliIo {
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  /** Working directory whose project tier is scanned. Defaults to process.cwd(). */
  cwd?: string;
  /** Override discovery (tests). Defaults to the filesystem `discoverPlaybooks`. */
  discover?: (cwd: string) => Promise<Playbook[]>;
  /**
   * Override the cross-tier comparison (tests). Defaults to the filesystem
   * `findPlaybookTierShadows`, except when `discover` is injected: then it
   * defaults to "no other copies", so an injected catalog never mixes with
   * the files on the host.
   */
  findTierShadows?: (cwd: string) => Promise<PlaybookTierShadow[]>;
  /**
   * Override the enabled-schedule read (tests). Defaults to
   * `<data dir>/schedules.json`, except when `discover` is injected: then no
   * schedules, so an injected catalog never mixes with the host's schedules.
   */
  readSchedules?: () => Promise<TierCheckSchedules>;
}

interface ResolvedIo {
  out: { log: (...args: unknown[]) => void };
  err: { error: (...args: unknown[]) => void };
  cwd: string;
  discover: (cwd: string) => Promise<Playbook[]>;
  findTierShadows: (cwd: string) => Promise<PlaybookTierShadow[]>;
  readSchedules: () => Promise<TierCheckSchedules>;
}

interface ParsedPlaybookArgs {
  verb: 'list' | null;
  json: boolean;
  help: boolean;
  error?: string;
}

function parsePlaybookArgs(argv: string[]): ParsedPlaybookArgs {
  // Detect --json up front (position-independent) so an error return still emits
  // the machine-readable envelope even when the bad token precedes --json — e.g.
  // `playbook list --nope --json`. Mirrors `kookr schedule`'s argv.includes check.
  const out: ParsedPlaybookArgs = { verb: null, json: argv.includes('--json'), help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      // already captured above
    } else if (tok.startsWith('-')) {
      return { ...out, error: `unknown option: ${tok}` };
    } else if (out.verb === null) {
      if (tok !== 'list') {
        return { ...out, error: `unknown verb: ${tok}` };
      }
      out.verb = 'list';
    } else {
      return { ...out, error: `unexpected argument: ${tok}` };
    }
  }
  return out;
}

function toRow(
  playbook: Playbook,
  shadow: PlaybookTierShadow | undefined,
  schedules: TierCheckSchedules,
): { row: PlaybookListRow; copiesNote?: string } {
  const tiers = shadow ? shadow.copies.map((copy) => copy.scope) : [playbook.scope];
  const row: PlaybookListRow = {
    id: playbook.id,
    name: playbook.name,
    scope: playbook.scope,
    description: playbook.description,
    tiers,
    tierContentDiffers: shadow?.contentDiffers ?? false,
  };
  if (!shadow?.contentDiffers) return { row };
  const runs = schedules.ok ? scheduleRunsForShadow(shadow, schedules.schedules) : undefined;
  if (runs && runs.length > 0) row.scheduleRuns = runs;
  return { row, copiesNote: describeTierCopies(shadow, runs) };
}

function formatPlaybookLine(row: PlaybookListRow, copiesNote: string | undefined): string {
  const description = row.description.trim() || '(no description)';
  const line = `${row.name} · ${row.scope} · ${description}`;
  const others = row.tiers.filter((tier) => tier !== row.scope);
  if (others.length === 0) return line;
  const state = row.tierContentDiffers ? `different content; ${copiesNote}` : 'identical';
  return `${line} · also in ${others.join(', ')} (${state})`;
}

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

export async function runPlaybookCli(argv: string[], io: PlaybookCliIo = {}): Promise<number> {
  const resolved: ResolvedIo = {
    out: io.out ?? console,
    err: io.err ?? console,
    cwd: io.cwd ?? process.cwd(),
    discover: io.discover ?? ((cwd: string) => discoverPlaybooks(cwd)),
    findTierShadows: io.findTierShadows
      ?? (io.discover ? async () => [] : (cwd: string) => findPlaybookTierShadows(cwd)),
    readSchedules: io.readSchedules
      ?? (io.discover
        ? async () => ({ ok: true, schedules: [] })
        : () => readEnabledSchedules(resolveKookrDataDir(process.env))),
  };

  const args = parsePlaybookArgs(argv);
  if (args.help) {
    // In --json mode, help travels inside the envelope too (message "Help",
    // details.help), matching the dispatcher's subcommand-help contract that
    // `kookr status --json --help` establishes and kookr.test.ts asserts.
    if (args.json) {
      emitJson(resolved.out, {
        ok: true,
        code: 'OK',
        message: 'Help',
        details: { help: PLAYBOOK_HELP_TEXT, subcommand: 'playbook' },
      });
    } else {
      resolved.out.log(PLAYBOOK_HELP_TEXT);
    }
    return EXIT_OK;
  }
  if (args.error) {
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message: args.error,
        details: { subcommand: 'playbook' },
      });
    } else {
      resolved.err.error(`kookr playbook: ${args.error}`);
      resolved.err.error('Run `kookr playbook --help` for usage.');
    }
    return EXIT_USER_ERROR;
  }
  if (args.verb === null) {
    const message = 'a verb is required (e.g. `kookr playbook list`).';
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'playbook' },
      });
    } else {
      resolved.err.error(`kookr playbook: ${message}`);
      resolved.err.error(PLAYBOOK_HELP_TEXT);
    }
    return EXIT_USER_ERROR;
  }

  // Discovery reads the filesystem, so it can reject on a non-parse error
  // (EACCES, or a file removed between readdir and stat). Keep the failure
  // inside the envelope contract the other list commands honor rather than
  // letting it escape to the dispatcher's plain-text top-level catch.
  let playbooks: Playbook[];
  let shadows: PlaybookTierShadow[];
  let schedules: TierCheckSchedules;
  try {
    [playbooks, shadows, schedules] = await Promise.all([
      resolved.discover(resolved.cwd),
      resolved.findTierShadows(resolved.cwd),
      // A schedule read never fails the list: the note just names no schedule.
      resolved.readSchedules().catch((err: unknown): TierCheckSchedules => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `failed to read playbook directories: ${detail}`;
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'DISCOVERY_ERROR',
        message,
        details: { subcommand: 'playbook' },
      });
    } else {
      resolved.err.error(`kookr playbook: ${message}`);
    }
    return EXIT_DISCOVERY_ERROR;
  }

  const shadowById = new Map(shadows.map((shadow) => [shadow.id, shadow]));
  const listed = playbooks.map((playbook) => toRow(playbook, shadowById.get(playbook.id), schedules));
  const rows = listed.map((entry) => entry.row);

  if (args.json) {
    emitJson(resolved.out, {
      ok: true,
      code: 'OK',
      message: `${rows.length} playbook(s).`,
      details: { playbooks: rows },
    });
    return EXIT_OK;
  }

  if (rows.length === 0) {
    resolved.out.log('No playbooks found.');
    return EXIT_OK;
  }
  for (const entry of listed) resolved.out.log(formatPlaybookLine(entry.row, entry.copiesNote));
  return EXIT_OK;
}
