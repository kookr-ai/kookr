import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { getTask } from './api/tasks.js';
import { relaunchFromAgent } from './relaunch-from-agent.js';
import type { RelaunchTask } from './store/store-types.js';

vi.mock('./api/tasks.js', () => ({
  getTask: vi.fn(),
}));

function completedAgent(overrides: Partial<AgentState> = {}): Pick<
  AgentState,
  'taskId' | 'cwd' | 'agentType' | 'description' | 'playbookId' | 'playbookParameterValues'
> {
  return {
    taskId: 'task-1',
    cwd: '/tmp/kookr',
    agentType: 'claude-code',
    description: 'Ship the dashboard next actions slice',
    ...overrides,
  };
}

describe('relaunchFromAgent', () => {
  beforeEach(() => {
    vi.mocked(getTask).mockReset();
  });

  test('fetches prompt/criteria and stores them for Launch prefill', async () => {
    vi.mocked(getTask).mockResolvedValue({
      prompt: 'Prefill from the task API, not the snapshot row',
      cwd: '/tmp/from-api',
      criteria: 'Merged PR, tests green',
      agentType: 'grok-build',
    });
    const setRelaunchTask = vi.fn<(task: RelaunchTask) => void>();

    await relaunchFromAgent(completedAgent(), setRelaunchTask);

    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(setRelaunchTask).toHaveBeenCalledWith({
      sourceTaskId: 'task-1',
      prompt: 'Prefill from the task API, not the snapshot row',
      cwd: '/tmp/from-api',
      criteria: 'Merged PR, tests green',
      agentType: 'grok-build',
    });
  });

  test('does not open Launch when the task fetch fails or returns an error body', async () => {
    const setRelaunchTask = vi.fn<(task: RelaunchTask) => void>();

    vi.mocked(getTask).mockRejectedValueOnce(new Error('network'));
    await relaunchFromAgent(completedAgent(), setRelaunchTask);

    vi.mocked(getTask).mockResolvedValueOnce({ error: 'not found' });
    await relaunchFromAgent(completedAgent(), setRelaunchTask);

    vi.mocked(getTask).mockResolvedValueOnce(null);
    await relaunchFromAgent(completedAgent(), setRelaunchTask);

    expect(setRelaunchTask).not.toHaveBeenCalled();
  });

  test('reuses playbook fields without fetching the task body', async () => {
    const setRelaunchTask = vi.fn<(task: RelaunchTask) => void>();

    await relaunchFromAgent(
      completedAgent({
        playbookId: 'oss-pr-lessons',
        playbookParameterValues: { repo: 'kookr-ai/kookr' },
      }),
      setRelaunchTask,
    );

    expect(getTask).not.toHaveBeenCalled();
    expect(setRelaunchTask).toHaveBeenCalledWith({
      sourceTaskId: 'task-1',
      prompt: 'Ship the dashboard next actions slice',
      cwd: '/tmp/kookr',
      agentType: 'claude-code',
      playbookId: 'oss-pr-lessons',
      playbookParameterValues: { repo: 'kookr-ai/kookr' },
    });
  });

  test('carries the exact playbook source identity for identity-matched relaunch', async () => {
    const setRelaunchTask = vi.fn<(task: RelaunchTask) => void>();
    const playbookSource = {
      id: 'oss-pr-lessons.md',
      scope: 'user' as const,
      sourceCwd: '/home/dev/.kookr/playbooks',
      sourceDigest: 'sha-1',
    };

    await relaunchFromAgent(
      completedAgent({
        playbookId: 'oss-pr-lessons.md',
        playbookParameterValues: { repo: 'kookr-ai/kookr' },
        playbookSource,
      }),
      setRelaunchTask,
    );

    expect(getTask).not.toHaveBeenCalled();
    expect(setRelaunchTask).toHaveBeenCalledWith({
      sourceTaskId: 'task-1',
      prompt: 'Ship the dashboard next actions slice',
      cwd: '/tmp/kookr',
      agentType: 'claude-code',
      playbookId: 'oss-pr-lessons.md',
      playbookParameterValues: { repo: 'kookr-ai/kookr' },
      playbookSource,
    });
  });

  test('does nothing when the agent has no task id', async () => {
    const setRelaunchTask = vi.fn<(task: RelaunchTask) => void>();

    await relaunchFromAgent(completedAgent({
      taskId: undefined,
      playbookId: 'oss-pr-lessons',
      playbookParameterValues: { repo: 'kookr-ai/kookr' },
    }), setRelaunchTask);

    expect(getTask).not.toHaveBeenCalled();
    expect(setRelaunchTask).not.toHaveBeenCalled();
  });
});
