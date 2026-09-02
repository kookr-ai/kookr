import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Persisted clean-shutdown marker + dirty-boot classification (issue #2790).
 *
 * Remote operators can see `serverStartedAt` and the crash-recovery summary,
 * but nothing tells them whether the *previous* process exited cleanly or was
 * killed by a crash / OOM / SIGKILL. This module closes that gap with one small
 * on-disk marker file:
 *
 * - At boot, {@link BootMarkerStore.recordBoot} reads the marker the previous
 *   process left behind, classifies this boot from its `state`, then overwrites
 *   the file with a fresh `running` marker for *this* process. The
 *   classification is computed once, before startup recovery runs, and is
 *   immutable for the life of the process.
 * - On a graceful SIGTERM/SIGINT, {@link BootMarkerStore.recordCleanShutdown}
 *   flips the marker to `state: "clean"`. A process that dies without running
 *   that path leaves the marker at `running`, so the *next* boot reads
 *   `running` and classifies itself `dirty`.
 *
 * Classification meaning:
 * - `clean`   — the previous process wrote a `clean` marker (graceful restart).
 * - `dirty`   — the previous marker is still `running` (crash / OOM / SIGKILL).
 * - `unknown` — no marker (first boot / wiped state dir) or an unreadable one.
 *
 * Guarantees mirror the other operational snapshots (see last-good-health.ts):
 * - **Atomic + rotate-by-overwrite**: temp file + rename, so a crash mid-write
 *   cannot truncate the live marker.
 * - **Owner-only**: written at mode `0o600`.
 * - **Never throws**: both entry points swallow every error — a read-only or
 *   broken state dir degrades classification to `unknown`, it never crashes the
 *   boot path or the shutdown path.
 * - **Bounded + secret-free**: the file holds only timestamps, a pid, a random
 *   boot id, and a signal name. No prompt contents, no history, no credentials.
 */

export const BOOT_MARKER_FILE = 'boot-marker.json';
export const BOOT_MARKER_SCHEMA_VERSION = 'boot-marker.v1';

/** Owner-read/write only. Matches settings.json and other operational snapshots. */
export const BOOT_MARKER_FILE_MODE = 0o600;

/** Lifecycle state persisted in the marker. */
export type BootMarkerState = 'running' | 'clean';

/** On-disk marker shape. */
export interface BootMarkerFile {
  schemaVersion: typeof BOOT_MARKER_SCHEMA_VERSION;
  state: BootMarkerState;
  /** Random id for this boot, so log lines can be correlated across a restart. */
  bootId: string;
  /** ISO timestamp this process wrote its `running` marker. */
  startedAt: string;
  /** Owning process id. */
  pid: number;
  /** ISO timestamp of the graceful shutdown — only present when `state === "clean"`. */
  shutdownAt?: string;
  /** Signal that triggered the graceful shutdown (e.g. `SIGTERM`) — `clean` only. */
  signal?: string;
}

/** High-level verdict for a fresh boot, projected onto the health surface. */
export type BootStatus = 'clean' | 'dirty' | 'unknown';

export type BootReason =
  | 'clean_shutdown'
  | 'unclean_exit'
  | 'no_prior_marker'
  | 'marker_unreadable';

/**
 * Immutable classification of the current boot relative to the previous
 * process. Deterministic, bounded, secret-free — safe to project verbatim onto
 * `/api/health`.
 */
export interface BootClassification {
  status: BootStatus;
  reason: BootReason;
  /** When the previous process started, if a well-formed marker was found. */
  previousStartedAt: string | null;
  /** When the previous process shut down cleanly, if it did. */
  previousShutdownAt: string | null;
  /** The signal that triggered the previous clean shutdown, if any. */
  previousSignal: string | null;
}

export function bootMarkerPath(kookrDir: string): string {
  return join(kookrDir, BOOT_MARKER_FILE);
}

/** Narrow unknown JSON to a well-formed marker, or null. */
export function parseBootMarker(raw: unknown): BootMarkerFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion !== BOOT_MARKER_SCHEMA_VERSION) return null;
  if (m.state !== 'running' && m.state !== 'clean') return null;
  if (typeof m.startedAt !== 'string' || typeof m.bootId !== 'string') return null;
  if (typeof m.pid !== 'number') return null;
  const parsed: BootMarkerFile = {
    schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
    state: m.state,
    bootId: m.bootId,
    startedAt: m.startedAt,
    pid: m.pid,
  };
  if (typeof m.shutdownAt === 'string') parsed.shutdownAt = m.shutdownAt;
  if (typeof m.signal === 'string') parsed.signal = m.signal;
  return parsed;
}

