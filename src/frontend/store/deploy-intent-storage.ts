/**
 * Sticky deploy-intent flag for the dashboard connection banner.
 *
 * Survives the intentional WebSocket blackout during `prod:update` even if
 * in-memory store state is reset mid-deploy (process death / remount). Cleared
 * when deploy completes or after a short TTL so a stale flag cannot linger.
 */

const DEPLOY_INTENT_STORAGE_KEY = 'kookr.deploying';

/** How long a deploy intent stays sticky after the last set(true). Deploys are seconds; TTL is generous. */
const DEPLOY_INTENT_TTL_MS = 5 * 60 * 1000;

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function loadDeployIntent(now = Date.now()): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const raw = store.getItem(DEPLOY_INTENT_STORAGE_KEY);
    if (raw === null) return false;
    const stampedAt = Number(raw);
    if (!Number.isFinite(stampedAt)) {
      store.removeItem(DEPLOY_INTENT_STORAGE_KEY);
      return false;
    }
    if (now - stampedAt > DEPLOY_INTENT_TTL_MS) {
      store.removeItem(DEPLOY_INTENT_STORAGE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function saveDeployIntent(deploying: boolean, now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    if (deploying) {
      store.setItem(DEPLOY_INTENT_STORAGE_KEY, String(now));
    } else {
      store.removeItem(DEPLOY_INTENT_STORAGE_KEY);
    }
  } catch {
    // sessionStorage unavailable (private mode quota, SSR) — in-memory flag still works
  }
}
