import type { Context, Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { isSafeGithubSegment } from '../../core/project-identity.js';
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

  // Bound the externally-supplied free-text/URL fields at ingest. They are
  // persisted verbatim into oss-attempts.json (rewritten wholesale on every
  // save) and broadcast in the snapshot sent to every connected dashboard
  // client, yet a caller is otherwise limited only by the ~1 MB request-body
  // ceiling — so one event could bloat the durable store and every client's
  // payload. These fields feed record ids, dedup and history, so we reject
  // over-cap values rather than silently truncating them. Cf. the caps on the
  // sibling self-report route (src/server/routes/self-report-routes.ts).
  const overLimit = overLengthField(event);
  if (overLimit) {
    return c.json(
      { error: `${overLimit} exceeds maximum length of ${FIELD_MAX_CHARS[overLimit]} characters` },
      400,
    );
  }

  try {
    if (kind === 'pr_open') {
      const repo = asGithubRepo(event.repo);
      const prNumber = asPositiveSafeInteger(event.prNumber);
      const issueNumber = asPositiveSafeInteger(event.issueNumber);
      const prUrl = asString(event.prUrl);
      const prTitle = asString(event.prTitle) ?? '';
      if (!repo || prNumber == null || !prUrl) {
        return c.json({ error: 'pr_open requires repo, prNumber, prUrl' }, 400);
      }
      if (event.issueNumber != null && issueNumber == null) {
        return c.json({ error: 'issueNumber must be a positive safe integer' }, 400);
      }
      const result = deps.ossAttemptStore.upsertPr({
        repo,
        prNumber,
        prUrl,
        prTitle,
        issueNumber,
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
      const repo = asGithubRepo(event.repo);
      const issueNumber = asPositiveSafeInteger(event.issueNumber);
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

/**
 * Per-field character caps for the free-text/URL fields accepted on the ingest
 * route. Short cap for the free-text fields, a URL-length cap for the URLs —
 * generous enough not to clip real PR titles, notes, or URLs.
 */
const FIELD_MAX_CHARS: Record<string, number> = {
  prTitle: 500,
  note: 500,
  prUrl: 2_000,
  issueUrl: 2_000,
};

/**
 * Returns the name of the first bounded field whose value is a string longer
 * than its cap, or null when every present field is within bounds. Absent
 * fields and non-string values are left to the existing per-kind validation.
 */
function overLengthField(event: Record<string, unknown>): string | null {
  for (const [field, max] of Object.entries(FIELD_MAX_CHARS)) {
    const v = event[field];
    if (typeof v === 'string' && v.length > max) return field;
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asGithubRepo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const segments = v.split('/');
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  if (repo === '.' || repo === '..') return null;
  // Dot-prefixed repository names such as .github are valid capture targets.
  // Replace only the first dot for validation so the shared alphabet and length
  // checks still apply, without its stricter project-ID leading-dot policy.
  const repoToValidate = repo.startsWith('.') ? `_${repo.slice(1)}` : repo;
  // Validate case-insensitively without changing the identity used in stored IDs.
  return isSafeGithubSegment(owner.toLowerCase(), 'owner')
    && isSafeGithubSegment(repoToValidate.toLowerCase(), 'repo') ? v : null;
}

function asPositiveSafeInteger(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
