import { describe, expect, test } from 'vitest';
import { LaunchAbortedError, raceAgainstLaunchAbort, throwIfLaunchAborted } from './launch-abort.js';

describe('launch abort helpers', () => {
  test('throwIfLaunchAborted is a no-op when the signal is missing or live', () => {
    expect(() => throwIfLaunchAborted(undefined)).not.toThrow();
    expect(() => throwIfLaunchAborted(new AbortController().signal)).not.toThrow();
  });

  test('throwIfLaunchAborted raises LaunchAbortedError once aborted', () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => throwIfLaunchAborted(abort.signal, 'kookr-x')).toThrow(LaunchAbortedError);
    expect(() => throwIfLaunchAborted(abort.signal, 'kookr-x')).toThrow(/after session kookr-x/);
  });

  test('raceAgainstLaunchAbort resolves with the work when the signal stays live', async () => {
    await expect(raceAgainstLaunchAbort(Promise.resolve('ok'), new AbortController().signal))
      .resolves.toBe('ok');
  });

  test('raceAgainstLaunchAbort rejects as soon as the signal aborts', async () => {
    const abort = new AbortController();
    const hung = new Promise<string>(() => undefined);
    const raced = raceAgainstLaunchAbort(hung, abort.signal, 'kookr-y');
    abort.abort();
    await expect(raced).rejects.toBeInstanceOf(LaunchAbortedError);
  });
});
