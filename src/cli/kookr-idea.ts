/**
 * `kookr idea` — the idea store (issue #4250).
 *
 * Agents record improvement ideas here: a fix to a tool, a skill or doc that
 * told them something wrong, a missing check. The store is agent-notebook in a
 * folder of its own (`~/.kookr/ideas`, never mixed with the lesson notebooks in
 * `~/.kookr/notebooks`), with a longer line cap so an idea can carry both the
 * problem and the proposed change.
 *
 * Two things differ from plain `nb`:
 *   - The shelf defaults to the current repository (`$KOOKR_REPO_SLUG`).
 *   - Adding an idea that is already recorded votes for it instead of being
 *     skipped. The score then counts how many times agents hit the same thing,
 *     which is what the curator promotes on. agent-notebook itself skips an
 *     exact duplicate without voting.
 *
 * Which tasks added or voted for an idea is not stored in the idea text (that
 * would make every line unique and defeat the duplicate vote). agent-notebook's
 * usage log in the ideas folder records the session of every add and vote, and
 * Kookr sets `NB_SESSION` to the task id.
 */

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Longer than a lesson (200): an idea holds a problem and a proposed change. */
export const IDEA_MAX_CHARS = 400;
/** Lines per shelf; a full shelf evicts its lowest score to admit a new idea. */
export const IDEA_MAX_LINES = 50;
/** `show` prints this many ideas unless `--top` says otherwise. */
export const DEFAULT_TOP = 10;
/** The separator every idea must contain: `<problem> -> <proposed change>`. */
export const IDEA_ARROW = '->';

const USAGE = `kookr idea — improvement ideas, voted by the agents that hit them (#4250).

Usage:
  kookr idea show [--top N] [--shelf NAME] [--json]
  kookr idea add  "<problem> -> <proposed change>" [--shelf NAME]
  kookr idea vote <id[,id...]> +1|-1 [--shelf NAME]
  kookr idea rm   <id> --reason <code> [--note TEXT] [--shelf NAME]
  kookr idea list | path | doctor | stats

show   The best-scored ideas for this repository (default: top ${DEFAULT_TOP}).
add    Record an idea. If it is already recorded, vote +1 for it instead.
vote   +1 an idea you hit again, -1 one that is wrong or already fixed.
rm     Remove an idea (curator use: --reason promoted|obsolete|wrong).

An idea is one line of at most ${IDEA_MAX_CHARS} characters, shaped as
"<what is wrong or missing> ${IDEA_ARROW} <proposed change>". Name the file or command
it is about. Before adding, run \`kookr idea show\` and vote for a matching idea.

Options:
  --shelf NAME   Shelf to use (default: $KOOKR_REPO_SLUG, the current repository).
  --top N        show only: how many ideas to print (default: ${DEFAULT_TOP}).
  --json         show only: machine-readable output.
  -h, --help     Show this help.

The store lives in $KOOKR_IDEAS_DIR (default: ~/.kookr/ideas). Lesson notebooks
are not touched.
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
  shelf?: string;
  top?: number;
  json: boolean;
  help: boolean;
  passthrough: string[];
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], json: false, help: false, passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    } else if (arg === '--shelf' || arg.startsWith('--shelf=')) {
      const value = takeValue('--shelf');
      if (!value) parsed.error = '--shelf needs a name';
      else parsed.shelf = value;
    } else if (arg === '--top' || arg.startsWith('--top=')) {
      const value = Number(takeValue('--top'));
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive whole number';
      else parsed.top = value;
    } else if (arg === '--reason' || arg.startsWith('--reason=') || arg === '--note' || arg.startsWith('--note=')) {
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

interface ShowEntry {
  id: string;
  score: number;
  text: string;
}

function formatScore(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}

export async function runIdeaCli(argv: string[], io: IdeaCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const runNb = io.runNb ?? makeRunNb(io.nbBin);
  const nbEnv = ideaNbEnv(env, io.homeDir);

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

  // Commands that work on the whole store, not one shelf.
  if (sub === 'list' || sub === 'path' || sub === 'doctor' || sub === 'stats') {
    const nbArgs = [sub, ...args.positional, ...(args.json ? ['--json'] : [])];
    return passOutput(runNb(nbArgs, nbEnv));
  }

  const shelf = args.shelf ?? env.KOOKR_REPO_SLUG?.trim();
  if (!shelf) {
    err.error('kookr idea: no shelf. Pass --shelf <name>, or run inside a Kookr task (it sets KOOKR_REPO_SLUG).');
    return 2;
  }

  switch (sub) {
    case 'show': {
      const res = runNb(['show', shelf, '--json'], nbEnv);
      if (res.status !== 0) return passOutput(res);
      let entries: ShowEntry[] = [];
      try {
        const parsed = JSON.parse(res.stdout) as { entries?: ShowEntry[] };
        entries = parsed.entries ?? [];
      } catch {
        err.error('kookr idea: could not read the shelf (nb show --json returned something else).');
        return 1;
      }
      const top = [...entries].sort((a, b) => b.score - a.score).slice(0, args.top ?? DEFAULT_TOP);
      if (args.json) {
        out.log(JSON.stringify({ shelf, total: entries.length, entries: top }));
        return 0;
      }
      if (entries.length === 0) {
        out.log(`No ideas recorded for ${shelf} yet.`);
        return 0;
      }
      out.log(`Ideas for ${shelf}: top ${top.length} of ${entries.length}, best score first`);
      for (const e of top) out.log(`${e.id}  [${formatScore(e.score)}]  ${e.text}`);
      out.log(`# a match: kookr idea vote <id> +1  ·  a new one: kookr idea add "<problem> ${IDEA_ARROW} <change>"`);
      return 0;
    }

    case 'add': {
      const text = args.positional.join(' ').trim();
      if (!text) {
        err.error(`kookr idea add: give the idea as one argument: "<problem> ${IDEA_ARROW} <proposed change>".`);
        return 2;
      }
      if (!text.includes(IDEA_ARROW)) {
        err.error(
          `kookr idea add: an idea needs both parts, "<what is wrong or missing> ${IDEA_ARROW} <proposed change>". ` +
            'Nothing was recorded.',
        );
        return 2;
      }
      const res = runNb(['add', shelf, text, '--json'], nbEnv);
      if (res.status !== 0) return passOutput(res);
      let result: { added?: boolean; reason?: string; id?: string; collidedId?: string };
      try {
        result = JSON.parse(res.stdout);
      } catch {
        return passOutput(res);
      }
      if (result.added) {
        out.log(result.id ? `Recorded idea ${result.id} on ${shelf}.` : `Recorded the idea on ${shelf}.`);
        if (res.stderr.trim()) err.error(res.stderr.replace(/\n$/, ''));
        return 0;
      }
      if (result.reason === 'duplicate' && result.collidedId) {
        const vote = runNb(['vote', shelf, result.collidedId, '+1'], nbEnv);
        if (vote.status !== 0) return passOutput(vote);
        out.log(`Already recorded as ${result.collidedId} on ${shelf}; voted +1 for it.`);
        return 0;
      }
      return passOutput(res);
    }

    case 'vote':
    case 'rm':
    case 'merge':
    case 'split':
    case 'describe':
    case 'stale':
      return passOutput(runNb([sub, shelf, ...args.positional, ...args.passthrough], nbEnv));

    default:
      err.error(`kookr idea: unknown command "${sub}". Run \`kookr idea --help\`.`);
      return 2;
  }
}
