/**
 * AutoUpdateStore — the single Kookr-owned persistence for Layer-4 auto-update
 * state (RFC Layer 4 / R6): per-plugin policy, the last-observed installed
 * version (external-change baseline), persistent banners, and retained
 * pre-update snapshot metadata. ONE versioned JSON file under the Kookr data dir
 * (`<kookrDir>/plugin-auto-update.json`), same shape discipline as
 * `LoadoutStore` / `ConfigEpochStore`.
 *
 * Reads are malformed-tolerant: a missing or unparseable file resolves to empty,
 * never throws (an auto-update store that 500s must not be able to block a spawn
 * or the fleet view). Writes are read-modify-write with an atomic replace.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../core/persistence-utils.js';
import {
  AUTO_UPDATE_POLICIES,
  DEFAULT_AUTO_UPDATE_POLICY,
  type AutoUpdateBanner,
  type AutoUpdatePolicy,
  type AutoUpdateSnapshotMeta,
  type AutoUpdateStoreData,
} from '../../shared/contracts/plugins.js';

export const AUTO_UPDATE_STORE_FILENAME = 'plugin-auto-update.json';
export const AUTO_UPDATE_STORE_VERSION = 1;

function emptyData(): AutoUpdateStoreData {
  return {
    version: AUTO_UPDATE_STORE_VERSION,
    policies: {},
    observed: {},
    banners: {},
    snapshots: {},
    autoUpdateOwnership: {},
  };
}

function isPolicy(value: unknown): value is AutoUpdatePolicy {
  return typeof value === 'string' && (AUTO_UPDATE_POLICIES as readonly string[]).includes(value);
}

function coerceBanner(value: unknown): AutoUpdateBanner | null {
  if (typeof value !== 'object' || value === null) return null;
  const b = value as Record<string, unknown>;
  if (typeof b.pluginId !== 'string') return null;
  if (b.kind !== 'verify-failed' && b.kind !== 'rollback-failed' && b.kind !== 'post-session') return null;
  if (typeof b.message !== 'string' || typeof b.raisedAt !== 'string') return null;
  return {
    pluginId: b.pluginId,
    kind: b.kind,
    message: b.message,
    raisedAt: b.raisedAt,
    ...(typeof b.snapshotPath === 'string' ? { snapshotPath: b.snapshotPath } : {}),
  };
}

function coerceSnapshot(value: unknown): AutoUpdateSnapshotMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.pluginId !== 'string' ||
    typeof s.installPath !== 'string' ||
    typeof s.snapshotPath !== 'string' ||
    typeof s.takenAt !== 'string' ||
    typeof s.retainUntil !== 'string'
  ) {
    return null;
  }
  return {
    pluginId: s.pluginId,
    installPath: s.installPath,
    snapshotPath: s.snapshotPath,
    fromVersion: typeof s.fromVersion === 'string' ? s.fromVersion : null,
    takenAt: s.takenAt,
    retainUntil: s.retainUntil,
  };
}

function coerceData(parsed: unknown): AutoUpdateStoreData {
  if (typeof parsed !== 'object' || parsed === null) return emptyData();
  const obj = parsed as Partial<AutoUpdateStoreData>;
  const out = emptyData();
  for (const [id, p] of Object.entries(obj.policies ?? {})) {
    if (isPolicy(p)) out.policies[id] = p;
  }
  for (const [id, v] of Object.entries(obj.observed ?? {})) {
    if (typeof v === 'string' || v === null) out.observed[id] = v;
  }
  for (const [id, b] of Object.entries(obj.banners ?? {})) {
    const banner = coerceBanner(b);
    if (banner) out.banners[id] = banner;
  }
  for (const [id, s] of Object.entries(obj.snapshots ?? {})) {
    const snap = coerceSnapshot(s);
    if (snap) out.snapshots[id] = snap;
  }
  for (const [marketplace, o] of Object.entries(obj.autoUpdateOwnership ?? {})) {
    if (typeof o !== 'object' || o === null) continue;
    const prev = (o as { previousValue?: unknown }).previousValue;
    if (prev === true || prev === false || prev === null) {
      out.autoUpdateOwnership[marketplace] = { previousValue: prev };
    }
  }
  return out;
}

export class AutoUpdateStore {
  private readonly path: string;

  constructor(dataDir: string, filename: string = AUTO_UPDATE_STORE_FILENAME) {
    this.path = join(dataDir, filename);
  }

  get filePath(): string {
    return this.path;
  }

  /** Read the whole store (malformed/missing → empty). */
  async read(): Promise<AutoUpdateStoreData> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return coerceData(JSON.parse(raw));
    } catch {
      return emptyData();
    }
  }

  private async write(data: AutoUpdateStoreData): Promise<void> {
    await atomicWriteFile(this.path, `${JSON.stringify(data, null, 2)}\n`);
  }

  /** Mutate the store under a read-modify-write and persist atomically. */
  async update(mutate: (data: AutoUpdateStoreData) => void): Promise<AutoUpdateStoreData> {
    const data = await this.read();
    mutate(data);
    await this.write(data);
    return data;
  }

  /** The policy for a plugin (absent ⇒ default `off`). */
  async getPolicy(pluginId: string): Promise<AutoUpdatePolicy> {
    return (await this.read()).policies[pluginId] ?? DEFAULT_AUTO_UPDATE_POLICY;
  }

  /** Set (or clear, when `off`) a plugin's policy. */
  async setPolicy(pluginId: string, policy: AutoUpdatePolicy): Promise<void> {
    await this.update((data) => {
      if (policy === DEFAULT_AUTO_UPDATE_POLICY) delete data.policies[pluginId];
      else data.policies[pluginId] = policy;
    });
  }
}
