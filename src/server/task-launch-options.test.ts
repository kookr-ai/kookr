import { describe, expect, test } from 'vitest';
import { adapterOptionsForTask } from './task-launch-options.js';
import type { Task } from '../core/task-read-model.js';

function taskWithPins(launchPins: unknown): Task {
  return {
    id: 'task-with-pins',
    metadata: launchPins === undefined ? undefined : { launchPins } as Task['metadata'],
  } as Task;
}

describe('adapterOptionsForTask', () => {
  test('preserves pinned values and treats pre-feature tasks as unpinned', () => {
    expect(adapterOptionsForTask(taskWithPins({
      version: 1,
      state: 'known-pinned',
      effort: 'max',
      model: 'gpt-5.6-sol',
    }))).toMatchObject({ effort: 'max', model: 'gpt-5.6-sol' });
    expect(adapterOptionsForTask(taskWithPins(undefined))).toEqual({});
  });

  test('blocks malformed and unsupported persisted metadata', () => {
    expect(() => adapterOptionsForTask(taskWithPins({ version: 1, state: 'malformed' }))).toThrow(/malformed/);
    expect(() => adapterOptionsForTask(taskWithPins({ version: 1, state: 'unknown' }))).toThrow(/manual confirmation/);
    expect(() => adapterOptionsForTask(taskWithPins({ version: 2, state: 'known-pinned' }))).toThrow(/unsupported/);
    expect(() => adapterOptionsForTask(taskWithPins({ version: 1, state: 'future' }))).toThrow(/unsupported/);
    expect(() => adapterOptionsForTask(taskWithPins({ version: 1, state: 'known-pinned' }))).toThrow(/empty/);
    expect(() => adapterOptionsForTask(taskWithPins({
      version: 1,
      state: 'known-unpinned',
      effort: 'max',
    }))).toThrow(/contradictory/);
    expect(() => adapterOptionsForTask(taskWithPins({
      version: 1,
      state: 'known-pinned',
      effort: 'not safe',
    }))).toThrow(/invalid persisted/);
  });
});
