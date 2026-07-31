/**
 * Startup-phase readiness gate (issue #1721).
 *
 * The production server historically bound its HTTP listener only after full
 * recovery (task load, session reattach, hook-event replay) — measured at
 * ~10.5 min on a 727-task instance. That left the deploy gate and any
 * operator curl unable to distinguish "starting normally" from "wedged", and
 * left the dashboard dark for the entire recovery window.
 *
 * With listen-early boot, the HTTP/WS listener binds before heavy recovery.
 * This gate is the critical `/api/ready` check that stays 503/`starting`
 * until resume/reattach completes, and surfaces per-phase progress on both
 * `/api/ready` and `/api/health`.
 */

export type StartupPhase = 'initializing' | 'listening' | 'recovering' | 'ready';

export interface StartupProgress {
  phase: StartupPhase;
  /** Short operator-facing description of the current step. */
  detail: string;
  startedAt: string;
  listeningAt?: string;
  readyAt?: string;
}

/** Shape consumed by GET /api/ready (mirrors diagnostics-routes ReadinessCheck). */
export interface StartupReadinessCheck {
  critical: true;
  ready: boolean;
  status: StartupPhase;
  reason?: string;
  detail?: string;
}

export class StartupReadiness {
  private phase: StartupPhase = 'initializing';
  private detail = 'bootstrapping';
  private readonly startedAt: string;
  private listeningAt: string | undefined;
  private readyAt: string | undefined;

  constructor(startedAt: string = new Date().toISOString()) {
    this.startedAt = startedAt;
  }

  /** HTTP listener is bound; recovery has not finished. */
  markListening(detail = 'HTTP listener bound; recovery pending'): void {
    if (this.phase === 'ready') return;
    this.phase = 'listening';
    this.detail = detail;
    this.listeningAt ??= new Date().toISOString();
  }

  /** Heavy recovery (reattach / hook replay / crash relaunch) is in flight. */
  markRecovering(detail: string): void {
    if (this.phase === 'ready') return;
    this.phase = 'recovering';
    this.detail = detail;
    this.listeningAt ??= new Date().toISOString();
  }

  /** Recovery finished; the process is ready for new work. */
  markReady(detail = 'startup complete'): void {
    this.phase = 'ready';
    this.detail = detail;
    this.listeningAt ??= new Date().toISOString();
    this.readyAt ??= new Date().toISOString();
  }

  getPhase(): StartupPhase {
    return this.phase;
  }

  getProgress(): StartupProgress {
    return {
      phase: this.phase,
      detail: this.detail,
      startedAt: this.startedAt,
      ...(this.listeningAt ? { listeningAt: this.listeningAt } : {}),
      ...(this.readyAt ? { readyAt: this.readyAt } : {}),
    };
  }

  toReadinessCheck(): StartupReadinessCheck {
    if (this.phase === 'ready') {
      return { critical: true, ready: true, status: 'ready' };
    }
    return {
      critical: true,
      ready: false,
      status: this.phase,
      reason: 'startup-in-progress',
      detail: this.detail,
    };
  }
}
