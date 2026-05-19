/**
 * Form-time host-capability presence probes.
 *
 * These answer a single question — *would a parameter gated by this dependency
 * do anything at all on this host?* — i.e. is the dependency's binary present.
 * That is deliberately distinct from `launch-dependency-runner.ts`, which runs
 * a slower post-submit *health* preflight (`kb doctor`). Presence is probed at
 * playbook-list time so the launch form can collapse inert gated parameters
 * before the user sees them.
 *
 * See `docs/rfc/rfc-capability-gated-playbook-params.md`.
 */
import { execFile } from 'node:child_process';
import type { LaunchDependency } from '../core/playbook.js';
import type { HostCapability } from '../shared/contracts/messages.js';

/** `kb --version` measured ~0.5s; 3× headroom, and the hard cap on list delay. */
const KB_PRESENCE_TIMEOUT_MS = 1_500;

/** Plenty for a version string; tight enough to surface a flooding binary as a handled error. */
const KB_PRESENCE_MAX_BUFFER_BYTES = 64 * 1024;

/**
 * Probe whether the `kb` CLI is present on the Kookr server `PATH`.
 *
 * Resolve-only — never rejects. `ENOENT` (binary not found) → `absent`; a
 * successful spawn at any exit code → `available` (an installed-but-degraded
 * `kb` still makes a gated parameter meaningful); timeout or a non-executable
 * binary → `undefined`, meaning *unknown*, which the caller treats as
 * fail-open.
 */
export function probeKbPresence(): Promise<HostCapability | undefined> {
  return new Promise((resolve) => {
    execFile(
      'kb',
      ['--version'],
      { timeout: KB_PRESENCE_TIMEOUT_MS, maxBuffer: KB_PRESENCE_MAX_BUFFER_BYTES },
      (error) => {
        if (!error) {
          resolve('available'); // ran, exit 0
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        if (e.killed) {
          resolve(undefined); // timed out → unknown (checked first: the dangerous misclassification)
          return;
        }
        if (e.code === 'ENOENT') {
          resolve('absent'); // not on PATH
          return;
        }
        if (e.code === 'EACCES' || e.code === 'ENOEXEC') {
          resolve(undefined); // broken/non-executable binary → unknown
          return;
        }
        // Any other error — a numeric non-zero exit code, or an unenumerated OS
        // error — means *some* `kb` ran. Fail open: 'available'.
        resolve('available');
      },
    );
  });
}

/**
 * Capability probes keyed by {@link LaunchDependency}. Exhaustive over the
 * union by construction: adding a `LAUNCH_DEPENDENCIES` member without wiring a
 * probe here is a compile error.
 */
export const CAPABILITY_PROBES: Record<
  LaunchDependency,
  () => Promise<HostCapability | undefined>
> = {
  kb: probeKbPresence,
};
