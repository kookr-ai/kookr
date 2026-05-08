// Persistence for the first-run onboarding tour.
//
// Two-tier fallback: localStorage (preferred) → in-memory (when storage is
// denied or quota-exhausted). Storage tier is picked once at module load via
// the IIFE probe so reads and writes hit the same backend across the session.
//
// Version is encoded in the storage key suffix (`-v1`). A material rewrite
// of tour content bumps the suffix; no separate version field is read.

export const STORAGE_KEY = 'kookr:onboarding:seen-v1';

declare const __KOOKR_DISABLE_ONBOARDING__: string | undefined;

let inMemorySeen = false;

function pickStorage(): Storage | null {
  try {
    const probe = '__kookr_onboarding_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

const storage: Storage | null = pickStorage();

export function shouldShow(): boolean {
  if (isOnboardingDisabled()) return false;
  // In-memory wins as the "seen" sentinel even when localStorage is available,
  // because it's only set when a localStorage write failed — meaning storage
  // does not have the key but the user has actually seen the tour.
  if (inMemorySeen) return false;
  if (storage) return storage.getItem(STORAGE_KEY) !== 'true';
  return true;
}

export function markSeen(): void {
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, 'true');
    } catch {
      // Late quota-exhaustion: fall back to in-memory so close() still latches.
      inMemorySeen = true;
    }
  } else {
    inMemorySeen = true;
  }
}

export function reset(): void {
  if (storage) {
    try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
  inMemorySeen = false;
}

// Test-only helper. Live module state is otherwise opaque.
export const __test = {
  getInMemorySeen: () => inMemorySeen,
};

function isOnboardingDisabled(): boolean {
  if (
    typeof __KOOKR_DISABLE_ONBOARDING__ !== 'undefined'
    && __KOOKR_DISABLE_ONBOARDING__ === '1'
  ) {
    return true;
  }

  try {
    return new URLSearchParams(window.location.search).get('onboarding') === '0';
  } catch {
    return false;
  }
}
