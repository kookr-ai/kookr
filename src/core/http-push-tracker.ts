/**
 * HTTP push latency tracking for shadow detection.
 *
 * When hook events arrive via HTTP POST (fast path), this tracker records
 * the arrival timestamp. When the same event later arrives via the file
 * watcher (slow path), the latency delta is computed and logged to the
 * shadow detection log.
 *
 * In shadow mode, the HTTP endpoint does NOT trigger detection — it only
 * records timing. In active mode (future), it would call injectHookEvent()
 * and the file watcher would dedup.
 */

import { createHash } from 'node:crypto';
import type { ShadowDetectorRegistry, ShadowSource } from './shadow-detector.js';

/** How long to keep HTTP arrival timestamps before discarding (ms). */
const TTL_MS = 30_000;

interface HttpArrival {
  timestamp: number; // ms since epoch
  agentId: string;
}

/**
 * Tracks HTTP push arrivals and computes latency deltas when the file
 * watcher delivers the same event.
 */
export class HttpPushTracker {
  /** Map of event content hash -> HTTP arrival info */
  private arrivals = new Map<string, HttpArrival>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup of expired entries
    this.cleanupInterval = setInterval(() => this.cleanup(), TTL_MS);
  }

  /**
   * Record that an event arrived via HTTP POST.
   * Returns the content hash for correlation.
   */
  recordHttpArrival(agentId: string, rawJson: string): string {
    const hash = this.hashEvent(rawJson);
    this.arrivals.set(hash, {
      timestamp: Date.now(),
      agentId,
    });
    return hash;
  }

  /**
   * Check if an event was already delivered via HTTP.
   * Called by the file watcher path to compute latency delta.
   * Returns the latency delta in ms (positive = HTTP was faster), or null if not seen via HTTP.
   */
  checkAndComputeDelta(rawJson: string): { agentId: string; deltaMs: number } | null {
    const hash = this.hashEvent(rawJson);
    const arrival = this.arrivals.get(hash);
    if (!arrival) return null;

    const deltaMs = Date.now() - arrival.timestamp;
    this.arrivals.delete(hash); // Consume the entry
    return { agentId: arrival.agentId, deltaMs };
  }

  /**
   * Check if an event was already delivered via HTTP (for dedup in active mode).
   */
  hasHttpArrival(rawJson: string): boolean {
    return this.arrivals.has(this.hashEvent(rawJson));
  }

  /** Number of pending (unmatched) HTTP arrivals. */
  get pendingCount(): number {
    return this.arrivals.size;
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [hash, arrival] of this.arrivals) {
      if (arrival.timestamp < cutoff) {
        this.arrivals.delete(hash);
      }
    }
  }

  private hashEvent(rawJson: string): string {
    // Use a fast hash — we only need collision resistance within the 30s TTL window
    return createHash('md5').update(rawJson).digest('hex');
  }
}
