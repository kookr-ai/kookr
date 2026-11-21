/**
 * Named Claude accounts over HTTP (dashboard Settings -> Accounts; follow-up to
 * #4236, see docs/reference/claude-accounts.md). Wire types live in
 * `src/shared/contracts/claude-accounts.ts`.
 *
 * Tokens are write-only: `POST` accepts one, no response, error message or
 * audit row ever carries it. The routes sit behind the global API auth
 * middleware, which already refuses viewer-share sessions on any route that is
 * not allow-listed; the mutation and test routes additionally refuse any actor
 * that is not the owner, defensively.
 */
import type { Context, Hono } from 'hono';
import { join } from 'node:path';
import {
  ClaudeAccountError,
  HOST_CLAUDE_ACCOUNT,
  assertKnownAccount,
  assertValidAccountName,
  extractClaudeOAuthToken,
  loadClaudeAccounts,
  resolveClaudeAccountsFile,
  saveClaudeAccounts,
  summarizeClaudeAccounts,
  withAccount,
  withDefaultAccount,
  withoutAccount,
  type ClaudeAccountRegistry,
} from '../../core/claude-accounts.js';
import { appendAuditRow } from '../../core/audit-log.js';
import { redactSecrets } from '../../core/redact-secrets.js';
import { testClaudeAccount, type ClaudeProbeRunner } from '../../adapters/claude-account-test.js';
import { ACTOR_HEADER, resolveLifecycleActor } from '../actor-attribution.js';
import type {
  AddClaudeAccountRequest,
  ClaudeAccountsErrorResponse,
  ClaudeAccountsResponse,
  ClaudeAccountTestResponse,
} from '../../shared/contracts/claude-accounts.js';

/** Where the registry lives and how an account is probed; injectable so tests use a temp file. */
export interface ClaudeAccountStore {
  load: () => ClaudeAccountRegistry;
  save: (registry: ClaudeAccountRegistry) => void;
  /** Replaces the `claude -p` child process the test route runs (tests). */
  runProbe?: ClaudeProbeRunner;
}

export interface ClaudeAccountRouteDeps {
  claudeAccounts?: ClaudeAccountStore;
  /** Shared `audit.jsonl` path; absent in lightweight harnesses. */
  auditLogPath?: string;
  kookrDir?: string;
}

const MAX_NAME_INPUT = 200;

function defaultStore(): ClaudeAccountStore {
  const file = resolveClaudeAccountsFile();
  return { load: () => loadClaudeAccounts(file), save: (r) => saveClaudeAccounts(r, file) };
}

function view(registry: ClaudeAccountRegistry): ClaudeAccountsResponse {
  return {
    accounts: summarizeClaudeAccounts(registry),
    default: registry.default ?? HOST_CLAUDE_ACCOUNT,
  };
}

