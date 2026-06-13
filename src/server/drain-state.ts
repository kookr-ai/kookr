import type { DrainStatusSnapshot } from '../shared/contracts/messages.js';

/**
 * In-memory operator drain state (issue #659).
 *
 * When draining, the server refuses *new* task launches (the launch path throws
 * {@link DrainModeError}, surfaced as HTTP 503) while already-running agents and
 * in-flight work continue to completion. This lets an operator cordon a node for
 * maintenance or restart without killing live agent sessions.
 *
 * Intentionally NOT persisted: a restarted node always comes back accepting, so
 * an operator never has to remember to undo a drain after a crash or redeploy.
 */
export type DrainStatus = DrainStatusSnapshot;

export class DrainController {
  private draining = false;
  private since: string | undefined;

  isAccepting(): boolean {
    return !this.draining;
  }

  /** Enter drain mode. Returns true if the state changed (was accepting). */
  drain(now: Date = new Date()): boolean {
    if (this.draining) return false;
    this.draining = true;
    this.since = now.toISOString();
    return true;
  }

  /** Leave drain mode. Returns true if the state changed (was draining). */
  resume(): boolean {
    if (!this.draining) return false;
    this.draining = false;
    this.since = undefined;
    return true;
  }

  status(): DrainStatus {
    return {
      accepting: !this.draining,
      draining: this.draining,
      ...(this.since ? { since: this.since } : {}),
    };
  }
}
