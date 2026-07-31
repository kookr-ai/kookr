// Vitest globalSetup: post-test dtach-master reaper (issue #1738).
//
// dtach masters are spawned via `setsid` and outlive the vitest worker. Per-
// file afterEach hooks that call `reapDtachReferencing(tmpDir)` cover the known
// call sites, but any test that creates a real session and forgets that
// convention leaks a resident master under `/tmp/tsc-*` (or similar test
// prefixes) for days. teardown() is the belt-and-suspenders sweep: it runs
// after ALL workers exit and reaps any leftover test-suite dtach process.
//
// Scoped strictly to known test mkdtemp prefixes (see
// `src/test-utils/reap-dtach.ts`); production sockets under `/tmp/kookr-dtach/`
// are never touched.
//
// Linux-only (reads /proc); a no-op elsewhere. Warn-only by default so a
// straggler mid-graceful-shutdown never flakes CI; set
// KOOKR_DTACH_REAPER_STRICT=1 to fail the run when survivors are found (after
// they are reaped). Like git-repo-guard / relay-orphan-reaper, a strict failure
// sets process.exitCode — a throw in globalSetup teardown does not fail vitest 4.

import { findLingeringTestDtachPids, reapLingeringTestDtachMasters } from '../src/test-utils/reap-dtach.js';

export function setup(): void {
  // Nothing to snapshot; path-marker scope is self-identifying.
}

function isStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.KOOKR_DTACH_REAPER_STRICT;
  return v === '1' || v === 'true';
}

export async function teardown(): Promise<void> {
  if (process.platform !== 'linux') return;

  let lingering: number[];
  try {
    lingering = findLingeringTestDtachPids();
  } catch {
    return; // defensive: never break the suite over a best-effort sweep
  }
  if (lingering.length === 0) return;

  try {
    await reapLingeringTestDtachMasters({ graceMs: 500 });
  } catch {
    // still emit the warning below with the pre-reap pid list
  }

  const msg =
    `[dtach-master-reaper] reaped ${lingering.length} lingering test-suite dtach ` +
    `process(es) after the run: ${lingering.join(', ')} (#1738). Per-file ` +
    `afterEach should normally clear these; investigate if this recurs.`;
  if (isStrict()) {
    process.exitCode = 1;
    console.error(msg);
  } else {
    console.warn(msg);
  }
}
