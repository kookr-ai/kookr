import { execFile, type ChildProcess } from 'node:child_process';
import type { LaunchDependency } from '../core/playbook.js';
import {
  classifyKbDoctorCommandResult,
  classifyKbSearchSmokeResult,
  type DependencyCommandResult,
  type LaunchPreflightFinding,
} from '../core/launch-dependency-preflight.js';

const KB_PREFLIGHT_TIMEOUT_MS = 5_000;
const KB_SMOKE_QUERY = 'kookr launch dependency smoke';
/** Grace between SIGTERM and SIGKILL for a probe child that ignores the first signal. */
const KB_PREFLIGHT_CLEANUP_GRACE_MS = 200;

// The KB preflight has a bounded per-probe timeout but no reuse, so every
// launch re-runs `kb doctor` + `kb search`. During a KB outage each launch
// re-probes and emits its own `unknown` finding, fanning one degraded
// dependency out across many tasks and repeatedly spending the probe budget
// under load (issue #3074). Reuse one probe result across rapid/concurrent
// launches with a short in-process TTL. The TTL is deliberately seconds-scale:
// long enough to collapse a launch burst onto a single probe, short enough
// that a real recovery (or a fresh failure) surfaces within one window and is
// never masked. The cached value is the finding itself (including `null` for
// healthy), so admission's fail-open handling of `unknown` is byte-for-byte
// unchanged — it just reuses an already-computed result.
const KB_PREFLIGHT_CACHE_TTL_MS = 3_000;

interface KbPreflightCacheEntry {
  finding: LaunchPreflightFinding | null;
  expiresAt: number;
}

let kbPreflightCache: KbPreflightCacheEntry | null = null;
// Collapse concurrent launches (those that arrive before the first probe
// resolves) onto the same in-flight probe so the underlying `kb` exec runs at
// most once per TTL window even under a simultaneous burst.
let kbPreflightInflight: Promise<LaunchPreflightFinding | null> | null = null;

let probeTimeoutMs = KB_PREFLIGHT_TIMEOUT_MS;
let probeCleanupGraceMs = KB_PREFLIGHT_CLEANUP_GRACE_MS;
let probeCacheTtlMs = KB_PREFLIGHT_CACHE_TTL_MS;

/** Test-only: clear the KB preflight cache/in-flight probe and restore probe knobs. */
export function resetKbPreflightCacheForTests(): void {
  kbPreflightCache = null;
  kbPreflightInflight = null;
  probeTimeoutMs = KB_PREFLIGHT_TIMEOUT_MS;
  probeCleanupGraceMs = KB_PREFLIGHT_CLEANUP_GRACE_MS;
  probeCacheTtlMs = KB_PREFLIGHT_CACHE_TTL_MS;
}

/** Test-only: shrink probe deadline / cleanup grace / cache TTL. */
export function configureKbPreflightProbeForTests(opts: {
  timeoutMs?: number;
  cleanupGraceMs?: number;
  cacheTtlMs?: number;
}): void {
  if (opts.timeoutMs !== undefined) probeTimeoutMs = opts.timeoutMs;
  if (opts.cleanupGraceMs !== undefined) probeCleanupGraceMs = opts.cleanupGraceMs;
  if (opts.cacheTtlMs !== undefined) probeCacheTtlMs = opts.cacheTtlMs;
}

export async function runLaunchDependencyPreflights(
  dependencies: LaunchDependency[] | undefined,
): Promise<LaunchPreflightFinding[]> {
  const unique = [...new Set(dependencies ?? [])];
  const findings: LaunchPreflightFinding[] = [];

  for (const dependency of unique) {
    switch (dependency) {
      case 'kb': {
        const finding = await runKbAvailabilityPreflight();
        if (finding) findings.push(finding);
        break;
      }
      case 'evolution-config': {
        // Evolution config validation is cwd- and playbook-parameter-dependent,
        // so preparePlaybookLaunch validates it before LaunchOpts are built.
        break;
      }
    }
  }

  return findings;
}

