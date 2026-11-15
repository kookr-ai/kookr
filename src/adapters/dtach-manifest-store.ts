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
  /**
   * Last terminal size applied to the session (issue #3565). A restarted
   * server re-attaches at this size: dtach forwards the attach size to the
   * agent's PTY, so falling back to 80x24 would re-wrap every agent.
   * Optional so manifests written before this field still load.
   */
  size?: DtachTerminalSize;
}

export interface DtachTerminalSize {
  cols: number;
  rows: number;
}

/** Upper bound for a persisted dimension; anything larger is treated as corrupt. */
const MAX_TERMINAL_DIMENSION = 10_000;

/**
 * Return the entry's persisted size when it is a usable terminal size, or
 * `undefined` when absent or malformed (the manifest is hand-editable JSON on
 * disk, and a bad value handed to `spawn` is worse than the 80x24 default).
 */
export function readPersistedSize(entry: DtachManifestEntry | undefined): DtachTerminalSize | undefined {
  const size = entry?.size as Partial<DtachTerminalSize> | undefined;
  if (!size || typeof size !== 'object') return undefined;
  const valid = (n: unknown): n is number => (
    Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_TERMINAL_DIMENSION
  );
  if (!valid(size.cols) || !valid(size.rows)) return undefined;
  return { cols: size.cols, rows: size.rows };
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

  /**
   * Record `size` on the session's existing entry. Never creates an entry and
   * never rewrites a missing or unparseable manifest (startup recovery owns
   * those), and skips the write when the stored size already matches.
   */
  async setSize(id: SessionId, size: DtachTerminalSize): Promise<void> {
    await this.withLock(() => {
      const recovery = this.readForRecovery();
      if (recovery.kind !== 'valid') return;
      const entry = recovery.manifest.entries.find((candidate) => candidate.sessionId === id);
      if (!entry) return;
      if (entry.size?.cols === size.cols && entry.size.rows === size.rows) return;
      entry.size = { cols: size.cols, rows: size.rows };
      this.writeAtomic(recovery.manifest);
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
