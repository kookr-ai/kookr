// Leaks that the reset must undo before the next file: every timer global the
// reset restores, and Date, replaced by direct assignment (vi.useFakeTimers and vi.stubGlobal would be
// undone by the reset's afterAll, which would leave the restore loop that runs
// before each file untested), an env key added, one changed, one deleted, and
// module-level state.
import { moduleState } from './module-state.js';

export const FAKE_MARKER = '__sharedWorkerResetFake';

function fake<T extends object>(target: T): T {
  return Object.assign(target, { [FAKE_MARKER]: true });
}

export function leakTimersEnvAndModules(file: string): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.setTimeout = fake(() => 0);
  g.clearTimeout = fake(() => undefined);
  g.setInterval = fake(() => 0);
  g.clearInterval = fake(() => undefined);
  g.setImmediate = fake(() => 0);
  g.clearImmediate = fake(() => undefined);
  g.queueMicrotask = fake(() => undefined);
  g.Date = fake(class FakeDate {});

  process.env.SWR_ADDED = 'leaked';
  process.env.SWR_CHANGED = 'leaked';
  delete process.env.SWR_DELETED;

  moduleState.touchedBy = file;
}