async function runKbAvailabilityPreflight(): Promise<LaunchPreflightFinding | null> {
  const now = Date.now();
  if (kbPreflightCache && now < kbPreflightCache.expiresAt) {
    return kbPreflightCache.finding;
  }
  if (kbPreflightInflight) {
    return kbPreflightInflight;
  }

  // Capture this probe's promise identity so a late settlement cannot clear a
  // newer in-flight probe or overwrite that probe's cache entry (issue #3223).
  const probe: Promise<LaunchPreflightFinding | null> = probeKbAvailability().then(
    (finding) => {
      if (kbPreflightInflight === probe) {
        kbPreflightCache = { finding, expiresAt: Date.now() + probeCacheTtlMs };
        kbPreflightInflight = null;
      }
      return finding;
    },
    (err) => {
      // Do not cache a probe that threw (e.g. `kb` missing surfacing as
      // ENOENT): the next launch should re-probe rather than reuse a failure
      // we never classified into a finding.
      if (kbPreflightInflight === probe) {
        kbPreflightInflight = null;
      }
      throw err;
    },
  );
  kbPreflightInflight = probe;
  return probe;
}

async function probeKbAvailability(): Promise<LaunchPreflightFinding | null> {
  let doctor: DependencyCommandResult;
  try {
    doctor = await execFileBounded('kb', ['doctor', '--format=json'], probeTimeoutMs, probeCleanupGraceMs);
  } catch (err) {
    return classifyKbDoctorCommandResult({
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    });
  }

  const doctorFinding = classifyKbDoctorCommandResult(doctor);
  if (doctorFinding) return doctorFinding;

  const search = await execFileBounded(
    'kb',
    ['search', KB_SMOKE_QUERY, '--k=1', '--format=json'],
    probeTimeoutMs,
    probeCleanupGraceMs,
  );
  return classifyKbSearchSmokeResult(search);
}

/**
 * Run one dependency command with a hard completion deadline.
 *
 * `execFile`'s `timeout` option only sends SIGTERM and then waits for the
 * callback. A child that ignores SIGTERM leaves that callback pending, so every
 * launch sharing the in-flight preflight stalls (issue #3223). This helper
 * settles once at `timeoutMs`, then SIGTERM → grace → SIGKILL only the child
 * it spawned. Late exit/error callbacks cannot settle twice.
 */
function execFileBounded(
  file: string,
  args: string[],
  timeoutMs: number,
  cleanupGraceMs: number,
): Promise<DependencyCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const clearDeadlineTimer = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };

    const clearGraceTimer = (): void => {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };

    const settle = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      clearDeadlineTimer();
      apply();
    };

    const timeoutResult = (): DependencyCommandResult => ({
      stdout: '',
      stderr: `timed out after ${timeoutMs}ms`,
      exitCode: 1,
      collectionFailure: 'timeout',
    });

    // Arm the deadline before spawn so a synchronous mock callback can clear it.
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      settle(() => {
        resolve(timeoutResult());
        signalOwnedChild(child, 'SIGTERM');
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          signalOwnedChild(child, 'SIGKILL');
        }, cleanupGraceMs);
      });
    }, timeoutMs);

    child = execFile(file, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (settled) {
        // Process exited after we already timed out — cancel the SIGKILL sweep.
        clearGraceTimer();
        return;
      }
      const nodeError = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (nodeError?.code === 'ENOENT') {
        settle(() => {
          clearGraceTimer();
          reject(error);
        });
        return;
      }
      const exitCode = typeof nodeError?.code === 'number' ? nodeError.code : error ? 1 : 0;
      const code = String(nodeError?.code ?? '');
      const collectionFailure = nodeError?.killed || code === 'ETIMEDOUT'
        ? 'timeout' as const
        : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'max_buffer' as const
          : undefined;
      settle(() => {
        clearGraceTimer();
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode,
          ...(collectionFailure ? { collectionFailure } : {}),
        });
      });
    });
  });
}

function signalOwnedChild(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  const pid = child?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
  try {
    if (child && typeof child.kill === 'function') {
      child.kill(signal);
      return;
    }
    process.kill(pid, signal);
  } catch (err) {
    // ESRCH: already gone. Other failures are best-effort after settlement.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      process.kill(pid, signal);
    } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code !== 'ESRCH') return;
    }
  }
}
