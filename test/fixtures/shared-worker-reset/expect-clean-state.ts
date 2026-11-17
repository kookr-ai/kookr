// The checks every victim file runs: what a file before it leaked must be
// gone by the time it starts.
import { expect, it } from 'vitest';
import { FAKE_MARKER } from './leak-state.js';
import { moduleState } from './module-state.js';

// The same list as TIMER_GLOBALS in test/shared-worker-reset.setup.ts.
const TIMER_GLOBALS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'Date',
];

export function expectCleanState(): void {
  it('timer globals and Date are the real ones', () => {
    const g = globalThis as unknown as Record<string, Record<string, unknown>>;
    const faked = TIMER_GLOBALS.filter((name) => g[name][FAKE_MARKER] === true);
    expect(faked).toEqual([]);
    expect(typeof Date.now()).toBe('number');
  });

  it('process.env is back to what it was', () => {
    expect(process.env.SWR_ADDED).toBeUndefined();
    expect(process.env.SWR_CHANGED).toBe('original');
    expect(process.env.SWR_DELETED).toBe('present');
  });

  it('the working directory is back to what it was', () => {
    expect(process.cwd()).toBe(process.env.SWR_START_CWD);
  });

  it('project modules are loaded fresh', () => {
    expect(moduleState.touchedBy).toBeUndefined();
  });
}