export function registerClaudeAccountRoutes(app: Hono, deps: ClaudeAccountRouteDeps): void {
  const store = deps.claudeAccounts ?? defaultStore();
  const auditLogPath = deps.auditLogPath ?? (deps.kookrDir ? join(deps.kookrDir, 'audit.jsonl') : undefined);

  const fail = (c: Context, status: 400 | 403 | 404 | 500, code: ClaudeAccountsErrorResponse['code'] | 'forbidden', error: string) =>
    c.json({ error: redactSecrets(error), code }, status);

  /** Maps registry errors to HTTP; `unknownStatus` lets default-setting report 400 where others report 404. */
  const registryFailure = (c: Context, err: unknown, unknownStatus: 400 | 404 = 404) => {
    if (err instanceof ClaudeAccountError) {
      const status = err.code === 'malformed_registry' ? 500 : err.code === 'unknown_account' ? unknownStatus : 400;
      return fail(c, status, err.code, err.message);
    }
    return fail(c, 500, 'malformed_registry', 'could not read or write the Claude account registry');
  };

  const requireOwner = (c: Context): Response | undefined => {
    const actor = c.get('actor');
    return actor && actor.kind !== 'owner' ? fail(c, 403, 'forbidden', 'only the owner can manage Claude accounts') : undefined;
  };

  const audit = async (c: Context, action: string, fields: Record<string, unknown>): Promise<void> => {
    const actor = resolveLifecycleActor('api', c.req.header(ACTOR_HEADER));
    // Never include the token: only names, labels and flags go in the row.
    await appendAuditRow(auditLogPath, {
      type: 'claude-account.mutation',
      timestamp: new Date().toISOString(),
      actor: { source: 'api', actorId: actor.actorId },
      action,
      ...fields,
    });
  };

  const readJson = async (c: Context): Promise<Record<string, unknown> | undefined> => {
    try {
      const body: unknown = await c.req.json();
      return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  };

  app.get('/api/claude-accounts', (c) => {
    try {
      return c.json(view(store.load()));
    } catch (err) {
      return registryFailure(c, err);
    }
  });

  app.post('/api/claude-accounts', async (c) => {
    const denied = requireOwner(c);
    if (denied) return denied;
    const body = await readJson(c);
    if (!body || typeof body.name !== 'string' || typeof body.token !== 'string'
      || (body.label !== undefined && body.label !== null && typeof body.label !== 'string')
      || (body.makeDefault !== undefined && typeof body.makeDefault !== 'boolean')) {
      return fail(c, 400, 'invalid_body', 'body must be { name: string, token: string, label?: string, makeDefault?: boolean }');
    }
    const req = body as unknown as AddClaudeAccountRequest;
    try {
      const name = req.name.trim();
      if (name.length > MAX_NAME_INPUT) throw new ClaudeAccountError('invalid_name', 'invalid account name: too long');
      assertValidAccountName(name);
      const token = extractClaudeOAuthToken(req.token);
      if (!token) {
        throw new ClaudeAccountError('invalid_token', 'no token found; paste the output of `claude setup-token` (a token starting with "sk-ant-oat")');
      }
      const label = typeof req.label === 'string' && req.label.trim() !== '' ? req.label : undefined;
      const before = store.load();
      const replaced = Object.prototype.hasOwnProperty.call(before.accounts, name);
      let next = withAccount(before, name, token, label);
      if (req.makeDefault) next = withDefaultAccount(next, name);
      store.save(next);
      await audit(c, replaced ? 'replace' : 'add', {
        account: name,
        ...(next.accounts[name]?.label ? { label: next.accounts[name]!.label } : {}),
        makeDefault: req.makeDefault === true,
      });
      return c.json(view(next), 201);
    } catch (err) {
      return registryFailure(c, err);
    }
  });

  // Registered before `/:name` routes so `default` is never read as an account name.
  app.put('/api/claude-accounts/default', async (c) => {
    const denied = requireOwner(c);
    if (denied) return denied;
    const body = await readJson(c);
    if (!body || typeof body.name !== 'string') {
      return fail(c, 400, 'invalid_body', 'body must be { name: string }');
    }
    try {
      const before = store.load();
      const next = withDefaultAccount(before, body.name.trim());
      store.save(next);
      await audit(c, 'set-default', { account: body.name.trim(), previousDefault: before.default ?? HOST_CLAUDE_ACCOUNT });
      return c.json(view(next));
    } catch (err) {
      return registryFailure(c, err, 400);
    }
  });

  app.delete('/api/claude-accounts/:name', async (c) => {
    const denied = requireOwner(c);
    if (denied) return denied;
    const name = c.req.param('name');
    try {
      if (name === HOST_CLAUDE_ACCOUNT) {
        throw new ClaudeAccountError('reserved_name', `"${HOST_CLAUDE_ACCOUNT}" is the host's own claude login and cannot be removed`);
      }
      const before = store.load();
      const next = withoutAccount(before, name);
      store.save(next);
      await audit(c, 'remove', { account: name, wasDefault: before.default === name });
      return c.json(view(next));
    } catch (err) {
      return registryFailure(c, err);
    }
  });

  app.post('/api/claude-accounts/:name/test', async (c) => {
    const denied = requireOwner(c);
    if (denied) return denied;
    const name = c.req.param('name');
    try {
      const registry = store.load();
      assertKnownAccount(registry, name);
      const result = await testClaudeAccount(registry, name, store.runProbe ? { run: store.runProbe } : {});
      const response: ClaudeAccountTestResponse = { name, ...result, testedAt: new Date().toISOString() };
      return c.json(response);
    } catch (err) {
      return registryFailure(c, err);
    }
  });
}
