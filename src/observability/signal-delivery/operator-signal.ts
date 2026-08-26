/**
 * Operator-signal outbox — the durable spool the delivery bridge tails (issue #1716).
 *
 * kookr has plenty of *detection* (deploy-lag alerts, prod-smoke probes,
 * gate/ledger liveness) but no *delivery*: alert-worthy conditions produced
 * zero operator-visible notifications for a full day. This module is the write
 * side of the fix — emitters drop one JSON file per signal into a user-scoped
 * directory (`~/.kookr/playbook-state/operator-signals/`), and a background
 * {@link ../service.ts SignalDeliveryService} pushes new files to Discord /
 * Telegram.
 *
 * Design notes:
 *  - **One file per signal**, named from the signal `key`. A key is stable and
 *    unique per logical event (e.g. `deploy-lag:alert`), so re-emitting the same
 *    condition overwrites in place rather than piling up duplicates.
 *  - **Delivery dedup is by file name**, tracked in a sibling `.delivered.json`
 *    marker so a daemon restart never re-posts an already-delivered signal.
 *  - Same trust boundary as the agent signal-outbox (#1541): user-scoped, no
 *    secrets, best-effort durability.
 */

import { mkdir, readFile, readdir, unlink, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OPERATOR_SIGNAL_SCHEMA = 'operator-signal.v1' as const;
export const OPERATOR_SIGNAL_DIR_REL = join('playbook-state', 'operator-signals');
/** Delivery-side marker of file names already pushed to a channel. */
export const DELIVERED_MARKER_FILE = '.delivered.json';

/** `alert` fires a problem, `clear` resolves it, `info` is a one-shot notice. */
export type OperatorSignalKind = 'alert' | 'clear' | 'info';

export interface OperatorSignal {
  schemaVersion: typeof OPERATOR_SIGNAL_SCHEMA;
  /**
   * Stable, unique identity for this logical signal. Re-emitting the same key
   * overwrites the spooled file (idempotent). Used verbatim (sanitized) as the
   * on-disk file name and as the delivery dedup key.
   */
  key: string;
  kind: OperatorSignalKind;
  /** Where the signal came from, e.g. `deploy-lag`, `prod-smoke`, `liveness`. */
  source: string;
  /** One-line human summary shown in the notification. */
  title: string;
  /** Optional longer body (multi-line allowed). */
  detail?: string;
  /** ISO timestamp the signal was emitted. */
  createdAt: string;
}

export interface DeliveredMarker {
  /**
   * file name → the `createdAt` of the signal occurrence last delivered for
   * that file. Comparing against the current file's `createdAt` lets a re-emit
   * (same key, overwritten file, fresh `createdAt`) re-deliver while a restart
   * with an unchanged file stays deduped.
   */
  [fileName: string]: string;
}

/** Resolve the operator-signal spool dir, honoring an env override. */
export function defaultOperatorSignalDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KOOKR_OPERATOR_SIGNAL_DIR?.trim();
  if (override) return override;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.kookr', OPERATOR_SIGNAL_DIR_REL);
}

/**
 * Map an arbitrary signal key to a safe, collision-resistant file base name.
 * Keeps `[a-z0-9._-]`, lowercases, and collapses everything else to `-`. The
 * mapping is deterministic so the same key always lands on the same file.
 */
export function signalFileName(key: string): string {
  const base = key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '') // no leading dot: signal files must not look like dotfiles/markers
    .slice(0, 120);
  return `${base || 'signal'}.json`;
}

export interface WriteOperatorSignalInput {
  key: string;
  kind: OperatorSignalKind;
  source: string;
  title: string;
  detail?: string;
  createdAt?: string;
}

export interface WriteOperatorSignalResult {
  fileName: string;
  path: string;
  signal: OperatorSignal;
}

/**
 * Write (or overwrite) one signal file into the outbox. Atomic via
 * write-temp-then-rename so a concurrent reader never sees a half-written file.
 */
export async function writeOperatorSignal(
  dir: string,
  input: WriteOperatorSignalInput,
  now: () => Date = () => new Date(),
): Promise<WriteOperatorSignalResult> {
  await mkdir(dir, { recursive: true });
  const signal: OperatorSignal = {
    schemaVersion: OPERATOR_SIGNAL_SCHEMA,
    key: input.key,
    kind: input.kind,
    source: input.source,
    title: input.title,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    createdAt: input.createdAt ?? now().toISOString(),
  };
  const fileName = signalFileName(input.key);
  const path = join(dir, fileName);
  const tmp = `${path}.tmp-${Math.abs(hashString(signal.createdAt + fileName))}`;
  let renamed = false;
  try {
    await writeFile(tmp, JSON.stringify(signal, null, 2), 'utf8');
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try { await unlink(tmp); } catch { /* best-effort temp cleanup */ }
    }
  }
  return { fileName, path, signal };
}

/** List signal file names (sorted), excluding markers and temp files. */
export async function listSignalFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !name.startsWith('.')) // markers + emitter state are dotfiles
    .filter((name) => !name.includes('.tmp-'))
    .sort();
}

/** Read and parse one signal file; returns null on missing/invalid content. */
export async function readSignal(dir: string, fileName: string): Promise<OperatorSignal | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, fileName), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as OperatorSignal;
    if (parsed?.schemaVersion !== OPERATOR_SIGNAL_SCHEMA || typeof parsed.key !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Load the delivered marker; returns {} when absent or corrupt. */
export async function loadDeliveredMarker(dir: string): Promise<DeliveredMarker> {
  let raw: string;
  try {
    raw = await readFile(join(dir, DELIVERED_MARKER_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as DeliveredMarker;
    }
    return {};
  } catch {
    return {};
  }
}

/** Persist the delivered marker atomically. */
export async function saveDeliveredMarker(dir: string, marker: DeliveredMarker): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, DELIVERED_MARKER_FILE);
  const tmp = `${path}.tmp-write`;
  let renamed = false;
  try {
    await writeFile(tmp, JSON.stringify(marker, null, 2), 'utf8');
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try { await unlink(tmp); } catch { /* best-effort temp cleanup */ }
    }
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}
