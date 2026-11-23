/**
 * `kookr idea` — the idea store (issue #4250).
 *
 * Agents record simplification ideas here: something that should be deleted,
 * merged, shortened, split or made to fail loudly. The store is agent-notebook
 * in a folder of its own (`~/.kookr/ideas`, never mixed with the lesson
 * notebooks in `~/.kookr/notebooks`), with a longer line cap so an idea can
 * carry its target, the problem, the change and what must keep working.
 *
 * Organisation: one shelf per (category, repository), named
 * `<category>@<repo-slug>`. Categories are a closed list of simplifications;
 * there is deliberately no "feature" category. Separate shelves keep a busy
 * category from evicting a rare one, and `show` reads all of a repository's
 * shelves at once, so a duplicate filed under another category is still seen.
 *
 * Rules the command enforces (prose alone was not followed, see #4250):
 *   - `add` needs a known category, `->` and `(keeps: ...)`.
 *   - Agents write their idea before seeing the store, so each add is an
 *     independent sighting. `add` then looks for a similar idea in the
 *     repository (same target, or close wording) and, if it finds one, records
 *     nothing and asks the agent to vote for it, or to re-run with `--new`.
 *     Showing a list first would turn votes into recognition of whatever is
 *     listed (lesson votes run about 1,075 up to 7 down).
 *   - Inside a task (NB_SESSION set), one new idea per task. Re-adding an
 *     identical line votes for it (agent-notebook alone skips it without a vote).
 *   - `vote +1` needs `--because`, the thing in this task that hit the problem.
 *     It goes to a side log (`.votes.tsv`) so the curator can tell sightings from
 *     reflex agreement.
 *
 * Which tasks support an idea is not stored in the idea text (that would make
 * every line unique). agent-notebook's usage log records NB_SESSION, which Kookr
 * sets to the task id, for every add and vote.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Longer than a lesson (200): an idea holds a target, a problem, a change and a keeps clause. */
export const IDEA_MAX_CHARS = 400;
/** Lines per shelf; a full shelf evicts its lowest score to admit a new idea. */
export const IDEA_MAX_LINES = 50;
/** `show` prints this many ideas unless `--top` says otherwise. */
export const DEFAULT_TOP = 30;
/** The separator every idea must contain: `<problem> -> <change>`. */
export const IDEA_ARROW = '->';
/** Every idea names what must keep working after the change. */
export const KEEPS_MARKER = '(keeps:';
/** Task markers (`.added-*`) older than this are pruned. */
const MARKER_TTL_MS = 7 * 86_400_000;
/** Trigram similarity at or above which an existing idea counts as similar. */
export const SIMILAR_THRESHOLD = 0.4;

/**
 * The closed category list, in tie-break order: pick by what the change after
 * `->` does, and when two fit, take the first one listed.
 */
export const IDEA_CATEGORIES = [
  ['guidance', 'a skill, doc, CLAUDE.md rule, comment or --help text is wrong, stale or redundant -> correct, shorten or delete it'],
  ['dead', 'code, a flag, file, script or config that nothing uses -> delete it'],
  ['duplicate', 'the same logic, rule or data lives in two or more places -> merge it into one'],
  ['overbuilt', 'an abstraction, indirection, option or layer more complex than the job -> inline or collapse it'],
  ['tangled', 'a module or function with mixed responsibilities, or code in the wrong layer -> split or move it'],
  ['unused', 'a feature, command, option or UI element that works but is rarely used or confusing -> remove or unify it'],
  ['fragile', 'a swallowed error, silent fallback, fail-open check, race, missing timeout or wrong result -> make it fail loudly and simply'],
  ['tests', 'a test that is tautological, duplicated, flaky, slow or tied to implementation details -> delete, merge or rewrite it'],
] as const;

export type IdeaCategory = (typeof IDEA_CATEGORIES)[number][0];
const CATEGORY_NAMES: readonly string[] = IDEA_CATEGORIES.map(([name]) => name);

export function categoryList(indent = '  '): string {
  const width = Math.max(...CATEGORY_NAMES.map((n) => n.length));
  return IDEA_CATEGORIES.map(([name, def]) => `${indent}${name.padEnd(width)}  ${def}`).join('\n');
}

