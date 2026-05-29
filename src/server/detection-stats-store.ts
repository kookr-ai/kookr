import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DetectionStats } from '../core/detection-stats.js';

export const DETECTION_STATS_FILE = 'detection-stats.json';
export const DETECTION_STATS_SCHEMA_VERSION = 'detection-stats.v1';

interface PersistedDetectionStats {
  schemaVersion: typeof DETECTION_STATS_SCHEMA_VERSION;
  stats: DetectionStats;
}

/**
 * Durable home for the cumulative {@link DetectionStats} counters. The counters
 * themselves live in-memory in `core/detection-stats`; without this store they
 * reset on every server restart, so the FP / FN / suppression rates that reveal
 * detector quality are never observable across the many restarts a day.
 *
 * Writes are atomic (temp file + rename) and serialized through a chain so a
 * crash mid-write cannot truncate the live file. Read failures degrade to
 * "no snapshot" (counters stay at zero) rather than throwing — a missing or
 * corrupt stats file must never block startup.
 */
export class DetectionStatsStore {
  private writeChain = Promise.resolve();

  constructor(private readonly path: string) {}

  static forKookrDir(kookrDir: string): DetectionStatsStore {
    return new DetectionStatsStore(join(kookrDir, DETECTION_STATS_FILE));
  }

  /** Load the persisted counters, or null if absent / unreadable / malformed. */
  async load(): Promise<DetectionStats | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as Partial<PersistedDetectionStats>;
      if (parsed?.schemaVersion !== DETECTION_STATS_SCHEMA_VERSION) return null;
      if (!parsed.stats || typeof parsed.stats !== 'object') return null;
      return parsed.stats as DetectionStats;
    } catch {
      return null;
    }
  }

  /** Atomically persist the current counters. Serialized via an internal chain. */
  save(stats: DetectionStats): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const payload: PersistedDetectionStats = {
        schemaVersion: DETECTION_STATS_SCHEMA_VERSION,
        stats,
      };
      const tmp = `${this.path}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
      await rename(tmp, this.path);
    });
    return this.writeChain;
  }
}
