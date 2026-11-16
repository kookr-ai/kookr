/**
 * `kookr opinion sweep` — turn the operator's `/opinion` replies into work
 * (issue #3920).
 *
 * Unattended tasks ask for the operator's opinion without waiting: they post a
 * request comment (marker `kookr:opinion-request`) on the issue or pull
 * request, add the `needs-operator-opinion` label, and carry on. This command
 * reads every item that still has the label, open or closed, and acts on each
 * new reply once:
 *
 *   - an accepting reply removes the label;
 *   - any other reply starts one follow-up task that applies it.
 *
 * Each handled reply is recorded by a marker comment on the item, so a second
 * run does nothing. The decision logic lives in `src/core/opinion-requests.ts`;
 * this file only talks to `gh` and `kookr spawn`.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  OPINION_LABEL,
  followUpPrompt,
  handledMarkerBody,
  planOpinionSweep,
  type OpinionAction,
  type OpinionComment,
} from '../core/opinion-requests.js';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_FAILED = 4;

export const OPINION_HELP_TEXT = `kookr opinion — act on the operator's answers to opinion requests.

Usage:
  kookr opinion sweep --repo <owner/name> [--cwd <path>] [--dry-run] [--json]

sweep  For every issue or pull request labelled ${OPINION_LABEL} (open or
       closed) that has an opinion request comment, act once on each new reply:
       a comment whose first line starts with /opinion.
         /opinion ok, or the recommended option's letter alone: removes the label.
         /opinion <another option or a change>: starts one follow-up task.
       Each handled reply gets a marker comment, so a second run does nothing.

Options:
  --repo <owner/name>  Repository to sweep (required).
  --cwd <path>         Working directory for follow-up tasks (default: cwd).
  --dry-run            Print what would be done; change nothing.
  --json               Print one machine-readable JSON envelope to stdout.
  -h, --help           Show this help.

Only comments by the repository owner, members and collaborators count.
After an accept the item is no longer labelled, so later replies on it are not
swept; ask for a change in a new issue instead.

Exit codes:
  0  Swept (including: nothing to do).
  2  User error (bad flags).
  4  A gh or spawn call failed; the items that succeeded are still recorded.
`;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one command with argv (no shell); `input` is written to its stdin. */
export type CommandRunner = (cmd: string, args: string[], input?: string) => Promise<CommandResult>;

export interface OpinionCliIo {
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  run?: CommandRunner;
  cwd?: string;
  /** Path to bin/kookr-spawn.js; `bin/kookr.js` passes it. Defaults to a sibling of the running script. */
  spawnBin?: string;
}

interface ParsedArgs {
  verb?: string;
  repo?: string;
  cwd?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseOpinionArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') out.help = true;
    else if (tok === '--dry-run') out.dryRun = true;
    else if (tok === '--json') out.json = true;
    else if (tok === '--repo' || tok === '--cwd') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) return { ...out, error: `${tok} needs a value` };
      if (tok === '--repo') out.repo = v;
      else out.cwd = v;
    } else if (tok.startsWith('-')) return { ...out, error: `unknown option: ${tok}` };
    else if (out.verb === undefined) out.verb = tok;
    else return { ...out, error: `unexpected argument: ${tok}` };
  }
  return out;
}

const defaultRun: CommandRunner = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code !== 0 ? error.message : '') });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });

export interface SweptItem {
  number: number;
  url: string;
  isPullRequest: boolean;
  action: OpinionAction['kind'];
  replyId: number;
  followUpTaskId?: string;
  error?: string;
}

interface LabelledItem {
  number: number;
  url: string;
  isPullRequest: boolean;
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as unknown);
}