/**
 * Read the previous marker (if any) from disk.
 *
 * Returns `{ marker }` on a well-formed read, `{ marker: null, unreadable }`
 * to distinguish "no file" (`unreadable: false`) from "file present but
 * corrupt/unknown-schema" (`unreadable: true`) — the two map to different boot
 * reasons. Never throws.
 */
export function readBootMarker(kookrDir: string): { marker: BootMarkerFile | null; unreadable: boolean } {
  const filePath = bootMarkerPath(kookrDir);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    // Absent file (first boot / wiped state dir) — not an error.
    return { marker: null, unreadable: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { marker: null, unreadable: true };
  }
  const marker = parseBootMarker(parsed);
  return { marker, unreadable: marker === null };
}

/**
 * Classify a boot from the previous process's marker. Pure — the caller
 * supplies the read result so this is trivially testable.
 */
export function classifyBoot(previous: {
  marker: BootMarkerFile | null;
  unreadable: boolean;
}): BootClassification {
  if (previous.marker === null) {
    return {
      status: 'unknown',
      reason: previous.unreadable ? 'marker_unreadable' : 'no_prior_marker',
      previousStartedAt: null,
      previousShutdownAt: null,
      previousSignal: null,
    };
  }
  const m = previous.marker;
  if (m.state === 'clean') {
    return {
      status: 'clean',
      reason: 'clean_shutdown',
      previousStartedAt: m.startedAt,
      previousShutdownAt: m.shutdownAt ?? null,
      previousSignal: m.signal ?? null,
    };
  }
  // state === 'running': the previous process never reached its graceful path.
  return {
    status: 'dirty',
    reason: 'unclean_exit',
    previousStartedAt: m.startedAt,
    previousShutdownAt: null,
    previousSignal: null,
  };
}

export interface BootMarkerStoreOptions {
  kookrDir: string;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable pid. Defaults to `process.pid`. */
  pid?: number;
  /** Injectable id generator. Defaults to `crypto.randomUUID`. */
  bootId?: () => string;
}

export class BootMarkerStore {
  private readonly kookrDir: string;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly newBootId: () => string;
  /** This process's marker, kept in memory so recordCleanShutdown needs no re-read. */
  private current: BootMarkerFile | null = null;

  constructor(opts: BootMarkerStoreOptions) {
    this.kookrDir = opts.kookrDir;
    this.filePath = bootMarkerPath(opts.kookrDir);
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
    this.newBootId = opts.bootId ?? (() => randomUUID());
  }

  /**
   * Classify this boot from the previous process's marker, then persist a fresh
   * `running` marker for this process. Called once, at boot, before startup
   * recovery. Never throws — a persistence failure still returns a real
   * classification (or `unknown`) so boot proceeds.
   */
  recordBoot(): BootClassification {
    const previous = readBootMarker(this.kookrDir);
    const classification = classifyBoot(previous);
    const marker: BootMarkerFile = {
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'running',
      bootId: this.newBootId(),
      startedAt: new Date(this.now()).toISOString(),
      pid: this.pid,
    };
    this.current = marker;
    this.writeAtomic(marker);
    return classification;
  }

  /**
   * Flip this process's marker to `clean` so the next boot classifies as a
   * graceful restart. Fire-and-forget from the shutdown handler — never throws.
   */
  recordCleanShutdown(signal: string): void {
    const base: BootMarkerFile = this.current ?? {
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'running',
      bootId: this.newBootId(),
      startedAt: new Date(this.now()).toISOString(),
      pid: this.pid,
    };
    const marker: BootMarkerFile = {
      ...base,
      state: 'clean',
      shutdownAt: new Date(this.now()).toISOString(),
      signal,
    };
    this.current = marker;
    this.writeAtomic(marker);
  }

  private writeAtomic(marker: BootMarkerFile): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const text = `${JSON.stringify(marker)}\n`;
      const tmp = `${this.filePath}.tmp-${this.pid}`;
      let renamed = false;
      try {
        writeFileSync(tmp, text, { encoding: 'utf8', mode: BOOT_MARKER_FILE_MODE });
        try {
          chmodSync(tmp, BOOT_MARKER_FILE_MODE);
        } catch {
          // Best-effort: create mode already requested 0o600.
        }
        renameSync(tmp, this.filePath);
        renamed = true;
      } finally {
        if (!renamed) {
          try { unlinkSync(tmp); } catch { /* Best-effort temp cleanup. */ }
        }
      }
      try {
        chmodSync(this.filePath, BOOT_MARKER_FILE_MODE);
      } catch {
        // Best-effort: content is already durable.
      }
    } catch {
      // A read-only or broken state dir must never crash boot or shutdown.
    }
  }
}
