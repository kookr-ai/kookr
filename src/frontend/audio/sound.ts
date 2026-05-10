import { isDndEnabled } from '../hooks/useDnd.js';

const STORAGE_KEY = 'kookr-sound-enabled';

/** Read mute preference from localStorage (default: enabled). */
export function isSoundEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

/** Persist mute preference. */
export function setSoundEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

let warnedRejection = false;

/**
 * Play a short two-tone chime via Web Audio API.
 *
 * Module-private — production callers use maybePlayChime so mute/DND gates
 * are applied uniformly. Tests reach the audio path via maybePlayChime()
 * with cleared mute/DND preconditions.
 *
 * Gracefully handles browsers that block AudioContext before user
 * interaction; emits a one-time console.warn so silent failure is
 * diagnosable from devtools.
 */
function playChime(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // First tone: A5 (880 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.frequency.value = 880;
    osc1.type = 'sine';
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.start(now);
    osc1.stop(now + 0.3);

    // Second tone: C#6 (1109 Hz) — rising interval for urgency
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.frequency.value = 1109;
    osc2.type = 'sine';
    gain2.gain.setValueAtTime(0.25, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.5);

    setTimeout(() => void ctx.close(), 600);
  } catch (err) {
    if (!warnedRejection) {
      warnedRejection = true;
      console.warn('[kookr] AudioContext rejected; chime suppressed', err);
    }
  }
}

/**
 * Single public production entry point for the chime. Returns early on
 * mute or DND. The gate is owned here so that hook call sites do not need
 * to duplicate `isSoundEnabled() && !isDndEnabled()` inline.
 */
export function maybePlayChime(): void {
  if (!isSoundEnabled() || isDndEnabled()) return;
  playChime();
}
