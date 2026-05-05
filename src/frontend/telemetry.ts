import type { TelemetryEventType } from '../shared/protocol.js';

// --- Platform detection ---

function detectPlatform(): 'linux' | 'darwin' | 'wsl2' | 'unknown' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'darwin';
  if (ua.includes('linux')) {
    // WSL2 user-agents still show "Linux" — we can't distinguish reliably from browser UA alone.
    // The server can override this via the snapshot message if needed.
    return 'linux';
  }
  return 'unknown';
}

const platform = detectPlatform();

// --- Telemetry buffer and flush ---

interface TelemetryPayload {
  type: TelemetryEventType;
  [key: string]: unknown;
}

interface FullTelemetryEvent extends TelemetryPayload {
  timestamp: string;
  sessionId: string;
  platform: string;
}

let sendFn: ((msg: { type: 'telemetry'; events: FullTelemetryEvent[] }) => void) | null = null;
let sessionId = '';
const buffer: FullTelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 20;

function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);
  flushTimer = null;
  sendFn?.({ type: 'telemetry', events: batch });
}

function scheduleFlush() {
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

/**
 * Track a telemetry event. Fire-and-forget — never blocks the UI.
 */
export function track(event: TelemetryPayload): void {
  buffer.push({
    ...event,
    timestamp: new Date().toISOString(),
    sessionId,
    platform,
  });
  if (buffer.length >= FLUSH_BATCH_SIZE) {
    flush();
  } else {
    scheduleFlush();
  }
}

/**
 * Initialize telemetry with the WebSocket send function.
 * Call this once when the WebSocket connects.
 */
export function initTelemetry(
  send: (msg: { type: 'telemetry'; events: FullTelemetryEvent[] }) => void,
  sid: string,
): void {
  sendFn = send;
  sessionId = sid;
}

/**
 * Flush any buffered events immediately. Call on page unload.
 */
export function flushTelemetry(): void {
  flush();
}

// --- Rapid repeat click detection ---

const lastClicks = new Map<string, { count: number; firstTimestamp: number }>();
const RAPID_CLICK_WINDOW_MS = 1000;
const RAPID_CLICK_THRESHOLD = 3;

/**
 * Track a click and detect rapid repeated clicks (frustration signal).
 * Returns true if a rapid_repeat_click event was emitted.
 */
export function trackClick(target: string, extraFields?: Record<string, unknown>): boolean {
  const now = Date.now();
  const prev = lastClicks.get(target);

  if (prev && now - prev.firstTimestamp < RAPID_CLICK_WINDOW_MS) {
    prev.count++;
    if (prev.count === RAPID_CLICK_THRESHOLD) {
      track({
        type: 'rapid_repeat_click',
        target,
        clickCount: prev.count,
        windowMs: now - prev.firstTimestamp,
        ...extraFields,
      });
      return true;
    }
  } else {
    lastClicks.set(target, { count: 1, firstTimestamp: now });
  }

  return false;
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushTelemetry);
}
