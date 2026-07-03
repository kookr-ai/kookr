import { describe, expect, test, vi } from 'vitest';
import { CircuitBreaker } from '../../core/circuit-breaker.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { createPermissionBlockAlertProcessor, formatToolInput } from './permission-block-alert-processor.js';

function permissionBlocked(): NonNullable<AgentState['anomaly']> {
  return {
    agentId: 'kookr-agent',
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'permission required',
    detectedAt: new Date(),
  };
}

function state(anomaly: AgentState['anomaly']): AgentState {
  return {
    agentId: 'kookr-agent',
    anomaly,
    events: [{
      type: 'permission_request',
      sessionId: 's1',
      toolName: 'Bash',
      toolInput: { command: 'git push origin arch/event-pipeline-processors --force-with-lease' },
    }],
  };
}

describe('PermissionBlockAlertProcessor', () => {
  test('formats common tool inputs compactly', () => {
    expect(formatToolInput({ command: 'x'.repeat(70) })).toHaveLength(60);
    expect(formatToolInput({ file_path: '/tmp/file.txt' })).toBe('/tmp/file.txt');
    expect(formatToolInput(null)).toBe('');
  });

  test('fires the callback only when entering permission_blocked', () => {
    const onPermissionBlocked = vi.fn();
    const taskStore = {
      findTaskBySession: vi.fn().mockReturnValue({ id: 'task-1' }),
    };
    const processor = createPermissionBlockAlertProcessor({
      taskLookup: taskStore,
      onPermissionBlocked,
    });

    processor.process({
      tmuxName: 'kookr-agent',
      preState: state(null),
      postState: state(permissionBlocked()),
    });
    processor.process({
      tmuxName: 'kookr-agent',
      preState: state(permissionBlocked()),
      postState: state(permissionBlocked()),
    });

    expect(onPermissionBlocked).toHaveBeenCalledTimes(1);
    expect(onPermissionBlocked).toHaveBeenCalledWith(
      'task-1',
      'Bash(git push origin arch/event-pipeline-processors --force-with-)',
    );
  });

  test('warns and opens the breaker when callback failures repeat', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onPermissionBlocked = vi.fn(() => { throw new Error('telegram down'); });
    const permissionAlertBreaker = new CircuitBreaker({
      name: 'permission-alert-test',
      failureThreshold: 2,
      failureWindowMs: 60_000,
      resetTimeoutMs: 60_000,
    });
    const processor = createPermissionBlockAlertProcessor({
      taskLookup: {
        findTaskBySession: vi.fn().mockReturnValue({ id: 'task-1' }),
      },
      onPermissionBlocked,
      permissionAlertBreaker,
    });

    expect(() => processor.process({
      tmuxName: 'kookr-agent',
      preState: state(null),
      postState: state(permissionBlocked()),
    })).not.toThrow();
    expect(permissionAlertBreaker.getState()).toBe('closed');

    expect(() => processor.process({
      tmuxName: 'kookr-agent',
      preState: state(null),
      postState: state(permissionBlocked()),
    })).not.toThrow();
    expect(permissionAlertBreaker.getState()).toBe('open');

    processor.process({
      tmuxName: 'kookr-agent',
      preState: state(null),
      postState: state(permissionBlocked()),
    });

    expect(onPermissionBlocked).toHaveBeenCalledTimes(2);
    expect(permissionAlertBreaker.getSnapshot().rejectedCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[permission-block-alert-processor] onPermissionBlocked threw:',
      expect.any(Error),
    );
    expect(warn).toHaveBeenCalledWith(
      '[permission-block-alert-processor] permission-alert breaker open; skipped onPermissionBlocked',
    );

    permissionAlertBreaker.dispose();
    warn.mockRestore();
  });
});
