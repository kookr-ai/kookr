/**
 * Durable last-known-good ops card at `~/.kookr/ops-status.json` (issue #1995).
 *
 * When Discord (or any remote page channel) is down, operators still need a
 * single on-disk digest of ready/hung/starvation/safeMode for post-hoc
 * diagnosis. This module owns:
 *
 * - the v1 schema (read-only fields only — no secrets)
 * - pure builders + schema guard
 * - edge-triggered atomic writes (best-effort; disk-full is never fatal)
 *
 * Critical edges that update the file:
 * - ready degrade (`GET /api/ready` flips to not-ready)
 * - schedule dead-man fire
 * - pipeline starvation fire
 * - SAFE MODE engage
 * - prod smoke tick fire / clear (issue #2032)
 */

import { join } from 'node:path';

import { atomicWriteFile } from './persistence-utils.js';
import type { SafeModeStatus } from './automation-kill-switch.js';

export const OPS_STATUS_SCHEMA_VERSION = 'ops-status.v1' as const;
export const OPS_STATUS_FILE_NAME = 'ops-status.json';
export const OPS_STATUS_MAX_EDGES = 20;

/** Stable edge kinds that update the card. */
export type OpsStatusEdgeKind =
  | 'ready_degrade'
  | 'dead_man_fire'
  | 'starvation_fire'
  | 'safe_mode_engage'
  /** Hourly prod smoke tick entered a failing episode (issue #2032). */
  | 'smoke_tick_fire'
  /** Hourly prod smoke tick recovered after a failing episode (issue #2032). */
  | 'smoke_tick_clear';

export interface OpsStatusEdge {
  kind: OpsStatusEdgeKind;
  /** ISO-8601 timestamp the edge was recorded. */
  at: string;
  /** Short operator-facing note; never secrets. */
  detail?: string;
}

/**
 * On-disk card. Every field is operator-readable and free of credentials,
 * tokens, paths to private keys, or agent transcripts.
 */
export interface OpsStatusSnapshot {
  schemaVersion: typeof OPS_STATUS_SCHEMA_VERSION;
  /** ISO-8601 timestamp of the most recent write. */
  updatedAt: string;
  /** Serving git SHA (or null when unknown / dev). */
  sha: string | null;
  /** Current hungSuspect capacity count, or null when unavailable. */
  hungSuspectCount: number | null;
  /** Free space on the data directory, percent of capacity (0–100), or null. */
  dataDirectoryFreePercent: number | null;
  /** Free space on the data directory in bytes, or null. */
  dataDirectoryFreeBytes: number | null;
  /** Live SAFE MODE / automation kill-switch status. */
  safeMode: SafeModeStatus;
  /** Ring of recent critical edges (newest last). */
  lastEdges: OpsStatusEdge[];
}

/** Live fields sampled at write time (outside the pure edge ring). */
export interface OpsStatusLiveFields {
  sha: string | null;
  hungSuspectCount: number | null;
  dataDirectoryFreePercent: number | null;
  dataDirectoryFreeBytes: number | null;
  safeMode: SafeModeStatus;
}

const EDGE_KINDS: ReadonlySet<string> = new Set([
  'ready_degrade',
  'dead_man_fire',
  'starvation_fire',
  'safe_mode_engage',
  'smoke_tick_fire',
  'smoke_tick_clear',
]);

export function opsStatusPath(kookrDir: string): string {
  return join(kookrDir, OPS_STATUS_FILE_NAME);
}

