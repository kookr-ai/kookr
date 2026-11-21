/**
 * Named Claude Code accounts for task launches (account switching).
 *
 * One Kookr host often has access to more than one Claude subscription (a
 * personal plan and a team plan, or two Max plans). Without this module every
 * task runs on whatever `claude login` left in `~/.claude/.credentials.json`,
 * so a usage limit on that one account stalls the whole fleet.
 *
 * An *account* here is a name plus a long-lived OAuth token produced by
 * `claude setup-token`. A task launched on an account gets that token as
 * `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code prefers over the stored login
 * (verified on Claude Code 2.1.330: `claude auth status` reports
 * `authMethod: "oauth_token"`, and a bogus token fails with a 401 instead of
 * falling back to the stored login). Everything else — `~/.claude/projects`
 * transcripts, settings, plugins — stays shared, which is what lets a task
 * switch accounts and continue its own conversation with `--resume`.
 *
 * The reserved name `host` means "the host's own `claude login`": no token is
 * injected. It is the implicit default, so a host with no registry file
 * behaves exactly as before.
 *
 * The registry is machine-wide (`~/.kookr/claude-accounts.json`, mode 0600),
 * not per Kookr instance: the credentials belong to the operator's user, like
 * `~/.claude` does, so the prod and dev servers share it.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The account that uses the host's own `claude login` (no injected token). */
export const HOST_CLAUDE_ACCOUNT = 'host';

/** Overrides the registry location; mostly for tests and multi-user hosts. */
export const CLAUDE_ACCOUNTS_FILE_ENV = 'KOOKR_CLAUDE_ACCOUNTS_FILE';

const REGISTRY_VERSION = 1;

/** Lower-case name, digits, `-` and `_`, 1 to 40 characters, starting with a letter or digit. */
const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * A token printed by `claude setup-token`. The CLI prints it among other text,
 * so {@link extractClaudeOAuthToken} looks for this shape inside the input.
 */
const OAUTH_TOKEN_PATTERN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;

export interface ClaudeAccountRecord {
  /** The `claude setup-token` OAuth token. Never leaves this file except into a launch env. */
  token: string;
  /** ISO timestamp the account was added or its token last replaced. */
  addedAt: string;
}

export interface ClaudeAccountRegistry {
  version: typeof REGISTRY_VERSION;
  /** Account new tasks launch on when they name none. Absent means {@link HOST_CLAUDE_ACCOUNT}. */
  default?: string;
  accounts: Record<string, ClaudeAccountRecord>;
}

/** What `kookr account list` and the API may show: never the token itself. */
export interface ClaudeAccountSummary {
  name: string;
  isDefault: boolean;
  /** `host` has no token; others show the last four characters so two entries can be told apart. */
  tokenHint?: string;
  addedAt?: string;
}

export class ClaudeAccountError extends Error {
  constructor(
    readonly code: 'invalid_name' | 'reserved_name' | 'unknown_account' | 'invalid_token' | 'malformed_registry',
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeAccountError';
  }
}

export function resolveClaudeAccountsFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLAUDE_ACCOUNTS_FILE_ENV]?.trim();
  if (override) return override;
  return join(env.HOME?.trim() || homedir(), '.kookr', 'claude-accounts.json');
}

export function emptyClaudeAccountRegistry(): ClaudeAccountRegistry {
  return { version: REGISTRY_VERSION, accounts: {} };
}

/** Throws {@link ClaudeAccountError} unless `name` is a valid, non-reserved account name. */
export function assertValidAccountName(name: string): void {
  if (name === HOST_CLAUDE_ACCOUNT) {
    throw new ClaudeAccountError('reserved_name', `"${HOST_CLAUDE_ACCOUNT}" is reserved for the host's own claude login`);
  }
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new ClaudeAccountError(
      'invalid_name',
      `invalid account name "${name}": use 1-40 lower-case letters, digits, "-" or "_", starting with a letter or digit`,
    );
  }
}

/**
 * Pull the OAuth token out of what the operator pasted: either the bare token
 * or the whole output of `claude setup-token`. Returns `undefined` when there
 * is no token-shaped string in it.
 */
export function extractClaudeOAuthToken(input: string): string | undefined {
  return OAUTH_TOKEN_PATTERN.exec(input)?.[0];
}

