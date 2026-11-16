/**
 * Whether Enter, pressed in a task's terminal with nothing typed, moves to the
 * next task. On by default.
 *
 * Turning it off sends every terminal Enter to the agent, so a selection menu
 * the screen check fails to recognize can never be skipped by mistake (#3568).
 * Navigation stays available through the dedicated next-task and next-finding
 * shortcuts. The reply box and the dashboard-wide Enter are not affected.
 *
 * This is a per-browser preference, like the other keyboard and layout
 * preferences kept in localStorage: it changes how this keyboard behaves, and
 * the settings toggle and the terminal see the change at once without a server
 * round trip. Reads are fail-soft: anything but the stored string "false"
 * means on.
 */
import { useSyncExternalStore } from 'react';

export const TERMINAL_EMPTY_ENTER_ADVANCE_KEY = 'kookr:terminalEmptyEnterAdvance';

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): boolean {
  return raw !== 'false';
}

function load(): boolean {
  try {
    return parse(getStorage()?.getItem(TERMINAL_EMPTY_ENTER_ADVANCE_KEY) ?? null);
  } catch {
    return true;
  }
}

let enabled = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Another tab changed the preference: follow it.
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== TERMINAL_EMPTY_ENTER_ADVANCE_KEY) return;
    enabled = parse(event.newValue);
    emit();
  });
}

export function getTerminalEmptyEnterAdvance(): boolean {
  return enabled;
}

export function setTerminalEmptyEnterAdvance(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    getStorage()?.setItem(TERMINAL_EMPTY_ENTER_ADVANCE_KEY, String(next));
  } catch {
    // Storage refused: the choice still holds for this page load.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding: re-renders when the preference changes in this tab or another one. */
export function useTerminalEmptyEnterAdvance(): boolean {
  return useSyncExternalStore(subscribe, getTerminalEmptyEnterAdvance, () => true);
}

export function __resetTerminalEmptyEnterAdvanceForTests(): void {
  enabled = load();
  listeners.clear();
}
