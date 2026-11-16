// Setup file of the `shared` Vitest project (vitest.config.mts, issue #3811).
//
// The `shared` project runs test files with `isolate: false`: one worker
// process runs many files in turn instead of starting fresh for each file.
// That roughly halves the CPU of those files, but Vitest then resets nothing
// between files except mocks made with vi.spyOn/vi.fn. This file runs before
// each test file in that worker and puts back what one file could otherwise
// leak into the next:
//
// - Modules. Without isolation, a module stays loaded with whatever the first
//   file that imported it gave it. A later file's `vi.mock('node:child_process')`
//   then never reaches a module that already holds the real one, and
//   module-level state (caches, counters, singletons) carries over. Resetting
//   the module registry makes each file load the project's modules again;
//   node_modules and Node built-ins stay loaded, which is most of the saving.
// - Timer globals and Date. A file can leave a fake timer function in place
//   of the real one (see src/core/with-timeout.test.ts), after which a later
//   file's setTimeout never fires. They are compared with the real functions
//   the worker started with and put back.
// - process.env and the working directory, restored after the file's tests.
//
// Isolated projects (`unit`, `serial`) do not load this file: there, Vitest
// starts every file in a fresh worker anyway.
import { afterAll, vi } from 'vitest';

vi.resetModules();

const TIMER_GLOBALS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'Date',
] as const;

type TimerGlobal = (typeof TIMER_GLOBALS)[number];

// The first file in a worker sees the real globals. The snapshot lives on
// globalThis because vi.resetModules() above re-runs this module per file.
const SNAPSHOT_KEY = Symbol.for('kookr.sharedWorker.realTimerGlobals');
const holder = globalThis as unknown as Record<symbol, Record<TimerGlobal, unknown> | undefined>;
const realTimerGlobals = (holder[SNAPSHOT_KEY] ??= Object.fromEntries(
  TIMER_GLOBALS.map((name) => [name, globalThis[name]]),
) as Record<TimerGlobal, unknown>);

for (const name of TIMER_GLOBALS) {
  if (globalThis[name] !== realTimerGlobals[name]) {
    (globalThis as Record<string, unknown>)[name] = realTimerGlobals[name];
  }
}

const envSnapshot = { ...process.env };
const cwdSnapshot = process.cwd();

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
  // process.cwd() throws when a test deleted the directory it moved into.
  let cwd: string | undefined;
  try {
    cwd = process.cwd();
  } catch {
    cwd = undefined;
  }
  if (cwd !== cwdSnapshot) process.chdir(cwdSnapshot);
});
