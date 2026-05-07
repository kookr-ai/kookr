import { describe, expect, it } from 'vitest';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import { TaskStore, type SessionInfo } from '../core/tasks.js';
import { probeStartupLiveness } from './ralph-loop-service.js';

function mkSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tmuxSession: overrides.tmuxSession ?? 's',
    agentType: 'claude-code',
    cwd: '/cwd',
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeBackend(behavior: (id: string) => boolean | Promise<boolean>): TerminalBackend {
  return {
    isAlive: async (id: string) => behavior(id),
    // The probe only reads `isAlive`. Stub the rest with throws so tests
    // catch any accidental dependency on the broader interface.
    createSession: () => { throw new Error('not stubbed'); },
    killSession: () => { throw new Error('not stubbed'); },
    listSessions: () => { throw new Error('not stubbed'); },
    write: () => { throw new Error('not stubbed'); },
    captureBytes: () => { throw new Error('not stubbed'); },
    onData: () => { throw new Error('not stubbed'); },
    onError: () => { throw new Error('not stubbed'); },
    stats: () => { throw new Error('not stubbed'); },
  } as unknown as TerminalBackend;
}

function withTask(sessions: SessionInfo[]) {
  const store = new TaskStore();
  const task = store.createTask('p', '/cwd');
  for (const s of sessions) store.addSession(task.id, s);
  return task;
}

describe('probeStartupLiveness', () => {
  it('returns the live session when the backend confirms it', async () => {
    const task = withTask([mkSession({ tmuxSession: 'live' })]);
    const backend = fakeBackend((id) => id === 'live');
    const result = await probeStartupLiveness(task, backend);
    expect(result?.tmuxSession).toBe('live');
  });

  it('returns null when the backend reports the session dead', async () => {
    const task = withTask([mkSession({ tmuxSession: 'dead' })]);
    const backend = fakeBackend(() => false);
    const result = await probeStartupLiveness(task, backend);
    expect(result).toBeNull();
  });

  it('returns null when the per-probe timeout (500ms) fires', async () => {
    const task = withTask([mkSession({ tmuxSession: 'slow' })]);
    const backend = fakeBackend(
      () => new Promise<boolean>((resolve) => {
        // Resolve well after the probe timeout — the helper must give up first.
        setTimeout(() => resolve(true), 5_000);
      }),
    );
    const start = Date.now();
    const result = await probeStartupLiveness(task, backend);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // 500ms hardcoded timeout + JS event-loop slop. Allow 800ms upper bound.
    expect(elapsed).toBeLessThan(800);
  });

  it('returns null when isAlive throws (treats backend errors as dead)', async () => {
    const task = withTask([mkSession({ tmuxSession: 'broken' })]);
    const backend = fakeBackend(() => {
      throw new Error('backend exploded');
    });
    const result = await probeStartupLiveness(task, backend);
    expect(result).toBeNull();
  });

  it('skips sessions whose lastStatus is terminal (aborted-status precedence)', async () => {
    const task = withTask([
      mkSession({ tmuxSession: 'aborted', lastStatus: 'aborted' }),
      mkSession({ tmuxSession: 'completed', lastStatus: 'completed' }),
    ]);
    let probeCalled = false;
    const backend = fakeBackend(() => {
      probeCalled = true;
      return true;
    });
    const result = await probeStartupLiveness(task, backend);
    expect(result).toBeNull();
    expect(probeCalled).toBe(false);
  });

  it('iterates newest-first and returns the first probe-confirmed-alive session', async () => {
    const task = withTask([
      mkSession({ tmuxSession: 'old' }),
      mkSession({ tmuxSession: 'mid' }),
      mkSession({ tmuxSession: 'new' }),
    ]);
    // Both 'mid' and 'new' are alive; the helper must pick 'new' (newest first).
    const backend = fakeBackend((id) => id === 'mid' || id === 'new');
    const result = await probeStartupLiveness(task, backend);
    expect(result?.tmuxSession).toBe('new');
  });

  it('skips crash-recovered sessions even if isAlive returns true', async () => {
    const task = withTask([
      mkSession({ tmuxSession: 'recovered', crashRecovered: true }),
    ]);
    const backend = fakeBackend(() => true);
    const result = await probeStartupLiveness(task, backend);
    expect(result).toBeNull();
  });
});
