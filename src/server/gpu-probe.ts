import { execFile } from 'node:child_process';
import {
  NVIDIA_SMI_QUERY_ARGS,
  parseNvidiaSmiGpuQuery,
  type GpuDeviceReading,
} from '../core/gpu-metrics.js';

/** Upper bound on one `nvidia-smi` call. A healthy call takes about 0.1 s. */
export const GPU_PROBE_TIMEOUT_MS = 3_000;
/** A reading older than this is no longer shown as current. */
export const GPU_READING_MAX_AGE_MS = 20_000;
/**
 * How long to wait before running `nvidia-smi` again on a host that does not
 * have it. Most hosts never gain a GPU while the server runs, so this only has
 * to catch a driver installed later.
 */
export const GPU_PROBE_ABSENT_RETRY_MS = 5 * 60_000;
/** Consecutive failed probes after which the probe slows down. */
export const GPU_PROBE_FAILURES_BEFORE_BACKOFF = 3;
/**
 * Gap between probes once `nvidia-smi` keeps failing or timing out (a broken
 * driver can make every call hang until the timeout): one attempt a minute
 * instead of one every few seconds.
 */
export const GPU_PROBE_FAILING_RETRY_MS = 60_000;

/** Why there is no current GPU reading. */
export type GpuUnavailableReason =
  /** No probe has finished yet. */
  | 'warming_up'
  /** `nvidia-smi` is not on this host (no NVIDIA GPU, or no driver). */
  | 'not_installed'
  /** `nvidia-smi` ran but listed no device. */
  | 'no_devices'
  /** The last probe failed or timed out and the last good reading is too old. */
  | 'probe_failed';

export interface GpuProbeSnapshot {
  /** Empty when `unavailable` is set. */
  devices: GpuDeviceReading[];
  /** Age of `devices` in milliseconds, `null` when there are none. */
  ageMs: number | null;
  unavailable: GpuUnavailableReason | null;
}

export interface GpuCommandResult {
  /** `true` when the binary does not exist on this host. */
  notInstalled: boolean;
  /** `true` when the command ran and exited 0. */
  ok: boolean;
  stdout: string;
}

export type GpuCommandRunner = (timeoutMs: number) => Promise<GpuCommandResult>;

/** Runs `nvidia-smi` without a shell. Never rejects. */
export const runNvidiaSmi: GpuCommandRunner = (timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        'nvidia-smi',
        [...NVIDIA_SMI_QUERY_ARGS],
        { encoding: 'utf-8', timeout: timeoutMs },
        (err, stdout) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            resolve({ notInstalled: code === 'ENOENT', ok: false, stdout: '' });
            return;
          }
          resolve({ notInstalled: false, ok: true, stdout: String(stdout) });
        },
      );
    } catch {
      resolve({ notInstalled: false, ok: false, stdout: '' });
    }
  });

export interface GpuProbeDeps {
  run?: GpuCommandRunner;
  nowMs?: () => number;
  timeoutMs?: number;
  maxAgeMs?: number;
  absentRetryMs?: number;
  failingRetryMs?: number;
}

/**
 * Keeps the latest GPU reading for the vitals sampler.
 *
 * `refresh()` is asynchronous and never overlaps itself, so a slow or hung
 * `nvidia-smi` cannot delay the caller's timer: the caller reads `snapshot()`,
 * which is synchronous and returns the last finished reading. A host without
 * `nvidia-smi` is probed again only every `absentRetryMs`.
 */
export class GpuProbe {
  private readonly run: GpuCommandRunner;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly absentRetryMs: number;
  private readonly failingRetryMs: number;
  private consecutiveFailures = 0;
  private lastFailedAtMs: number | null = null;
  private inFlight: Promise<void> | null = null;
  private devices: GpuDeviceReading[] = [];
  private readAtMs: number | null = null;
  private lastFailure: Exclude<GpuUnavailableReason, 'warming_up'> | null = null;
  private absentSinceMs: number | null = null;

  constructor(deps: GpuProbeDeps = {}) {
    this.run = deps.run ?? runNvidiaSmi;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? GPU_PROBE_TIMEOUT_MS;
    this.maxAgeMs = deps.maxAgeMs ?? GPU_READING_MAX_AGE_MS;
    this.absentRetryMs = deps.absentRetryMs ?? GPU_PROBE_ABSENT_RETRY_MS;
    this.failingRetryMs = deps.failingRetryMs ?? GPU_PROBE_FAILING_RETRY_MS;
  }

  /**
   * Start one probe, unless one is running, the host is known to have no
   * `nvidia-smi`, or the command keeps failing and its retry delay has not passed.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.nowMs();
    if (this.absentSinceMs !== null && now - this.absentSinceMs < this.absentRetryMs) {
      return Promise.resolve();
    }
    if (
      this.consecutiveFailures >= GPU_PROBE_FAILURES_BEFORE_BACKOFF
      && this.lastFailedAtMs !== null
      && now - this.lastFailedAtMs < this.failingRetryMs
    ) {
      return Promise.resolve();
    }
    const probe = this.run(this.timeoutMs)
      .then((result) => this.record(result))
      .catch(() => this.record({ notInstalled: false, ok: false, stdout: '' }))
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = probe;
    return probe;
  }

  private record(result: GpuCommandResult): void {
    if (result.notInstalled) {
      this.absentSinceMs = this.nowMs();
      this.lastFailure = 'not_installed';
      this.devices = [];
      this.readAtMs = null;
      return;
    }
    this.absentSinceMs = null;
    if (!result.ok) {
      // Keep the last good reading; `snapshot()` drops it once it is too old.
      this.lastFailure = 'probe_failed';
      this.consecutiveFailures += 1;
      this.lastFailedAtMs = this.nowMs();
      return;
    }
    this.consecutiveFailures = 0;
    this.lastFailedAtMs = null;
    const devices = parseNvidiaSmiGpuQuery(result.stdout);
    if (devices.length === 0) {
      this.lastFailure = 'no_devices';
      this.devices = [];
      this.readAtMs = null;
      return;
    }
    this.lastFailure = null;
    this.devices = devices;
    this.readAtMs = this.nowMs();
  }

  snapshot(): GpuProbeSnapshot {
    if (this.readAtMs !== null) {
      const ageMs = Math.max(0, this.nowMs() - this.readAtMs);
      if (ageMs <= this.maxAgeMs) {
        return { devices: this.devices, ageMs, unavailable: null };
      }
    }
    // No failure on record means the reading simply aged out because nobody
    // asked for a refresh (no dashboard was open): the next probe will fill it.
    return { devices: [], ageMs: null, unavailable: this.lastFailure ?? 'warming_up' };
  }
}
