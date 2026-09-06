import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDtachDir } from './dtach-instance-dir.js';
import type { SessionId } from './terminal-backend.js';

export interface DtachManifestEntry {
  sessionId: SessionId;
  pid: number;
  startedAt: string;
  status: 'pending' | 'active' | 'recovered';
  /** Full socket path, absolute. */
  sock: string;
  /**
   * Durable launch handoff (issue #2762). Optional so pre-existing manifests
   * stay inert: only entries explicitly stamped `unadopted` participate in
   * restart recovery for launch-abandoned masters.
   */
  launchState?: 'unadopted' | 'adopted';
  /** Unique id of the server process generation that began this launch. */
  launchCreatorId?: string;
}

export interface DtachManifestFile {
  version: 1;
  instanceId: string;
  entries: DtachManifestEntry[];
}

export type DtachManifestRecoveryRead =
  | { kind: 'missing' }
  | { kind: 'valid'; manifest: DtachManifestFile }
  | { kind: 'invalid' };

export class DtachManifestStore {
  /** Single-instance serialization for manifest read-modify-write. */
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly manifestPath: string,
    private readonly instanceId: string,
  ) {}

  read(): DtachManifestFile {
    if (!existsSync(this.manifestPath)) return this.emptyManifest();
    try {
      const raw = readFileSync(this.manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as DtachManifestFile;
      if (parsed.version !== 1) throw new Error(`unsupported manifest version ${parsed.version}`);
      return parsed;
    } catch {
      return this.emptyManifest();
    }
  }

  readForRecovery(): DtachManifestRecoveryRead {
    if (!existsSync(this.manifestPath)) return { kind: 'missing' };
    try {
      const raw = readFileSync(this.manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as DtachManifestFile;
      if (parsed.version !== 1) throw new Error(`unsupported manifest version ${parsed.version}`);
      return { kind: 'valid', manifest: parsed };
    } catch {
      return { kind: 'invalid' };
    }
  }

  async getEntry(id: SessionId): Promise<DtachManifestEntry | null> {
    const manifest = this.read();
    return manifest.entries.find((entry) => entry.sessionId === id) ?? null;
  }

  async update(fn: (manifest: DtachManifestFile) => void): Promise<void> {
    await this.withLock(() => {
      const manifest = this.read();
      fn(manifest);
      this.writeAtomic(manifest);
    });
  }

  writeAtomic(manifest: DtachManifestFile): void {
    // The instance directory lives in /tmp and can be swept away while the
    // server runs; re-create it here so a vanished directory costs one launch
    // at most instead of every launch until restart (kookr-ai/kookr#3042).
    ensureDtachDir(dirname(this.manifestPath));
    const tmp = `${this.manifestPath}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      renameSync(tmp, this.manifestPath);
      renamed = true;
    } finally {
      if (!renamed) {
        try { unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
      }
    }
  }

  renameCorrupt(): void {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      renameSync(this.manifestPath, `${this.manifestPath}.corrupt-${ts}`);
    } catch {
      // best-effort
    }
  }

  async withLock<T>(fn: () => T): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      return fn();
    } finally {
      release();
    }
  }

  private emptyManifest(): DtachManifestFile {
    return { version: 1, instanceId: this.instanceId, entries: [] };
  }
}
