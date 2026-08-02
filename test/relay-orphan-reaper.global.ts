// Vitest globalSetup: post-test relay-orphan reaper (issue #1723 criterion #1).
//
// The relay lifecycle spawns real `relay/server.ts` processes (detached) during
// the suite. The die-with-parent watchdog (armed via vitest.config.ts
// KOOKR_RELAY_DIE_WITH_PARENT=1) reaps them as their worker parents exit, but
// teardown() is the belt-and-suspenders check: it runs after ALL workers exit
// (no race) and SIGKILLs any test-suite relay still lingering, so a full
// `pnpm test` run leaves ZERO relay server processes behind.
//
// Scoped strictly to relays this suite spawned — matched by a test-runner
// fingerprint in their environment (KOOKR_RELAY_DIE_WITH_PARENT or a VITEST*
// key; #1885) — so a developer's separately-running local/prod relay on the
// same machine, which carries neither, is never touched.
//
// Linux-only (reads /proc); a no-op elsewhere. Warn-only by default so a
// straggler mid-graceful-shutdown never flakes CI; set
// KOOKR_RELAY_ORPHAN_STRICT=1 to fail the run when survivors are found (after
// they are reaped). Like git-repo-guard, a strict failure sets
// process.exitCode — a throw in globalSetup teardown does not fail vitest 4.

import { classifyProcess, isTestRunnerSpawnedRelayEnviron } from '../src/core/orphan-process-scanner.js';
import { listProcessSnapshots, readProcessEnviron } from '../src/adapters/proc-process-lister.js';

export function setup(): void {
  // Nothing to snapshot; the marker-based scope is self-identifying.
}

function isStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.KOOKR_RELAY_ORPHAN_STRICT;
  return v === '1' || v === 'true';
}

/** Pids of test-suite-spawned relay servers still present. */
export function findLingeringTestRelays(
  listProcesses: () => ReturnType<typeof listProcessSnapshots> = listProcessSnapshots,
  readEnviron: (pid: number) => Record<string, string> | null = readProcessEnviron,
): number[] {
  const pids: number[] = [];
  for (const proc of listProcesses()) {
    if (classifyProcess(proc.cmdline) !== 'relay-server') continue;
    // Broadened in #1885: a test relay whose die-with-parent marker never armed
    // (e.g. a spawn path that predates it) still carries VITEST env markers, so
    // isTestRunnerSpawnedRelayEnviron catches it where the narrow marker would not.
    if (!isTestRunnerSpawnedRelayEnviron(readEnviron(proc.pid))) continue;
    pids.push(proc.pid);
  }
  return pids;
}

export function teardown(): void {
  if (process.platform !== 'linux') return;
  let lingering: number[];
  try {
    lingering = findLingeringTestRelays();
  } catch {
    return; // defensive: never break the suite over a best-effort sweep
  }
  if (lingering.length === 0) return;

  for (const pid of lingering) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  const msg =
    `[relay-orphan-reaper] reaped ${lingering.length} lingering test relay server(s) ` +
    `after the run: ${lingering.join(', ')} (#1723). The die-with-parent watchdog ` +
    `should normally clear these; investigate if this recurs.`;
  if (isStrict()) {
    process.exitCode = 1;
    console.error(msg);
  } else {
    console.warn(msg);
  }
}