const USAGE = `kookr idea — simplification ideas, voted by the agents that hit them (#4250).

Usage:
  kookr idea show [--grep TEXT] [--category C] [--top N] [--repo SLUG] [--json]
  kookr idea add  --category C "<file or command>: <problem> -> <change> (keeps: <behaviour>)" [--new] [--repo SLUG]
  kookr idea vote <id> +1 --because "<what in this task hit it>"   |   kookr idea vote <id> -1
  kookr idea rm   <id> --reason obsolete|wrong|other [--note TEXT] [--repo SLUG]
  kookr idea list | path | doctor | stats

An idea is a change that removes, merges, shortens, splits or hardens something
that exists. A new feature is not an idea, and neither is a fact the next agent
should remember (that is a notebook lesson).

Procedure:
  1. Write the idea from what this task hit, naming the file or command first,
     and run kookr idea add. Do not browse the store first.
  2. If add answers that a similar idea exists and it is the same problem:
     kookr idea vote <id> +1 --because "<what in this task hit it>". Otherwise
     re-run the same add with --new.
  3. One new idea per task. Nothing to record is the usual case.

Categories (pick by what the change after -> does; if two fit, the first listed):
${categoryList()}

Example of the shape (do not submit it):
  "src/x/legacy-sync.ts: imported nowhere since the queue rewrite -> delete it and its test (keeps: sync through src/x/queue.ts)"

Options:
  --repo SLUG     Repository the change belongs to (default: $KOOKR_REPO_SLUG).
  --category C    add: required. show: only this category.
  --grep TEXT     show: only ideas containing TEXT (case-insensitive), all categories.
  --top N         show: how many ideas to print (default: ${DEFAULT_TOP}).
  --because TEXT  vote +1: required; what in this task hit the problem.
  --new           add: record it even though a similar idea exists.
  --json          show, list, doctor, stats: machine-readable output.

The store lives in $KOOKR_IDEAS_DIR (default: ~/.kookr/ideas), one agent-notebook
shelf per category and repository (<category>@<repo>), at most ${IDEA_MAX_LINES} ideas of
${IDEA_MAX_CHARS} characters each. Lesson notebooks are not touched.
`;

export interface NbResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type RunNb = (args: string[], env: NodeJS.ProcessEnv) => NbResult;

export interface IdeaCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  runNb?: RunNb;
  /** Path to Kookr's `bin/nb.js`; `bin/kookr.js` passes its own sibling. */
  nbBin?: string;
  homeDir?: string;
  now?: () => Date;
}

/** The ideas folder: `$KOOKR_IDEAS_DIR`, or `~/.kookr/ideas`. */
export function ideasDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const fromEnv = env.KOOKR_IDEAS_DIR?.trim();
  if (fromEnv) {
    if (fromEnv === '~') return home;
    if (fromEnv.startsWith('~/')) return join(home, fromEnv.slice(2));
    return fromEnv;
  }
  return join(home, '.kookr', 'ideas');
}

