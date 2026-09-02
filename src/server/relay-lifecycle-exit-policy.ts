import type { RelayDoctorReport } from './relay-lifecycle-contracts.js';

/**
 * Exit-status contract for `pnpm relay:doctor`.
 *
 * The doctor is meant to gate unattended restart/recovery scripts, so it must
 * signal health through its exit status — not only through human-readable
 * `nextActions` text. This policy draws the line between *required* local
 * health (the relay process, its env, and its state storage — the things a
 * local recovery script can and must fix before the relay is usable) and
 * *optional* external dependencies (relay node reachability and admin policy
 * diagnostics, which depend on the network or a remote relay and must never
 * fail a local-only recovery check).
 *
 * - Required subsystem in a bad state → non-zero exit, with a reason recorded.
 * - Only optional subsystems degraded (or everything healthy) → exit 0.
 */
export interface RelayDoctorExitPolicy {
  exitCode: number;
  fatalReasons: string[];
}

const HEALTHY_EXIT = 0;
const UNHEALTHY_EXIT = 1;

export function relayDoctorExitPolicy(report: RelayDoctorReport): RelayDoctorExitPolicy {
  const fatalReasons: string[] = [];

  // Process: anything other than a healthy running relay is a required failure
  // (stopped, stale-pid, foreign-process, foreign-port). A recovery gate must
  // not treat "not running" as success.
  if (report.process.state !== 'running') {
    fatalReasons.push(`process:${report.process.state} — ${report.process.message}`);
  }

  // Env: any non-ok env state (missing-env, missing-admin-token,
  // restart-required) blocks a healthy local relay and is locally fixable.
  if (report.env.state !== 'ok') {
    fatalReasons.push(`env:${report.env.state} — ${report.env.message}`);
  }

  // Storage: any non-ok state (today only db-write-failed) is a required local
  // failure. Fail-closed via `!== 'ok'` so a future unhealthy storage state is
  // treated as fatal by default, matching the process/env checks above.
  if (report.storage.state !== 'ok') {
    fatalReasons.push(`storage:${report.storage.state} — ${report.storage.message}`);
  }

  // Optional external subsystems (node reachability/pairing and admin policy
  // diagnostics) are intentionally excluded: an unreachable relay or an
  // unavailable/unauthorized policy summary must not fail a local-only
  // recovery check. Their guidance still surfaces via report.nextActions.

  return {
    exitCode: fatalReasons.length > 0 ? UNHEALTHY_EXIT : HEALTHY_EXIT,
    fatalReasons,
  };
}
