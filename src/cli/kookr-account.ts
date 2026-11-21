/**
 * `kookr account` — manage named Claude Code accounts and move tasks between
 * them (account switching; docs/reference/claude-accounts.md).
 *
 *   kookr account list [--json]
 *   kookr account add <name> [--default]      token on stdin, or pasted at a prompt
 *   kookr account remove <name>
 *   kookr account default <name|host>
 *   kookr account test <name|host>            one tiny `claude -p` request on that account
 *   kookr account switch <taskId> <name|host> [--json]
 *
 * `list`, `add`, `remove`, `default` and `test` work on the registry file
 * directly (`~/.kookr/claude-accounts.json`, mode 0600) and need no server:
 * the server reads the file at every launch. `switch` goes through
 * `POST /api/tasks/:id/claude-account`, because moving a running task means
 * stopping and relaunching its agent.
 *
 * Tokens are never accepted on the command line (argv is visible to every
 * process on the host and lands in shell history) and never printed.
 */

import { spawnSync } from 'node:child_process';
import {
  ClaudeAccountError,
  HOST_CLAUDE_ACCOUNT,
  assertKnownAccount,
  claudeAccountLaunchEnv,
  extractClaudeOAuthToken,
  loadClaudeAccounts,
  resolveClaudeAccountsFile,
  saveClaudeAccounts,
  stripInheritedClaudeAccountEnv,
  summarizeClaudeAccounts,
  withAccount,
  withDefaultAccount,
  withoutAccount,
} from '../core/claude-accounts.js';
import { SUPERVISOR_ACTOR_HEADER } from '../shared/contracts/supervisor-actions.js';
import { resolveStopBaseUrl } from './kookr-stop.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;
export const EXIT_AMBIGUOUS = 5;

// A switch of a running task awaits its relaunch, which can take up to the
// default launch timeout (180 s), like `kookr reopen`.
const SWITCH_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;

export const ACCOUNT_HELP_TEXT = `kookr account — named Claude Code accounts, and moving tasks between them.

Usage:
  kookr account list [--json]
  kookr account add <name> [--default]
  kookr account remove <name>
  kookr account default <name|host>
  kookr account test <name|host>
  kookr account switch <taskId> <name|host> [--json]

Accounts:
  host is the host's own \`claude login\`; it always exists and is the default
  until you choose another. Every other account is a token from
  \`claude setup-token\` (run it on any machine with a browser, signed in to
  the subscription you want). Pipe it in, or paste it when asked:

    claude setup-token | kookr account add work
    kookr account add personal            # then paste the token

  New tasks run on the default account (kookr spawn --account <name> picks
  another). A task stays on the account it started on until it is switched.

Switching:
  kookr account switch <taskId> <name> moves a task to another account. A
  running task is stopped and relaunched in place: same worktree, same
  conversation (claude --resume), new subscription. A task that is not running
  keeps the new account for its next launch (queue promotion or reopen).

Commands:
  list      Show accounts (never the tokens) and which one is the default.
  add       Register an account, or replace its token. --default also makes it
            the default for new tasks.
  remove    Forget an account. Tasks pinned to it fail to launch until switched.
  default   Choose the account new tasks run on.
  test      Send one tiny \`claude -p\` request on that account and report
            whether it authenticates. Uses a few tokens of that account.
  switch    Move a task to another account (needs a running server).

Environment:
  KOOKR_CLAUDE_ACCOUNTS_FILE  Registry path (default ~/.kookr/claude-accounts.json).
  KOOKR_AGENT_BIN             claude binary used by \`test\` (default: claude).
  KOOKR_API_BASE_URL / KOOKR_PORT / KOOKR_SUPERVISOR_TOKEN / KOOKR_API_TOKEN
                              Server selection and auth for \`switch\`.

Exit codes:
  0  Success.   1  test: the account did not authenticate.   2  User error.
  3  No server reachable.   4  Server/HTTP error.   5  Ambiguous port.
`;

export interface AccountCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  /** Reads the token for `add`. Default: all of stdin, or a hidden prompt on a TTY. */
  readSecret?: () => Promise<string>;
  /** Runs `claude -p` for `test`. Default: spawnSync. */
  runClaude?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
}

interface Parsed {
  verb?: string;
  positionals: string[];
  json: boolean;
  makeDefault: boolean;
  help: boolean;
  error?: string;
}