/** Append one edge, keeping at most `maxEdges` (newest last). */
export function appendOpsStatusEdge(
  previous: readonly OpsStatusEdge[],
  edge: OpsStatusEdge,
  maxEdges: number = OPS_STATUS_MAX_EDGES,
): OpsStatusEdge[] {
  const cap = Number.isFinite(maxEdges) && maxEdges > 0 ? Math.floor(maxEdges) : OPS_STATUS_MAX_EDGES;
  const next = [...previous, edge];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Build a full snapshot from live fields + edge ring. */
export function buildOpsStatusSnapshot(
  fields: OpsStatusLiveFields,
  lastEdges: readonly OpsStatusEdge[],
  updatedAt: string,
): OpsStatusSnapshot {
  return {
    schemaVersion: OPS_STATUS_SCHEMA_VERSION,
    updatedAt,
    sha: fields.sha,
    hungSuspectCount: fields.hungSuspectCount,
    dataDirectoryFreePercent: fields.dataDirectoryFreePercent,
    dataDirectoryFreeBytes: fields.dataDirectoryFreeBytes,
    safeMode: fields.safeMode.engaged
      ? {
          engaged: true as const,
          ...(fields.safeMode.since ? { since: fields.safeMode.since } : {}),
          ...(fields.safeMode.loadError ? { loadError: fields.safeMode.loadError } : {}),
        }
      : { engaged: false },
    lastEdges: lastEdges.map((edge) => ({
      kind: edge.kind,
      at: edge.at,
      ...(edge.detail ? { detail: edge.detail } : {}),
    })),
  };
}

/**
 * Map an operational-alert transition to an ops-status edge kind.
 *
 * - schedule / pipeline starvation: fire only (recovery ignored so the card
 *   is not flapped by flapping monitors)
 * - prod smoke tick (`prod_smoke_tick`): fire → `smoke_tick_fire`, recover →
 *   `smoke_tick_clear` (issue #2032 — multi-day smoke false positives need a
 *   durable clear edge for offline diagnosis)
 * - other metrics / states: null
 */
export function opsStatusEdgeFromOperationalAlert(alert: {
  operationalAlert?: { metric?: string; state?: string; key?: string } | undefined;
  summary?: string;
}): { kind: OpsStatusEdgeKind; detail?: string } | null {
  const meta = alert.operationalAlert;
  if (!meta) return null;

  const metric = typeof meta.metric === 'string' ? meta.metric : '';
  const state = typeof meta.state === 'string' ? meta.state : '';
  let kind: OpsStatusEdgeKind | null = null;

  if (metric === 'prod_smoke_tick') {
    if (state === 'fired') kind = 'smoke_tick_fire';
    else if (state === 'recovered') kind = 'smoke_tick_clear';
  } else if (state === 'fired') {
    if (metric === 'schedule_starvation') kind = 'dead_man_fire';
    else if (metric === 'pipeline_starvation') kind = 'starvation_fire';
  }
  if (!kind) return null;

  const detail =
    typeof alert.summary === 'string' && alert.summary.trim().length > 0
      ? alert.summary.trim().slice(0, 240)
      : typeof meta.key === 'string' && meta.key.length > 0
        ? meta.key
        : undefined;
  return detail ? { kind, detail } : { kind };
}

/** Runtime schema guard for unit tests and defensive readers. */
export function isOpsStatusSnapshot(value: unknown): value is OpsStatusSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== OPS_STATUS_SCHEMA_VERSION) return false;
  if (typeof v.updatedAt !== 'string' || v.updatedAt.length === 0) return false;
  if (!(v.sha === null || typeof v.sha === 'string')) return false;
  if (!(v.hungSuspectCount === null || isNonNegInt(v.hungSuspectCount))) return false;
  if (!(v.dataDirectoryFreePercent === null || isFiniteNumber(v.dataDirectoryFreePercent))) return false;
  if (!(v.dataDirectoryFreeBytes === null || isNonNegInt(v.dataDirectoryFreeBytes))) return false;
  if (!isSafeModeShape(v.safeMode)) return false;
  if (!Array.isArray(v.lastEdges)) return false;
  for (const edge of v.lastEdges) {
    if (!isEdgeShape(edge)) return false;
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSafeModeShape(value: unknown): value is SafeModeStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.engaged !== 'boolean') return false;
  if (s.since !== undefined && typeof s.since !== 'string') return false;
  if (s.loadError !== undefined && typeof s.loadError !== 'string') return false;
  return true;
}

function isEdgeShape(value: unknown): value is OpsStatusEdge {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.kind !== 'string' || !EDGE_KINDS.has(e.kind)) return false;
  if (typeof e.at !== 'string' || e.at.length === 0) return false;
  if (e.detail !== undefined && typeof e.detail !== 'string') return false;
  return true;
}

export interface OpsStatusWriterDeps {
  /** Absolute path to ops-status.json. Prefer {@link opsStatusPath}. */
  filePath: string;
  /** Sample live fields at each write. Must not throw. */
  getLiveFields: () => OpsStatusLiveFields;
  now?: () => Date;
  /** Injected for tests; defaults to {@link atomicWriteFile}. */
  writeFileAtomically?: (filePath: string, data: string) => Promise<void>;
  logger?: Pick<typeof console, 'warn'>;
  maxEdges?: number;
}

/**
 * Edge-triggered writer. Keeps an in-memory edge ring so successive critical
 * edges accumulate (last N) rather than overwrite each other. Every write is
 * atomic (temp + fsync + rename) and best-effort: disk-full / permission
 * errors are logged and never rethrown.
 */