export async function runOpinionCli(argv: string[], io: OpinionCliIo = {}): Promise<number> {
  const out = io.out ?? console;
  const err = io.err ?? console;
  const run = io.run ?? defaultRun;
  const args = parseOpinionArgs(argv);
  if (args.help) {
    out.log(OPINION_HELP_TEXT);
    return EXIT_OK;
  }
  const fail = (code: number, message: string): number => {
    if (args.json) out.log(JSON.stringify({ ok: false, code: 'USER_ERROR', message, details: { subcommand: 'opinion' } }));
    else {
      err.error(`kookr opinion: ${message}`);
      err.error('Run `kookr opinion --help` for usage.');
    }
    return code;
  };
  if (args.error) return fail(EXIT_USER_ERROR, args.error);
  if (args.verb !== 'sweep') return fail(EXIT_USER_ERROR, args.verb ? `unknown verb: ${args.verb}` : 'a verb is required (sweep).');
  if (!args.repo || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) return fail(EXIT_USER_ERROR, '--repo <owner/name> is required.');
  const repo = args.repo;
  const cwd = args.cwd ?? io.cwd ?? process.cwd();
  const spawnBin = io.spawnBin ?? join(dirname(process.argv[1] ?? '.'), 'kookr-spawn.js');

  const failures: string[] = [];
  const swept: SweptItem[] = [];

  const listed = await run('gh', [
    'api', '--paginate',
    `repos/${repo}/issues?labels=${OPINION_LABEL}&state=all&per_page=100`,
    '--jq', '.[] | {number, url: .html_url, isPullRequest: (.pull_request != null)}',
  ]);
  if (listed.code !== 0) {
    failures.push(`listing labelled items failed: ${listed.stderr.trim()}`);
  }
  const items = listed.code === 0 ? (parseJsonLines(listed.stdout) as LabelledItem[]) : [];

  for (const item of items) {
    const fetched = await run('gh', [
      'api', '--paginate',
      `repos/${repo}/issues/${item.number}/comments?per_page=100`,
      '--jq', '.[] | {id, body, createdAt: .created_at, url: .html_url, authorAssociation: .author_association}',
    ]);
    if (fetched.code !== 0) {
      failures.push(`#${item.number}: reading comments failed: ${fetched.stderr.trim()}`);
      continue;
    }
    const plan = planOpinionSweep(parseJsonLines(fetched.stdout) as OpinionComment[]);
    for (const action of plan.actions) {
      const record: SweptItem = {
        number: item.number,
        url: item.url,
        isPullRequest: item.isPullRequest,
        action: action.kind,
        replyId: action.reply.commentId,
      };
      swept.push(record);
      if (args.dryRun) continue;

      if (action.kind === 'accept') {
        const removed = await run('gh', ['api', '-X', 'DELETE', `repos/${repo}/issues/${item.number}/labels/${OPINION_LABEL}`]);
        // 404: the label is already gone, which is the state we want.
        if (removed.code !== 0 && !/404|Label does not exist/i.test(removed.stderr)) {
          record.error = `removing the label failed: ${removed.stderr.trim()}`;
          failures.push(`#${item.number}: ${record.error}`);
          break;
        }
      } else {
        const prompt = followUpPrompt({ repo, number: item.number, itemUrl: item.url, isPullRequest: item.isPullRequest, reply: action.reply });
        const spawned = await run(process.execPath, [
          spawnBin,
          '--cwd', cwd,
          '--criteria', `The operator's /opinion reply ${action.reply.url} on ${repo}#${item.number} is applied (merged), or one clarifying question is posted on the item`,
          '--idempotency-key', `opinion:${repo}#${item.number}:${action.reply.commentId}`,
          '--dedupe', 'block',
          '--auto-close-on-signal',
          '--json',
        ], prompt);
        // Exit 5: an identical follow-up is already running, so this reply is already being worked on.
        if (spawned.code !== 0 && spawned.code !== 5) {
          record.error = `starting the follow-up task failed (exit ${spawned.code}): ${(spawned.stderr || spawned.stdout).trim()}`;
          failures.push(`#${item.number}: ${record.error}`);
          // Stop on this item: a later accept would remove the label and hide this reply from every later run.
          break;
        }
        try {
          const env = JSON.parse(spawned.stdout.trim().split('\n').pop() ?? '{}') as { details?: { taskId?: string } };
          if (typeof env.details?.taskId === 'string') record.followUpTaskId = env.details.taskId;
        } catch {
          // The task id is only for the record comment; its absence is harmless.
        }
      }

      const marked = await run('gh', [
        'api', `repos/${repo}/issues/${item.number}/comments`,
        '-f', `body=${handledMarkerBody(action, record.followUpTaskId)}`,
      ]);
      if (marked.code !== 0) {
        // Not recorded: the next run sees the reply again. For a follow-up, the
        // spawn idempotency key replays the same task for 24 hours.
        record.error = `recording the handled reply failed: ${marked.stderr.trim()}`;
        failures.push(`#${item.number}: ${record.error}`);
        break;
      }
    }
  }

  if (args.json) {
    out.log(JSON.stringify({
      ok: failures.length === 0,
      code: failures.length === 0 ? 'OK' : 'PARTIAL_FAILURE',
      message: `${swept.length} repl${swept.length === 1 ? 'y' : 'ies'} ${args.dryRun ? 'to handle' : 'handled'} on ${items.length} labelled item(s)`,
      details: { repo, dryRun: args.dryRun, labelledItems: items.length, swept, failures },
    }));
  } else {
    out.log(`kookr opinion sweep ${repo}: ${items.length} labelled item(s), ${swept.length} new repl${swept.length === 1 ? 'y' : 'ies'}${args.dryRun ? ' (dry run)' : ''}`);
    for (const s of swept) {
      const what = s.action === 'accept' ? 'accepted, label removed' : `follow-up task${s.followUpTaskId ? ` ${s.followUpTaskId}` : ''}`;
      out.log(`  #${s.number} reply ${s.replyId}: ${args.dryRun ? `would be ${s.action}` : what}${s.error ? ` — FAILED: ${s.error}` : ''}`);
    }
    for (const f of failures) err.error(`kookr opinion: ${f}`);
  }
  return failures.length === 0 ? EXIT_OK : EXIT_FAILED;
}
