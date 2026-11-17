// Child Vitest config for test/shared-worker-reset.test.ts (issue #4080).
//
// It reproduces the `shared` project of vitest.config.mts on a handful of
// fixture files: one worker (maxWorkers 1, no file parallelism) that runs the
// files one after another without restarting (isolate: false), with the real
// reset file as its setup file. The files run in name order, so a file that
// leaks state always runs right before a file that checks for the leak.
//
// It does not extend the repo config on purpose: that config's globalSetup
// reapers kill leftover relay and dtach processes, which belong to the run
// that spawned this one.
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

class NameOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

// SWR_WITHOUT_RESET=1 drops the setup file. The driver uses it once to show
// that the leaks are real, so the fixture cannot pass for the wrong reason.
const withReset = process.env.SWR_WITHOUT_RESET !== '1';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: process.env.SWR_CACHE_DIR,
  test: {
    include: ['*.fixture.ts'],
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { sequencer: NameOrderSequencer },
    setupFiles: withReset ? ['../../shared-worker-reset.setup.ts'] : [],
  },
});
