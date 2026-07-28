/**
 * Periodic memory ledger (issue #1612).
 *
 * Prod RSS grows ~2 GB/hour under multi-agent load and only a restart resets
 * it. Static analysis surfaced two competing allocation-churn hypotheses
 * (whole-file hook re-reads; full-fleet snapshot re-serialization) plus several
 * small unbounded retainers — but which one dominates cannot be settled without
 * runtime evidence. This ledger is that instrument: a cheap, opt-in periodic log
 * line carrying process memory (rss/heap/external/arrayBuffers) alongside
 * per-subsystem retention counts, so a soak can bisect the dominant retainer
 * with measurement rather than a guess.
 *
 * A flat heap while RSS climbs confirms allocator churn (V8 rarely returns
 * freed heap to the OS); a climbing heap points at a retained-object leak, and
 * the subsystem counts say which subsystem holds it.
 *
 * Disabled by default. Enable with `KOOKR_MEMORY_LEDGER=1`; tune the cadence
 * with `KOOKR_MEMORY_LEDGER_INTERVAL_MS` (default 60s).
 */

/** A single provider contributes one named group of integer retention counts. */
export type MemoryLedgerSubsystems = Record<string, Record<string, number>>;

export interface MemoryLedgerSample {
  ts: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  subsystems: MemoryLedgerSubsystems;
}

export interface MemoryLedgerConfig {
  enabled: boolean;
  intervalMs: number;
}

export const DEFAULT_MEMORY_LEDGER_INTERVAL_MS = 60_000;
const MIN_MEMORY_LEDGER_INTERVAL_MS = 1_000;

export interface MemoryLedgerDeps {
  /** Optional retention-count collector. Failures are swallowed so the ledger never crashes a tick. */
  collectSubsystems?: () => MemoryLedgerSubsystems;
  readProcessMemory?: () => NodeJS.MemoryUsage;
  logger?: Pick<typeof console, 'info' | 'warn'>;
  nowIso?: () => string;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export class MemoryLedger {
  private readonly collectSubsystems: () => MemoryLedgerSubsystems;
  private readonly readProcessMemory: () => NodeJS.MemoryUsage;
  private readonly logger: Pick<typeof console, 'info' | 'warn'>;
  private readonly nowIso: () => string;
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private collectErrorLogged = false;

  constructor(deps: MemoryLedgerDeps = {}) {
    this.collectSubsystems = deps.collectSubsystems ?? (() => ({}));
    this.readProcessMemory = deps.readProcessMemory ?? (() => process.memoryUsage());
    this.logger = deps.logger ?? console;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.intervalMs = Math.max(MIN_MEMORY_LEDGER_INTERVAL_MS, deps.intervalMs ?? DEFAULT_MEMORY_LEDGER_INTERVAL_MS);
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  /** Begin logging. Emits one line immediately, then every intervalMs. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.logSample();
    this.timer = this.setIntervalFn(() => this.logSample(), this.intervalMs);
    // Do not keep the process alive purely for the ledger.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /** Build a sample without logging. Exposed for tests and callers that want the raw numbers. */
  sample(): MemoryLedgerSample {
    const mem = this.readProcessMemory();
    return {
      ts: this.nowIso(),
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      heapTotalMb: toMb(mem.heapTotal),
      externalMb: toMb(mem.external),
      arrayBuffersMb: toMb(mem.arrayBuffers ?? 0),
      subsystems: this.safeCollect(),
    };
  }

  private safeCollect(): MemoryLedgerSubsystems {
    try {
      return this.collectSubsystems();
    } catch (err) {
      if (!this.collectErrorLogged) {
        this.collectErrorLogged = true;
        this.logger.warn('[mem-ledger] subsystem collector failed:', err instanceof Error ? err.message : String(err));
      }
      return {};
    }
  }

  private logSample(): void {
    // One structured line, greppable by the `[mem-ledger]` prefix.
    this.logger.info('[mem-ledger]', JSON.stringify(this.sample()));
  }
}

export function createMemoryLedger(deps?: MemoryLedgerDeps): MemoryLedger {
  return new MemoryLedger(deps);
}

/**
 * Read the ledger's enablement + cadence from the environment. Enabled only for
 * an explicit truthy opt-in (`1`/`true`/`yes`/`on`); an invalid or blank
 * interval falls back to {@link DEFAULT_MEMORY_LEDGER_INTERVAL_MS}.
 */
export function readMemoryLedgerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryLedgerConfig {
  const raw = (env.KOOKR_MEMORY_LEDGER ?? '').trim().toLowerCase();
  const enabled = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  const parsedInterval = Number(env.KOOKR_MEMORY_LEDGER_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(parsedInterval) && parsedInterval >= MIN_MEMORY_LEDGER_INTERVAL_MS
      ? Math.trunc(parsedInterval)
      : DEFAULT_MEMORY_LEDGER_INTERVAL_MS;
  return { enabled, intervalMs };
}