export function parseAccountArgs(argv: string[]): Parsed {
  const out: Parsed = { positionals: [], json: false, makeDefault: false, help: false };
  for (const tok of argv) {
    if (tok === '--json') out.json = true;
    else if (tok === '--default') out.makeDefault = true;
    else if (tok === '-h' || tok === '--help') out.help = true;
    else if (tok.startsWith('-')) out.error = `unknown option: ${tok}`;
    else if (out.verb === undefined) out.verb = tok;
    else out.positionals.push(tok);
  }
  return out;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** Read one line from the terminal without echoing it. */
function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

function defaultReadSecret(): Promise<string> {
  if (process.stdin.isTTY) return readHiddenLine('Paste the token from `claude setup-token`: ');
  return readAllStdin();
}

function defaultRunClaude(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  const res = spawnSync(bin, args, { env, encoding: 'utf-8', timeout: TEST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.error ? `${res.stderr ?? ''}${res.error.message}` : (res.stderr ?? ''),
  };
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

export async function runAccountCli(argv: string[], io: AccountCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const args = parseAccountArgs(argv);
  const file = resolveClaudeAccountsFile(env);

  if (args.help || args.verb === undefined || args.verb === 'help') {
    out.log(args.json
      ? JSON.stringify({ ok: true, code: 'OK', message: 'Help', details: { subcommand: 'account', help: ACCOUNT_HELP_TEXT } })
      : ACCOUNT_HELP_TEXT);
    return args.verb === undefined && !args.help ? EXIT_USER_ERROR : EXIT_OK;
  }

  const fail = (exitCode: number, code: string, message: string, details?: Record<string, unknown>): number => {
    if (args.json) {
      out.log(JSON.stringify({ ok: false, code, message, details: { subcommand: `account ${args.verb}`, ...details } }));
    } else {
      err.error(`kookr account ${args.verb}: ${message}`);
      if (code === 'USER_ERROR') err.error('Run `kookr account --help` for usage.');
    }
    return exitCode;
  };
  const succeed = (message: string, details: Record<string, unknown> = {}): number => {
    out.log(args.json ? JSON.stringify({ ok: true, code: 'OK', message, details: { subcommand: `account ${args.verb}`, ...details } }) : message);
    return EXIT_OK;
  };
  const need = (count: number, usage: string): string | undefined =>
    args.positionals.length === count ? undefined : `usage: kookr account ${usage}`;

  if (args.error) return fail(EXIT_USER_ERROR, 'USER_ERROR', args.error);

  try {
    switch (args.verb) {
      case 'list': {
        const rows = summarizeClaudeAccounts(loadClaudeAccounts(file));
        if (args.json) return succeed(`${rows.length} account(s)`, { file, accounts: rows });
        const lines = rows.map((row) => {
          const mark = row.isDefault ? '*' : ' ';
          const detail = row.name === HOST_CLAUDE_ACCOUNT
            ? "the host's own claude login"
            : `token ${row.tokenHint}${row.addedAt ? `, added ${row.addedAt.slice(0, 10)}` : ''}`;
          return `${mark} ${row.name.padEnd(16)} ${detail}`;
        });
        return succeed([...lines, '', '* = default for new tasks'].join('\n'));
      }
      case 'add': {
        const usage = need(1, 'add <name> [--default]');
        if (usage) return fail(EXIT_USER_ERROR, 'USER_ERROR', usage);
        const name = args.positionals[0]!;
        const raw = await (io.readSecret ?? defaultReadSecret)();
        const token = extractClaudeOAuthToken(raw);
        if (!token) {
          return fail(EXIT_USER_ERROR, 'USER_ERROR', 'no token found in the input; expected the output of `claude setup-token` (a token starting with "sk-ant-oat")');
        }
        const before = loadClaudeAccounts(file);
        const replaced = Object.prototype.hasOwnProperty.call(before.accounts, name);
        let next = withAccount(before, name, token);
        if (args.makeDefault) next = withDefaultAccount(next, name);
        saveClaudeAccounts(next, file);
        return succeed(
          `${replaced ? 'Replaced the token of' : 'Added'} Claude account "${name}"${args.makeDefault ? ' and made it the default' : ''}. ` +
            `Check it with \`kookr account test ${name}\`.`,
          { name, replaced, isDefault: (next.default ?? HOST_CLAUDE_ACCOUNT) === name },
        );
      }
      case 'remove': {
        const usage = need(1, 'remove <name>');
        if (usage) return fail(EXIT_USER_ERROR, 'USER_ERROR', usage);
        const name = args.positionals[0]!;
        const before = loadClaudeAccounts(file);
        saveClaudeAccounts(withoutAccount(before, name), file);
        const wasDefault = before.default === name;
        return succeed(
          `Removed Claude account "${name}".${wasDefault ? ' New tasks now run on host.' : ''} ` +
            'Tasks pinned to it will not launch until you switch them to another account.',
          { name, wasDefault },
        );
      }
      case 'default': {
        const usage = need(1, 'default <name|host>');
        if (usage) return fail(EXIT_USER_ERROR, 'USER_ERROR', usage);
        const name = args.positionals[0]!;
        saveClaudeAccounts(withDefaultAccount(loadClaudeAccounts(file), name), file);
        return succeed(`New tasks now run on Claude account "${name}". Tasks already started keep their account.`, { name });
      }
      case 'test': {
        const usage = need(1, 'test <name|host>');
        if (usage) return fail(EXIT_USER_ERROR, 'USER_ERROR', usage);
        const name = args.positionals[0]!;
        const registry = loadClaudeAccounts(file);
        assertKnownAccount(registry, name);
        // From an agent shell on another account the inherited token would
        // otherwise answer for `host`.
        const childEnv: NodeJS.ProcessEnv = { ...stripInheritedClaudeAccountEnv(env), ...claudeAccountLaunchEnv(registry, name) };
        delete childEnv.CLAUDE_CODE_CHILD_SESSION;
        const bin = env.KOOKR_AGENT_BIN?.trim() || 'claude';
        const res = (io.runClaude ?? defaultRunClaude)(
          bin,
          ['-p', 'Reply with the single word OK.', '--max-turns', '1', '--model', 'haiku'],
          childEnv,
        );
        const output = `${res.stdout}\n${res.stderr}`.trim();
        if (res.status === 0 && !/failed to authenticate|invalid|401|403/i.test(output)) {
          return succeed(`Claude account "${name}" works.`, { name });
        }
        const firstLine = output.split('\n').find((line) => line.trim() !== '') ?? `exit status ${String(res.status)}`;
        return fail(EXIT_FAILED, 'AUTH_FAILED', `Claude account "${name}" did not answer: ${firstLine.slice(0, 300)}`, { name });
      }
      case 'switch':
        return await runSwitch(args, env, io, fail, succeed);
      default:
        return fail(EXIT_USER_ERROR, 'USER_ERROR', `unknown command: ${args.verb}`);
    }
  } catch (e) {
    if (e instanceof ClaudeAccountError) return fail(EXIT_USER_ERROR, 'USER_ERROR', e.message, { reason: e.code });
    throw e;
  }
}

async function runSwitch(
  args: Parsed,
  env: NodeJS.ProcessEnv,
  io: AccountCliIo,
  fail: (exitCode: number, code: string, message: string, details?: Record<string, unknown>) => number,
  succeed: (message: string, details?: Record<string, unknown>) => number,
): Promise<number> {
  if (args.positionals.length !== 2) {
    return fail(EXIT_USER_ERROR, 'USER_ERROR', 'usage: kookr account switch <taskId> <name|host>');
  }
  const [taskId, account] = args.positionals as [string, string];
  const fetchImpl = io.fetchImpl ?? fetch;
  const base = await resolveStopBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') {
    return fail(EXIT_USER_ERROR, 'USER_ERROR', `KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`);
  }
  if (base.kind === 'ambiguous') {
    const [a, b] = base.ports;
    return fail(EXIT_AMBIGUOUS, 'AMBIGUOUS_PORT', `two Kookr instances are reachable on :${a} and :${b}. Set KOOKR_PORT to choose one.`, { ports: base.ports });
  }
  if (base.kind === 'none') {
    return fail(EXIT_NO_SERVER, 'NO_SERVER', 'no Kookr server reachable (checked ports 4800, 4801). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.');
  }

  let status: number;
  let body: Record<string, unknown> = {};
  try {
    const res = await fetchImpl(`${base.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/claude-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SUPERVISOR_ACTOR_HEADER]: 'cli',
        'User-Agent': `kookr-account/node-${process.versions.node}`,
        ...authHeaders(env),
      },
      body: JSON.stringify({ account }),
      signal: AbortSignal.timeout(SWITCH_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      return fail(EXIT_SERVER_ERROR, 'TIMEOUT', `request timed out after ${SWITCH_TIMEOUT_MS} ms; the task may still be relaunching — check it with \`kookr peek ${taskId}\``, { taskId });
    }
    return fail(EXIT_NO_SERVER, 'NO_SERVER', `request failed: ${e instanceof Error ? e.message : String(e)}`, { taskId });
  }

  if (status === 404) return fail(EXIT_USER_ERROR, 'NOT_FOUND', `task not found: ${taskId}`, { taskId });
  if (status < 200 || status >= 300) {
    const message = typeof body.error === 'string' ? body.error : `server returned HTTP ${status}`;
    const serverCode = typeof body.code === 'string' ? body.code : undefined;
    const exit = status === 400 || status === 409 ? EXIT_USER_ERROR : EXIT_SERVER_ERROR;
    return fail(exit, serverCode ? serverCode.toUpperCase() : 'SERVER_ERROR', message, { taskId, status, ...(serverCode ? { serverCode } : {}) });
  }

  const outcome = typeof body.outcome === 'string' ? body.outcome : 'unknown';
  const from = typeof body.from === 'string' ? body.from : '?';
  const messages: Record<string, string> = {
    unchanged: `Task ${taskId} is already on Claude account "${account}".`,
    pinned: `Task ${taskId} moved from "${from}" to "${account}"; it is not running, so the new account applies at its next launch.`,
    relaunched: `Task ${taskId} moved from "${from}" to "${account}" and was relaunched, continuing its conversation.`,
    queued: `Task ${taskId} moved from "${from}" to "${account}". Its agent was stopped; it is queued and relaunches, continuing its conversation, when a slot frees.`,
  };
  return succeed(messages[outcome] ?? `Task ${taskId}: ${outcome}.`, { taskId, outcome, from, to: account });
}
