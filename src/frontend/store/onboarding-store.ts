// External pub-sub store for the onboarding tour modal's open state.
// Read-side consumers use `useSyncExternalStore(subscribe, getSnapshot)` for
// React-18 tearing safety. Dispatch-only callers (e.g., the `?` Help dialog's
// "Take the product tour" CTA) call `open()` directly.

import { shouldShow as persistedShouldShow, markSeen } from './onboarding-status.js';

let openState = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSnapshot(): boolean {
  return openState;
}

export function open(): void {
  if (openState) return;
  openState = true;
  emit();
}

export function close(): void {
  if (!openState) return;
  openState = false;
  markSeen();
  emit();
}

/**
 * Open the tour exactly when persistence says it's a fresh first run.
 * Call once on App mount.
 */
export function maybeOpenForFirstRun(): void {
  if (persistedShouldShow()) open();
}

// Test-only helper for asserting subscriber counts. State reset across
// tests is handled by `vi.resetModules()`.
export const __test = {
  getListenerCount: () => listeners.size,
};
