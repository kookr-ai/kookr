// Persistence for the one-time "where your scheduled tasks live" hint.
//
// Shown once after a user creates a schedule from the task-panel schedule
// button, pointing at the command-palette trigger so they know where to find
// the Schedules action next time. Mirrors `onboarding-status.ts`: a two-tier
// localStorage → in-memory fallback, with the tier picked once at module load
// so reads and writes hit the same backend across the session.
//
// Version is encoded in the storage key suffix (`-v1`). A material change to
// the hint bumps the suffix; no separate version field is read.

export const STORAGE_KEY = 'kookr:hint:scheduledTasks-v1';

let inMemoryDismissed = false;

function pickStorage(): Storage | null {
  try {
    const probe = '__kookr_sched_hint_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

const storage: Storage | null = pickStorage();

/** True unless the user has permanently dismissed the hint. */
export function shouldShow(): boolean {
  // In-memory wins as the "dismissed" sentinel even when localStorage is
  // available, because it's only set when a localStorage write failed.
  if (inMemoryDismissed) return false;
  if (storage) return storage.getItem(STORAGE_KEY) !== 'true';
  return true;
}

/** "Don't show again" — persists so the hint never reappears. */
export function markPermanentlyDismissed(): void {
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, 'true');
    } catch {
      inMemoryDismissed = true;
    }
  } else {
    inMemoryDismissed = true;
  }
}

export function reset(): void {
  if (storage) {
    try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
  inMemoryDismissed = false;
}

// Test-only helper. Live module state is otherwise opaque.
export const __test = {
  getInMemoryDismissed: () => inMemoryDismissed,
};
