import { describe, expect, it, vi } from 'vitest';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { TerminalInputCoordinator } from './terminal-input-coordinator.js';

const encoder = new TextEncoder();

describe('TerminalInputCoordinator', () => {
  async function setup(sessionId = 's1') {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: sessionId, command: 'agent', args: [] });
    const coordinator = new TerminalInputCoordinator(backend);
    coordinator.registerSession(sessionId);
    return { backend, coordinator, sessionId };
  }

  it('increments readinessVersion and clears prompt readiness before accepted writes', async () => {
    const { coordinator, sessionId } = await setup();
    const initial = coordinator.getSnapshot(sessionId)!;
    expect(initial.readinessVersion).toBe(0);

    const readyAccepted = await coordinator.markPromptReady(sessionId, {
      observedEpoch: initial.inputStateEpoch,
      observedReadinessVersion: initial.readinessVersion,
    });
    expect(readyAccepted).toBe(true);

    const result = await coordinator.writeInput(sessionId, encoder.encode('x'), { reason: 'test' });
    const snapshot = coordinator.getSnapshot(sessionId)!;
    expect(result.readinessVersion).toBe(1);
    expect(snapshot.readinessVersion).toBe(1);
    expect(snapshot.prompt.kind).toBe('unknown');
  });

  it('accepts prompt-ready only for the current epoch and readiness version', async () => {
    const { coordinator, sessionId } = await setup();
    const snapshot = coordinator.getSnapshot(sessionId)!;

    await coordinator.writeInput(sessionId, encoder.encode('draft'));

    await expect(coordinator.markPromptReady(sessionId, {
      observedEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    })).resolves.toBe(false);
    expect(coordinator.getSnapshot(sessionId)!.prompt.kind).toBe('unknown');
  });

  it('rejects stale, blocked, unknown, and missing empty-enter intents without writing Enter', async () => {
    const { backend, coordinator, sessionId } = await setup();
    const initial = coordinator.getSnapshot(sessionId)!;
    const base = {
      type: 'emptyEnterIntent' as const,
      intentId: 'intent-1',
      taskId: 'task-1',
      sessionId,
      selectionVersion: 1,
      inputStateEpoch: initial.inputStateEpoch,
      observedReadinessVersion: initial.readinessVersion,
    };

    await expect(coordinator.handleEmptyEnterIntent(base)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'not-ready',
    });

    await coordinator.markPermissionBlocked(sessionId);
    const blocked = coordinator.getSnapshot(sessionId)!;
    await expect(coordinator.handleEmptyEnterIntent({
      ...base,
      inputStateEpoch: blocked.inputStateEpoch,
      observedReadinessVersion: blocked.readinessVersion,
    })).resolves.toMatchObject({ kind: 'rejected', reason: 'blocked' });

    coordinator.cleanupSession(sessionId);
    await expect(coordinator.handleEmptyEnterIntent(base)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'session-gone',
    });
    expect(backend.getWrittenText(sessionId)).not.toContain('\r');
  });

  it('approves valid empty-enter intents but never forwards Enter', async () => {
    const { backend, coordinator, sessionId } = await setup();
    const snapshot = coordinator.getSnapshot(sessionId)!;
    await coordinator.markPromptReady(sessionId, {
      observedEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    });

    await expect(coordinator.handleEmptyEnterIntent({
      type: 'emptyEnterIntent',
      intentId: 'intent-1',
      taskId: 'task-1',
      sessionId,
      selectionVersion: 1,
      inputStateEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    })).resolves.toMatchObject({
      kind: 'valid-empty-enter',
      decisionReadinessVersion: snapshot.readinessVersion,
    });
    expect(backend.getWrittenText(sessionId)).not.toContain('\r');
  });

  it('rejects prompt-ready marks while a write is in-flight', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    const coordinator = new TerminalInputCoordinator(backend);
    coordinator.registerSession('s1');
    const writeSpy = vi.spyOn(backend, 'write').mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 20)),
    );

    const write = coordinator.writeInput('s1', encoder.encode('x'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = coordinator.getSnapshot('s1')!;
    expect(snapshot.readinessVersion).toBe(1);
    await expect(coordinator.markPromptReady('s1', {
      observedEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    })).resolves.toBe(false);
    await write;
    writeSpy.mockRestore();
  });
});
