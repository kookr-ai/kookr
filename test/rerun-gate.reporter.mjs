// Vitest reporter for the pre-push flake re-run (scripts/flaky-rerun-files.mjs).
//
// Writes one JSON summary of the run to the `outputFile` option. Vitest's own
// JSON reporter is not enough for this decision: it drops unhandled errors
// (an unhandled rejection fails the run but leaves every file "passed") and
// reports a file whose worker crashed as "passed" with tests never run. A
// re-run gate built on it would let those real failures through behind an
// unrelated flake. This summary carries both signals:
//   { reason, unhandledErrors, modules: [{ file, state }] }
// where `reason` is Vitest's run-end reason ('passed' | 'failed' |
// 'interrupted') and `state` is each module's final state.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export default class RerunGateReporter {
  constructor(options = {}) {
    this.outputFile = options.outputFile;
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (!this.outputFile) return;
    const summary = {
      reason,
      unhandledErrors: unhandledErrors.length,
      modules: testModules.map((m) => ({ file: m.moduleId, state: m.state() })),
    };
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(summary)}\n`);
  }
}
