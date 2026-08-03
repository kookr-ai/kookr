/**
 * Sticky deploy-intent flag for the dashboard connection banner.
 *
 * Survives the intentional WebSocket blackout during `prod:update` even if
 * in-memory store state is reset mid-deploy (process death / remount). Cleared
 * when deploy completes or after a short TTL so a stale flag cannot linger.
 *
 * Also persists the pre-deploy build short-hash so TopBar can clear the flag
 * after remount once a *different* buildInfo arrives (the in-memory ref alone
 * would be lost on refresh).
 */

const DEPLOY_INTENT_STORAGE_KEY = 'kookr.deploying';

/** How long a deploy intent stays sticky after the last set(true). Deploys are seconds; TTL is generous. */
export const DEPLOY_INTENT_TTL_MS = 5 * 60 * 1000;

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
