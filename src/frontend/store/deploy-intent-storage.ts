/**
 * Sticky client deploy-window flag for the dashboard connection banner (#1982).
 *
 * Survives the intentional WebSocket blackout during `prod:update` even if
 * in-memory store state is reset mid-deploy (process death / remount / reload).
 * Cleared when deploy completes (new buildInfo commit), when the operator
 * cancels, or after a short TTL so a stale flag cannot linger past the
 * deploy window.
 *
 * Also persists the pre-deploy build short-hash so TopBar can clear the flag
 * after remount once a *different* buildInfo arrives (the in-memory ref alone
 * would be lost on refresh).
 *
 * Storage is sessionStorage (per-origin / per-tab session). That is enough for
 * the local dashboard: reload of the same tab keeps redeploy copy; a brand-new
 * tab does not share the flag (documented risk on #1982).
 */

const DEPLOY_INTENT_STORAGE_KEY = 'kookr.deploying';

/**
 * How long a deploy intent stays sticky after the last set(true).
 * Issue #1982 asked for ~2 minutes; keep a slightly generous window so a slow
 * prod:update still shows calm redeploy copy through the blackout.
 */
export const DEPLOY_INTENT_TTL_MS = 2 * 60 * 1000;

export interface DeployIntent {
  active: boolean;
  /** `buildInfo.commitShort` captured when deploy was triggered; null when unknown. */
  preDeployCommit: string | null;
  stampedAt: number;
}

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function parseIntent(raw: string, now: number): DeployIntent | null {
  // Legacy format: bare timestamp string
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && raw.trim() !== '' && !raw.trim().startsWith('{')) {
    if (now - asNumber > DEPLOY_INTENT_TTL_MS) return null;
    return { active: true, preDeployCommit: null, stampedAt: asNumber };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const stampedAt = typeof record.stampedAt === 'number' && Number.isFinite(record.stampedAt)
    ? record.stampedAt
    : null;
  if (stampedAt === null) return null;
  if (now - stampedAt > DEPLOY_INTENT_TTL_MS) return null;
  const preDeployCommit = typeof record.preDeployCommit === 'string' && record.preDeployCommit.length > 0
    ? record.preDeployCommit
    : null;
  return { active: true, preDeployCommit, stampedAt };
}

export function loadDeployIntent(now = Date.now()): DeployIntent | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(DEPLOY_INTENT_STORAGE_KEY);
    if (raw === null) return null;
    const intent = parseIntent(raw, now);
    if (!intent) {
      store.removeItem(DEPLOY_INTENT_STORAGE_KEY);
      return null;
    }
    return intent;
  } catch {
    return null;
  }
}

export function loadDeployIntentActive(now = Date.now()): boolean {
  return loadDeployIntent(now)?.active === true;
}

/**
 * Milliseconds until the sticky deploy window expires, or 0 when inactive/expired.
 * Used to schedule an in-tab clear so long-lived disconnected tabs still leave
 * the redeploy banner after the window (issue #1982 acceptance: timeout).
 */
export function deployIntentRemainingMs(now = Date.now()): number {
  const intent = loadDeployIntent(now);
  if (!intent) return 0;
  return Math.max(0, DEPLOY_INTENT_TTL_MS - (now - intent.stampedAt));
}

export function saveDeployIntent(
  deploying: boolean,
  options: { preDeployCommit?: string | null; now?: number } = {},
): void {
  const store = storage();
  if (!store) return;
  const now = options.now ?? Date.now();
  try {
    if (!deploying) {
      store.removeItem(DEPLOY_INTENT_STORAGE_KEY);
      return;
    }
    // Preserve existing preDeployCommit when re-asserting intent without a new value.
    const existing = loadDeployIntent(now);
    const preDeployCommit = options.preDeployCommit !== undefined
      ? (options.preDeployCommit && options.preDeployCommit.length > 0 ? options.preDeployCommit : null)
      : existing?.preDeployCommit ?? null;
    const payload: DeployIntent = {
      active: true,
      preDeployCommit,
      stampedAt: now,
    };
    store.setItem(DEPLOY_INTENT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // sessionStorage unavailable (private mode quota, SSR) — in-memory flag still works
  }
}
