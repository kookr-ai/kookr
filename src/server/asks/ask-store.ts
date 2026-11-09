/**
 * Durable store for `kookr ask` records and the per-install callback secret.
 *
 * All state lives in an in-memory map and every mutation is synchronous, so a
 * "compare-and-set on state" needs no lock: Node runs one mutation at a time.
 * Persistence is a debounce-free write-behind: each mutation schedules a flush
 * that is serialised through a promise chain, so the file is always a complete
 * snapshot (atomic rename) and writes never interleave.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../core/persistence-utils.js';
import { ASK_LIMITS, type AskRecord } from '../../shared/contracts/asks.js';

const SCHEMA_VERSION = 1;

export class AskStore {
  private readonly asks = new Map<string, AskRecord>();
  private flushChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    readonly secret: Buffer,
    private readonly onFlushError: (err: unknown) => void,
  ) {}

  /** Open (creating if needed) the store under `<kookrDir>/asks/`. */
  static async open(kookrDir: string, onFlushError: (err: unknown) => void = () => undefined): Promise<AskStore> {
    const dir = join(kookrDir, 'asks');
    await mkdir(dir, { recursive: true, mode: 0o700 });

    let secret: Buffer;
    const secretPath = join(dir, 'secret');
    try {
      secret = Buffer.from((await readFile(secretPath, 'utf-8')).trim(), 'hex');
      if (secret.length !== 32) throw new Error('bad secret length');
    } catch {
      secret = randomBytes(32);
      await atomicWriteFile(secretPath, `${secret.toString('hex')}\n`, { mode: 0o600 });
    }

    const store = new AskStore(dir, secret, onFlushError);
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'asks.json'), 'utf-8')) as { asks?: AskRecord[] };
      for (const ask of parsed.asks ?? []) {
        if (ask && typeof ask.id === 'string') store.asks.set(ask.id, ask);
      }
    } catch {
      // Missing or unreadable file: start empty. A corrupt file is overwritten
      // on the next mutation; asks are short-lived so nothing durable is lost.
    }
    return store;
  }

  get(id: string): AskRecord | undefined {
    return this.asks.get(id);
  }

  all(): AskRecord[] {
    return [...this.asks.values()];
  }

  /** Insert a new record. The caller guarantees the id is unused. */
  insert(ask: AskRecord): void {
    this.asks.set(ask.id, ask);
    this.scheduleFlush();
  }

  /** Mutate a record in place and persist. Returns the record, or undefined if unknown. */
  update(id: string, mutate: (ask: AskRecord) => void): AskRecord | undefined {
    const ask = this.asks.get(id);
    if (!ask) return undefined;
    mutate(ask);
    this.scheduleFlush();
    return ask;
  }

  /** Drop terminal asks older than the retention window. */
  prune(now: number): void {
    let changed = false;
    for (const [id, ask] of this.asks) {
      const finishedAt = ask.answeredAt ?? ask.expiresAt;
      if (ask.state !== 'pending' && now - finishedAt > ASK_LIMITS.retentionMs) {
        this.asks.delete(id);
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  /** Resolves once every scheduled write has reached disk. */
  flush(): Promise<void> {
    return this.flushChain;
  }

  private scheduleFlush(): void {
    this.flushChain = this.flushChain.then(async () => {
      try {
        await atomicWriteFile(
          join(this.dir, 'asks.json'),
          JSON.stringify({ schemaVersion: SCHEMA_VERSION, asks: this.all() }, null, 2),
          { mode: 0o600 },
        );
      } catch (err) {
        this.onFlushError(err);
      }
    });
  }
}
