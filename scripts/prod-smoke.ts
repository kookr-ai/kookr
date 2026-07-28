// scripts/prod-smoke.ts — post-deploy smoke suite CLI (issue #1592).
//
// Invoked at the end of scripts/prod-restart.sh (and transitively
// scripts/prod-update.sh) once the freshly-restarted server has passed the
// liveness gate. The reusable check logic lives in src/server/prod-smoke.ts
// (so the hourly in-process tick — issue #1593 — can share it); this file is
// the thin single-shot CLI wrapper: run every check once, print a PASS/FAIL
// line per check, write the operational alert artifact, and exit non-zero on
// any failure so the deploy command surfaces the problem (the new server is
// already live, so this is an alarm for an operator, not a rollback).
//
// The whole suite is bounded by per-check timeouts and a hard overall deadline
// so it can never hang a deploy. Cross-platform (no dependency on GNU
// `timeout`, which macOS lacks).

import { pathToFileURL } from 'node:url';

import {
  ALERT_SCHEMA_VERSION,
  buildAlertArtifact,
  formatDuration,
  resolveConfig,
  runSmokeChecks,
  writeAlertArtifact,
} from '../src/server/prod-smoke.js';

// Re-export the shared core so existing importers (scripts/prod-smoke.test.ts)
// and any tooling that imported these names from this module keep resolving.
export * from '../src/server/prod-smoke.js';

async function main(): Promise<void> {
  const config = resolveConfig();

  // Hard overall deadline — a last-resort backstop so a check that somehow
  // escapes its own timeout can never wedge the deploy.
  const deadline = setTimeout(() => {
    console.error(
      `[prod-smoke] FAILED: overall deadline of ${formatDuration(config.overallTimeoutMs)} exceeded`,
    );
    writeAlertArtifact(config.alertPath, {
      schemaVersion: ALERT_SCHEMA_VERSION,
      status: 'alert',
      generatedAt: new Date().toISOString(),
      failingChecks: ['overall-timeout'],
      checks: [{ name: 'overall-timeout', ok: false, detail: 'suite exceeded its hard overall deadline' }],
    });
    process.exit(1);
  }, config.overallTimeoutMs);

  let checks;
  try {
    checks = await runSmokeChecks(config);
  } finally {
    clearTimeout(deadline);
  }

  for (const check of checks) {
    const tag = check.ok ? 'PASS' : 'FAIL';
    console.log(`[prod-smoke] ${tag} ${check.name}: ${check.detail}`);
  }

  const artifact = buildAlertArtifact(checks, new Date().toISOString());
  writeAlertArtifact(config.alertPath, artifact);

  if (artifact.failingChecks.length > 0) {
    console.error(`[prod-smoke] FAILED checks: ${artifact.failingChecks.join(', ')}`);
    console.error(`[prod-smoke] operational alert written to ${config.alertPath}`);
    process.exit(1);
  }
  console.log('[prod-smoke] all checks passed');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