export class OpsStatusWriter {
  private readonly filePath: string;
  private readonly getLiveFields: () => OpsStatusLiveFields;
  private readonly now: () => Date;
  private readonly writeFileAtomically: (filePath: string, data: string) => Promise<void>;
  private readonly logger: Pick<typeof console, 'warn'>;
  private readonly maxEdges: number;
  private lastEdges: OpsStatusEdge[] = [];
  private lastWritten: OpsStatusSnapshot | null = null;
  /** Last observed ready verdict — used for ready true→false edge detection. */
  private lastReady: boolean | null = null;
  /** Last observed SAFE MODE engagement — used for false→true edge detection. */
  private lastSafeModeEngaged: boolean | null = null;
  /** Serialize concurrent edge notes so the ring stays ordered. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(deps: OpsStatusWriterDeps) {
    this.filePath = deps.filePath;
    this.getLiveFields = deps.getLiveFields;
    this.now = deps.now ?? (() => new Date());
    this.writeFileAtomically = deps.writeFileAtomically ?? atomicWriteFile;
    this.logger = deps.logger ?? console;
    this.maxEdges = deps.maxEdges ?? OPS_STATUS_MAX_EDGES;
  }

  /** Most recent successfully written snapshot (null until first success). */
  getLastWritten(): OpsStatusSnapshot | null {
    return this.lastWritten;
  }

  /**
   * Record a synthetic critical edge and rewrite the card.
   * Returns the snapshot on success, null when the write failed.
   */
  noteEdge(kind: OpsStatusEdgeKind, detail?: string): Promise<OpsStatusSnapshot | null> {
    const edge: OpsStatusEdge = {
      kind,
      at: this.now().toISOString(),
      ...(detail && detail.trim().length > 0 ? { detail: detail.trim().slice(0, 240) } : {}),
    };
    return this.enqueueWrite(edge);
  }

  /**
   * Observe a ready verdict. Writes only on the healthy→degraded edge
   * (true→false, or first observation of false). De-dupe state advances only
   * after a successful write so a disk-full blip still retries on the next poll.
   */
  async noteReadyVerdict(ready: boolean, detail?: string): Promise<OpsStatusSnapshot | null> {
    if (ready) {
      this.lastReady = true;
      return null;
    }
    // Already known-degraded (and previously recorded) → skip.
    if (this.lastReady === false) return null;
    const snap = await this.noteEdge('ready_degrade', detail);
    // Only lock de-dupe after the durable write lands; leave lastReady as the
    // previous healthy/null value so a failed write retries on the next poll.
    if (snap) this.lastReady = false;
    return snap;
  }

  /**
   * Observe SAFE MODE engagement. Writes only on the false→true edge.
   * De-dupe advances only after a successful write (same retry contract as
   * {@link noteReadyVerdict}).
   */
  async noteSafeModeEngaged(engaged: boolean, detail?: string): Promise<OpsStatusSnapshot | null> {
    if (!engaged) {
      this.lastSafeModeEngaged = false;
      return null;
    }
    if (this.lastSafeModeEngaged === true) return null;
    const snap = await this.noteEdge('safe_mode_engage', detail);
    if (snap) this.lastSafeModeEngaged = true;
    return snap;
  }

  /**
   * Observe an operational-alert message. Writes for dead-man / pipeline
   * starvation *fire* transitions and prod-smoke fire/clear (issue #2032);
   * other recovery transitions and non-critical metrics are ignored.
   */
  noteFromAlert(alert: {
    operationalAlert?: { metric?: string; state?: string; key?: string } | undefined;
    summary?: string;
  }): Promise<OpsStatusSnapshot | null> {
    const mapped = opsStatusEdgeFromOperationalAlert(alert);
    if (!mapped) return Promise.resolve(null);
    return this.noteEdge(mapped.kind, mapped.detail);
  }

  private enqueueWrite(edge: OpsStatusEdge): Promise<OpsStatusSnapshot | null> {
    const run = this.writeChain.then(() => this.writeEdge(edge));
    // Keep the chain alive even when a write fails so later edges still serialize.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeEdge(edge: OpsStatusEdge): Promise<OpsStatusSnapshot | null> {
    let fields: OpsStatusLiveFields;
    try {
      fields = this.getLiveFields();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ops-status] getLiveFields threw; writing with empty fields: ${message}`);
      fields = {
        sha: null,
        hungSuspectCount: null,
        dataDirectoryFreePercent: null,
        dataDirectoryFreeBytes: null,
        safeMode: { engaged: false },
      };
    }

    const lastEdges = appendOpsStatusEdge(this.lastEdges, edge, this.maxEdges);
    const snapshot = buildOpsStatusSnapshot(fields, lastEdges, edge.at);

    try {
      // Compact JSON: edge-triggered critical writes serialize on the event loop;
      // the card is machine-read via `kookr status` / files, not hand-edited (#2253).
      await this.writeFileAtomically(this.filePath, `${JSON.stringify(snapshot)}\n`);
      this.lastEdges = lastEdges;
      this.lastWritten = snapshot;
      return snapshot;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ops-status] atomic write failed (best-effort): ${message}`);
      return null;
    }
  }
}
