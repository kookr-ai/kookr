/**
 * Persists the last effort and model pins sent from dashboard Launch /
 * Quick Launch (#2616). Separate keys so a write to one cannot clobber
 * a newer edit of the other.
 *
 * Empty means "Agent default": a successful launch that omitted a pin
 * clears that key so the next open stays on the default.
 */
export const LAST_EFFORT_KEY = 'kookr:lastEffort';
export const LAST_MODEL_KEY = 'kookr:lastModel';

function loadPin(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    const trimmed = raw?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function savePin(key: string, value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(key, trimmed);
    else localStorage.removeItem(key);
  } catch {
    // Quota exceeded / private browsing — silently ignore.
  }
}

export function loadLastEffort(): string | null {
  return loadPin(LAST_EFFORT_KEY);
}

export function loadLastModel(): string | null {
  return loadPin(LAST_MODEL_KEY);
}

export function saveLastEffort(value: string): void {
  savePin(LAST_EFFORT_KEY, value);
}

export function saveLastModel(value: string): void {
  savePin(LAST_MODEL_KEY, value);
}

/** Write the pins that a successful launch actually sent. */
export function saveLastLaunchPins(effort: string, model: string): void {
  saveLastEffort(effort);
  saveLastModel(model);
}
