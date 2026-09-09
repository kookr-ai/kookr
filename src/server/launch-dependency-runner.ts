import { execFile } from 'node:child_process';
import type { LaunchDependency } from '../core/playbook.js';
import {
  classifyKbDoctorCommandResult,
  classifyKbSearchSmokeResult,
  type DependencyCommandResult,
  type LaunchPreflightFinding,
} from '../core/launch-dependency-preflight.js';

const KB_PREFLIGHT_TIMEOUT_MS = 5_000;
const KB_SMOKE_QUERY = 'kookr launch dependency smoke';

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

/** Test-only: clear the KB preflight TTL cache and any in-flight probe. */
export function resetKbPreflightCacheForTests(): void {
  kbPreflightCache = null;
  kbPreflightInflight = null;
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

  const probe = probeKbAvailability().then(
    (finding) => {
      kbPreflightCache = { finding, expiresAt: Date.now() + KB_PREFLIGHT_CACHE_TTL_MS };
      kbPreflightInflight = null;
      return finding;
    },
    (err) => {
      // Do not cache a probe that threw (e.g. `kb` missing surfacing as
      // ENOENT): the next launch should re-probe rather than reuse a failure
      // we never classified into a finding.
      kbPreflightInflight = null;
      throw err;
    },
  );
  kbPreflightInflight = probe;
  return probe;
}

async function probeKbAvailability(): Promise<LaunchPreflightFinding | null> {
  let doctor: DependencyCommandResult;
  try {
    doctor = await execFileBounded('kb', ['doctor', '--format=json'], KB_PREFLIGHT_TIMEOUT_MS);
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
    KB_PREFLIGHT_TIMEOUT_MS,
  );
  return classifyKbSearchSmokeResult(search);
}

function execFileBounded(file: string, args: string[], timeoutMs: number): Promise<DependencyCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const nodeError = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (nodeError?.code === 'ENOENT') {
        reject(error);
        return;
      }
      const exitCode = typeof nodeError?.code === 'number' ? nodeError.code : error ? 1 : 0;
      const code = String(nodeError?.code ?? '');
      const collectionFailure = nodeError?.killed || code === 'ETIMEDOUT'
        ? 'timeout' as const
        : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'max_buffer' as const
          : undefined;
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode,
        ...(collectionFailure ? { collectionFailure } : {}),
      });
    });
  });
}