function parseRegistry(raw: string, path: string): ClaudeAccountRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ClaudeAccountError(
      'malformed_registry',
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClaudeAccountError('malformed_registry', `${path} must hold a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== REGISTRY_VERSION) {
    throw new ClaudeAccountError('malformed_registry', `${path} has unsupported version ${String(obj.version)}`);
  }
  const accountsRaw = obj.accounts;
  if (!accountsRaw || typeof accountsRaw !== 'object' || Array.isArray(accountsRaw)) {
    throw new ClaudeAccountError('malformed_registry', `${path} must have an "accounts" object`);
  }
  const accounts: Record<string, ClaudeAccountRecord> = {};
  for (const [name, value] of Object.entries(accountsRaw as Record<string, unknown>)) {
    const record = value as Partial<ClaudeAccountRecord> | null;
    if (
      !ACCOUNT_NAME_PATTERN.test(name)
      || name === HOST_CLAUDE_ACCOUNT
      || !record
      || typeof record.token !== 'string'
      || record.token.trim() === ''
    ) {
      throw new ClaudeAccountError('malformed_registry', `${path} has an invalid entry for account "${name}"`);
    }
    accounts[name] = {
      token: record.token.trim(),
      addedAt: typeof record.addedAt === 'string' ? record.addedAt : '',
    };
  }
  const registry: ClaudeAccountRegistry = { version: REGISTRY_VERSION, accounts };
  if (obj.default !== undefined) {
    if (typeof obj.default !== 'string') {
      throw new ClaudeAccountError('malformed_registry', `${path} "default" must be a string`);
    }
    if (obj.default !== HOST_CLAUDE_ACCOUNT) {
      if (!accounts[obj.default]) {
        throw new ClaudeAccountError('malformed_registry', `${path} default account "${obj.default}" is not registered`);
      }
      registry.default = obj.default;
    }
  }
  return registry;
}

/**
 * Read the registry. A missing file is an empty registry (every task runs on
 * the host login, as before this feature). A file that exists but cannot be
 * parsed throws: guessing would launch tasks on the wrong subscription.
 */
export function loadClaudeAccounts(path: string = resolveClaudeAccountsFile()): ClaudeAccountRegistry {
  if (!existsSync(path)) return emptyClaudeAccountRegistry();
  return parseRegistry(readFileSync(path, 'utf-8'), path);
}

/** Write the registry atomically with owner-only permissions. */
export function saveClaudeAccounts(
  registry: ClaudeAccountRegistry,
  path: string = resolveClaudeAccountsFile(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: ClaudeAccountRegistry = {
    version: REGISTRY_VERSION,
    ...(registry.default !== undefined ? { default: registry.default } : {}),
    accounts: registry.accounts,
  };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file; a leftover tmp
  // from a crashed write keeps its old mode, so set it explicitly.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Add an account, or replace its token when the name exists. Returns a new registry. */
export function withAccount(
  registry: ClaudeAccountRegistry,
  name: string,
  token: string,
  now: Date = new Date(),
): ClaudeAccountRegistry {
  assertValidAccountName(name);
  const trimmed = token.trim();
  if (!extractClaudeOAuthToken(trimmed) || extractClaudeOAuthToken(trimmed) !== trimmed) {
    throw new ClaudeAccountError(
      'invalid_token',
      'expected a token from `claude setup-token` (it starts with "sk-ant-oat")',
    );
  }
  return {
    ...registry,
    accounts: { ...registry.accounts, [name]: { token: trimmed, addedAt: now.toISOString() } },
  };
}

/** Remove an account. Removing the default account resets the default to `host`. */
export function withoutAccount(registry: ClaudeAccountRegistry, name: string): ClaudeAccountRegistry {
  if (!registry.accounts[name]) {
    throw new ClaudeAccountError('unknown_account', `no Claude account named "${name}"`);
  }
  const accounts = { ...registry.accounts };
  delete accounts[name];
  const next: ClaudeAccountRegistry = { version: REGISTRY_VERSION, accounts };
  if (registry.default !== undefined && registry.default !== name) next.default = registry.default;
  return next;
}

/** Set the account new tasks launch on. `host` clears the default. */
export function withDefaultAccount(registry: ClaudeAccountRegistry, name: string): ClaudeAccountRegistry {
  assertKnownAccount(registry, name);
  const next: ClaudeAccountRegistry = { version: REGISTRY_VERSION, accounts: registry.accounts };
  if (name !== HOST_CLAUDE_ACCOUNT) next.default = name;
  return next;
}

/** True for `host` and for every registered account. */
export function isKnownAccount(registry: ClaudeAccountRegistry, name: string): boolean {
  return name === HOST_CLAUDE_ACCOUNT || Object.prototype.hasOwnProperty.call(registry.accounts, name);
}

export function assertKnownAccount(registry: ClaudeAccountRegistry, name: string): void {
  if (!isKnownAccount(registry, name)) {
    const known = [HOST_CLAUDE_ACCOUNT, ...Object.keys(registry.accounts).sort()].join(', ');
    throw new ClaudeAccountError('unknown_account', `no Claude account named "${name}" (known: ${known})`);
  }
}

/** The account a launch uses: the task's pinned one, else the registry default, else `host`. */
export function effectiveClaudeAccount(
  registry: ClaudeAccountRegistry,
  pinned: string | undefined,
): string {
  return pinned ?? registry.default ?? HOST_CLAUDE_ACCOUNT;
}

/**
 * Environment a launch on `name` needs. `host` needs nothing. A registered
 * account gets its token, and the two variables Claude Code ranks above an
 * OAuth token are blanked: an `ANTHROPIC_API_KEY` inherited from the server's
 * environment would otherwise win and bill the API key instead of the chosen
 * subscription (an empty value counts as unset; verified on 2.1.330).
 */
export function claudeAccountLaunchEnv(
  registry: ClaudeAccountRegistry,
  name: string,
): Record<string, string> {
  if (name === HOST_CLAUDE_ACCOUNT) return {};
  const record = registry.accounts[name];
  if (!record) {
    throw new ClaudeAccountError(
      'unknown_account',
      `this task is pinned to Claude account "${name}", which is no longer registered; ` +
        'add it again with `kookr account add` or switch the task with `kookr account switch`',
    );
  }
  return {
    CLAUDE_CODE_OAUTH_TOKEN: record.token,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
  };
}

/** Token-free listing, `host` first, then registered accounts by name. */
export function summarizeClaudeAccounts(registry: ClaudeAccountRegistry): ClaudeAccountSummary[] {
  const defaultName = registry.default ?? HOST_CLAUDE_ACCOUNT;
  const rows: ClaudeAccountSummary[] = [
    { name: HOST_CLAUDE_ACCOUNT, isDefault: defaultName === HOST_CLAUDE_ACCOUNT },
  ];
  for (const name of Object.keys(registry.accounts).sort()) {
    const record = registry.accounts[name]!;
    rows.push({
      name,
      isDefault: defaultName === name,
      tokenHint: `…${record.token.slice(-4)}`,
      ...(record.addedAt ? { addedAt: record.addedAt } : {}),
    });
  }
  return rows;
}