/** The environment every `nb` call of this command runs with. */
export function ideaNbEnv(env: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv {
  return {
    ...env,
    NB_DIR: ideasDir(env, home),
    NB_MAX_CHARS: String(IDEA_MAX_CHARS),
    NB_MAX_LINES: String(IDEA_MAX_LINES),
  };
}

// Both src/cli/*.ts (vitest) and dist/cli/*.js (compiled) sit two levels below the
// repository root, the same anchoring as src/core/hook-writer-paths.ts.
const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/** Kookr's `bin/nb.js`, which honours NB_DIR and commits when the folder is a git repo. */
export function defaultNbBin(baseDir: string = moduleDir): string {
  return resolve(baseDir, '..', '..', 'bin', 'nb.js');
}

/** Runs `bin/nb.js` with the given arguments and environment. */
export function makeRunNb(nbBin: string = defaultNbBin()): RunNb {
  return (args, env) => {
    const res = spawnSync(process.execPath, [nbBin, ...args], { env, encoding: 'utf8' });
    return {
      status: res.status ?? 1,
      stdout: res.stdout ?? '',
      stderr: res.stderr || (res.error ? String(res.error) : ''),
    };
  };
}

interface ParsedArgs {
  positional: string[];
  repo?: string;
  category?: string;
  grep?: string;
  because?: string;
  top?: number;
  json: boolean;
  isNew: boolean;
  help: boolean;
  passthrough: string[];
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], json: false, help: false, isNew: false, passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const named = (name: string) => arg === name || arg.startsWith(`${name}=`);
    const takeValue = (name: string): string | undefined => {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      const value = argv[i + 1];
      i += 1;
      return value;
    };
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--new') {
      parsed.isNew = true;
    } else if (named('--top')) {
      const value = Number(takeValue('--top'));
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive whole number';
      else parsed.top = value;
    } else if (named('--repo') || named('--shelf') || named('--category') || named('--grep') || named('--because')) {
      const name = arg.split('=')[0];
      const value = takeValue(name);
      if (!value || !value.trim()) {
        parsed.error = `${name} needs a value`;
      } else if (name === '--repo' || name === '--shelf') {
        parsed.repo = value.trim();
      } else if (name === '--category') {
        parsed.category = value.trim();
      } else if (name === '--grep') {
        parsed.grep = value;
      } else {
        parsed.because = value.trim();
      }
    } else if (named('--reason') || named('--note')) {
      const name = arg.startsWith('--reason') ? '--reason' : '--note';
      const value = takeValue(name);
      if (value === undefined) parsed.error = `${name} needs a value`;
      else parsed.passthrough.push(name, value);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

export interface IdeaEntry {
  id: string;
  score: number;
  text: string;
  category: string;
  shelf: string;
}

function formatScore(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}

function shelfFor(category: string, repo: string): string {
  return `${category}@${repo}`;
}

/** The idea's target: the text before the first ": " that comes before "->" (the file or command it names). */
export function ideaTarget(text: string): string {
  const cut = text.indexOf(': ');
  const arrow = text.indexOf(IDEA_ARROW);
  return cut > 0 && (arrow < 0 || cut < arrow) ? text.slice(0, cut).trim().toLowerCase() : '';
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const set = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
  return set;
}

function normal(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Character-trigram Jaccard similarity, the same measure agent-notebook uses for its near-duplicate advisory. */
export function ideaSimilarity(a: string, b: string): number {
  const ta = trigrams(normal(a));
  const tb = trigrams(normal(b));
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** Existing ideas that look like the same problem: same target, or close wording. */
export function similarIdeas(text: string, ideas: IdeaEntry[]): IdeaEntry[] {
  const target = ideaTarget(text);
  return ideas.filter(
    (e) => (target !== '' && ideaTarget(e.text) === target) || ideaSimilarity(text, e.text) >= SIMILAR_THRESHOLD,
  );
}

function sessionTag(session: string): string {
  return session.replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function runIdeaCli(argv: string[], io: IdeaCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const runNb = io.runNb ?? makeRunNb(io.nbBin);
  const now = io.now ?? (() => new Date());
  const dir = ideasDir(env, io.homeDir);
  const nbEnv = ideaNbEnv(env, io.homeDir);
  const session = env.NB_SESSION?.trim() ? sessionTag(env.NB_SESSION.trim()) : '';

  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    out.log(USAGE);
    return sub ? 0 : 2;
  }

  const args = parseArgs(rest);
  if (args.help) {
    out.log(USAGE);
    return 0;
  }
  if (args.error) {
    err.error(`kookr idea: ${args.error}`);
    return 2;
  }

  const passOutput = (res: NbResult): number => {
    if (res.stdout.trim()) out.log(res.stdout.replace(/\n$/, ''));
    if (res.stderr.trim()) err.error(res.stderr.replace(/\n$/, ''));
    return res.status;
  };

  // Commands that work on the whole store, not one repository.
  if (sub === 'list' || sub === 'path' || sub === 'doctor' || sub === 'stats') {
    const nbArgs = [sub, ...args.positional, ...(args.json ? ['--json'] : [])];
    if (sub === 'list') nbArgs.push('--limit', '1000');
    return passOutput(runNb(nbArgs, nbEnv));
  }

  const repo = args.repo ?? env.KOOKR_REPO_SLUG?.trim();
  if (!repo) {
    err.error('kookr idea: no repository. Pass --repo <owner-repo>, or run inside a Kookr task (it sets KOOKR_REPO_SLUG).');
    return 2;
  }

  const badCategory = (category: string | undefined): boolean => {
    if (category && CATEGORY_NAMES.includes(category)) return false;
    err.error(
      `kookr idea: Nothing recorded. --category must be one of (pick by what the change after -> does; if two fit, the first listed):\n${categoryList()}`,
    );
    return true;
  };

  /** Every idea of this repository, across category shelves, best score first. */
  const readIdeas = (): IdeaEntry[] | { error: NbResult } => {
    const shelves = CATEGORY_NAMES.map((c) => shelfFor(c, repo));
    const res = runNb(['show', ...shelves, '--json'], nbEnv);
    if (res.status !== 0) return { error: res };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { error: { status: 1, stdout: '', stderr: 'kookr idea: could not read the idea shelves (nb show --json returned something else).' } };
    }
    const groups = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ shelf?: string; entries?: Array<{ id: string; score: number; text: string }> }>;
    const ideas: IdeaEntry[] = [];
    for (const group of groups) {
      const shelf = group.shelf ?? '';
      const category = shelf.split('@')[0];
      for (const e of group.entries ?? []) ideas.push({ id: e.id, score: e.score, text: e.text, category, shelf });
    }
    return ideas.sort((a, b) => b.score - a.score);
  };

  const markerPath = (kind: 'added') => join(dir, `.${kind}-${session}`);
  const writeMarker = (kind: 'added') => {
    if (!session) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(markerPath(kind), now().toISOString());
      const cutoff = now().getTime() - MARKER_TTL_MS;
      for (const f of readdirSync(dir)) {
        if (!f.startsWith('.added-')) continue;
        try {
          if (statSync(join(dir, f)).mtimeMs < cutoff) unlinkSync(join(dir, f));
        } catch {
          /* a marker we cannot stat or remove is skipped */
        }
      }
    } catch {
      /* markers are best-effort: a store we cannot write fails at the nb call */
    }
  };

  const printIdeas = (ideas: IdeaEntry[], heading: string, top: number) => {
    if (ideas.length === 0) {
      out.log(`${heading}: none recorded.`);
      return;
    }
    const shown = ideas.slice(0, top);
    out.log(`${heading}: ${shown.length} of ${ideas.length}, best score first`);
    for (const e of shown) out.log(`${e.id}  [${formatScore(e.score)}]  ${e.category.padEnd(9)}  ${e.text}`);
    if (ideas.length > shown.length) out.log(`# ${ideas.length - shown.length} more: narrow with --grep <file or command> or --category <c>`);
  };

  const showFooter = () =>
    out.log(
      '# vote only for a problem this task hit: kookr idea vote <id> +1 --because "<what hit it>". Categories and procedure: kookr idea --help',
    );

  switch (sub) {
    case 'show': {
      if (args.category && badCategory(args.category)) return 2;
      const ideas = readIdeas();
      if (!Array.isArray(ideas)) return passOutput(ideas.error);
      const needle = args.grep?.toLowerCase();
      const filtered = ideas.filter(
        (e) => (!args.category || e.category === args.category) && (!needle || e.text.toLowerCase().includes(needle)),
      );
      const top = args.top ?? DEFAULT_TOP;
      if (args.json) {
        out.log(JSON.stringify({ repo, total: filtered.length, entries: filtered.slice(0, top) }));
        return 0;
      }
      const scope = [args.category, args.grep ? `matching "${args.grep}"` : ''].filter(Boolean).join(' ');
      printIdeas(filtered, `Ideas for ${repo}${scope ? ` (${scope})` : ''}`, top);
      showFooter();
      return 0;
    }

    case 'add': {
      if (badCategory(args.category)) return 2;
      const category = args.category as string;
      const text = args.positional.join(' ').trim();
      if (!text.includes(IDEA_ARROW) || !text.includes(KEEPS_MARKER)) {
        err.error(
          `kookr idea add: Nothing recorded. Shape the idea as "<file or command>: <problem> ${IDEA_ARROW} <change> ${KEEPS_MARKER} <behaviour that must keep working>)".`,
        );
        return 2;
      }
      if (session && existsSync(markerPath('added'))) {
        err.error('kookr idea add: Nothing recorded. This task already added an idea; one per task.');
        return 3;
      }
      if (!args.isNew) {
        const ideas = readIdeas();
        if (!Array.isArray(ideas)) return passOutput(ideas.error);
        const similar = similarIdeas(text, ideas).filter((e) => e.text !== text);
        if (similar.length > 0) {
          printIdeas(similar, `Similar ideas already recorded for ${repo}`, 5);
          err.error(
            'kookr idea add: Nothing recorded yet. If one of these is the same problem, vote for it: ' +
              'kookr idea vote <id> +1 --because "<what in this task hit it>". If none is, re-run the same add with --new.',
          );
          return 3;
        }
      }
      const shelf = shelfFor(category, repo);
      const res = runNb(['add', shelf, text, '--json'], nbEnv);
      if (res.status !== 0) return passOutput(res);
      let result: { added?: boolean; reason?: string; id?: string; collidedId?: string; evicted?: string | null };
      try {
        result = JSON.parse(res.stdout);
      } catch {
        return passOutput(res);
      }
      if (result.reason === 'duplicate' && result.collidedId) {
        const vote = runNb(['vote', shelf, result.collidedId, '+1'], nbEnv);
        if (vote.status !== 0) return passOutput(vote);
        logVote(dir, now(), session, shelf, result.collidedId, '+1', 'identical idea added again');
        out.log(`Already recorded as ${result.collidedId} on ${shelf}; voted +1 for it.`);
        return 0;
      }
      if (!result.added) return passOutput(res);
      writeMarker('added');
      out.log(result.id ? `Recorded idea ${result.id} on ${shelf}.` : `Recorded the idea on ${shelf}.`);
      if (result.evicted) out.log(`(The shelf was full, so its lowest-scored idea was evicted: ${result.evicted})`);
      return 0;
    }

    case 'vote': {
      const [ids, direction] = args.positional;
      if (!ids || (direction !== '+1' && direction !== '-1')) {
        err.error('kookr idea vote: give an id and +1 or -1.');
        return 2;
      }
      if (direction === '+1' && !args.because) {
        err.error(
          'kookr idea vote: Nothing recorded. A +1 needs --because "<what in this task hit the problem>". ' +
            'Vote only for a problem this task hit, not for an idea you merely agree with.',
        );
        return 2;
      }
      const ideas = readIdeas();
      if (!Array.isArray(ideas)) return passOutput(ideas.error);
      for (const id of ids.split(',').map((s) => s.trim()).filter(Boolean)) {
        const match = ideas.filter((e) => e.id.startsWith(id));
        if (match.length !== 1) {
          err.error(`kookr idea vote: ${match.length === 0 ? 'no idea' : 'more than one idea'} matches "${id}" in ${repo}. Run kookr idea show.`);
          return 2;
        }
        const res = runNb(['vote', match[0].shelf, match[0].id, direction], nbEnv);
        if (res.status !== 0) return passOutput(res);
        logVote(dir, now(), session, match[0].shelf, match[0].id, direction, args.because ?? '');
        out.log(res.stdout.replace(/\n$/, ''));
      }
      return 0;
    }

    case 'rm': {
      const [id] = args.positional;
      if (!id) {
        err.error('kookr idea rm: give an id.');
        return 2;
      }
      const ideas = readIdeas();
      if (!Array.isArray(ideas)) return passOutput(ideas.error);
      const match = ideas.filter((e) => e.id.startsWith(id));
      if (match.length !== 1) {
        err.error(`kookr idea rm: ${match.length === 0 ? 'no idea' : 'more than one idea'} matches "${id}" in ${repo}.`);
        return 2;
      }
      return passOutput(runNb(['rm', match[0].shelf, match[0].id, ...args.passthrough], nbEnv));
    }

    default:
      err.error(`kookr idea: unknown command "${sub}". Run \`kookr idea --help\`.`);
      return 2;
  }
}

/**
 * Append one vote to `.votes.tsv` (ts, session, shelf, id, direction, because).
 * The curator counts a task's support from this log, so votes without a reason
 * (reflex agreement) can be told apart from sightings.
 */
function logVote(dir: string, at: Date, session: string, shelf: string, id: string, direction: string, because: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();
    appendFileSync(join(dir, '.votes.tsv'), [at.toISOString(), session, shelf, id, direction, clean(because)].join('\t') + '\n');
  } catch {
    /* the vote itself is on the shelf; the side log is best-effort */
  }
}
