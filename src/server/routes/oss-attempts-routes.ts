import type { Context, Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { toOssAttemptsSnapshot } from '../oss-attempts-snapshot.js';

/**
 * Routes for the OSS contribution tracking view.
 *
 * - GET  /api/oss-attempts                — snapshot of the store
 * - POST /api/oss-attempts/events         — accept a capture event (from PostToolUse hook or scout skill)
 * - POST /api/oss-attempts/refresh        — trigger an on-demand refresh (UI Refresh button)
 *
 * The store is optional in RouteDeps to keep downstream callers that don't
 * provide it (tests, partial deployments) working.
 */
export function registerOssAttemptRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/oss-attempts', (c) => {
    if (!deps.ossAttemptStore) {
      return c.json({
        attempts: [],
        registryActiveRepos: [],
        lastRefreshAt: null,
        lastRefreshIssueCheckErrors: [],
      });
    }
    return c.json(toOssAttemptsSnapshot(
      deps.ossAttemptStore,
      deps.getRegistryActiveRepos?.() ?? [],
    ));
  });

  const handleEvent = (c: Context) => handleOssAttemptEvent(c, deps);
  const handleRefresh = (c: Context) => handleOssAttemptRefresh(c, deps);

  app.post('/api/oss-attempts/events', handleEvent);
  app.post('/api/oss-attempts/refresh', handleRefresh);
}

async function handleOssAttemptEvent(c: Context, deps: RouteDeps) {
  if (!deps.ossAttemptStore) {
    return c.json({ error: 'OSS tracking not enabled' }, 503);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'body must be an object' }, 400);
  }
  const event = body as Record<string, unknown>;
  const kind = event.kind;

  try {
    if (kind === 'pr_open') {
      const repo = asString(event.repo);
      const prNumber = asNumber(event.prNumber);
      const prUrl = asString(event.prUrl);
      const prTitle = asString(event.prTitle) ?? '';
      if (!repo || prNumber == null || !prUrl) {
        return c.json({ error: 'pr_open requires repo, prNumber, prUrl' }, 400);
      }
      const result = deps.ossAttemptStore.upsertPr({
        repo,
        prNumber,
        prUrl,
        prTitle,
        issueNumber: asNumber(event.issueNumber) ?? null,
        state: 'pr_open',
        source: 'posttool_hook',
        note: asString(event.note) ?? null,
      });
      if (result == null) {
        // Own-namespace — silently skipped
        return c.json({ accepted: false, reason: 'own-namespace' });
      }
      await deps.ossAttemptStore.save();
      deps.broadcastOssAttempts?.();
      return c.json({ accepted: true, id: result.id });
    }

    if (kind === 'scouted') {
      const repo = asString(event.repo);
      const issueNumber = asNumber(event.issueNumber);
      if (!repo || issueNumber == null) {
        return c.json({ error: 'scouted requires repo, issueNumber' }, 400);
      }
      const result = deps.ossAttemptStore.upsertScouted({
        repo,
        issueNumber,
        issueUrl: asString(event.issueUrl) ?? null,
        note: asString(event.note) ?? null,
      });
      if (result == null) {
        return c.json({ accepted: false, reason: 'own-namespace' });
      }
      await deps.ossAttemptStore.save();
      deps.broadcastOssAttempts?.();
      return c.json({ accepted: true, id: result.id });
    }

    return c.json({ error: `unknown kind: ${String(kind)}` }, 400);
  } catch (e) {
    return c.json({ error: `capture failed: ${(e as Error).message}` }, 500);
  }
}

async function handleOssAttemptRefresh(c: Context, deps: RouteDeps) {
  if (!deps.ossRefresher || !deps.ossAttemptStore) {
    return c.json({ error: 'OSS tracking not enabled' }, 503);
  }
  const result = await deps.ossRefresher.refresh();
  deps.broadcastOssAttempts?.();
  return c.json(result);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
