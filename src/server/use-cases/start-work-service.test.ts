import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startWork, type StartWorkDeps } from './start-work-service.js';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';

describe('startWork', () => {
  let deps: StartWorkDeps;
  let attemptRepo: WorkspaceAttemptRepository;
  let mockLaunchTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    attemptRepo = new WorkspaceAttemptRepository();
    mockLaunchTask = vi.fn().mockResolvedValue({
      task: { id: 'task-123', prompt: 'test', cwd: '/repo', status: 'open', sessions: [] },
      queued: false,
    });
    deps = {
      launchTask: mockLaunchTask,
      attemptRepository: attemptRepo,
    };
  });

  it('delegates to launchTask with the prompt', async () => {
    const result = await startWork(deps, {
      projectId: 'github.com/org/repo',
      cwd: '/repo',
      prompt: 'fix the bug',
    });

    expect(mockLaunchTask).toHaveBeenCalledWith({
      prompt: 'fix the bug',
      cwd: '/repo',
      playbookId: undefined,
    });
    expect(result.launchResult.task.id).toBe('task-123');
    expect(result.attemptId).toBeTruthy();
    expect(result.handoffId).toBeTruthy();
  });

  it('appends issue reference to prompt', async () => {
    await startWork(deps, {
      projectId: 'github.com/org/repo',
      cwd: '/repo',
      prompt: 'fix the bug',
      issueRef: '#42',
    });

    expect(mockLaunchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'fix the bug\n\nRelated issue: #42',
      }),
    );
  });

  it('records a passed attempt on success', async () => {
    const result = await startWork(deps, {
      projectId: 'proj',
      cwd: '/repo',
      prompt: 'test',
    });

    const attempt = attemptRepo.getAttempt(result.attemptId);
    expect(attempt?.status).toBe('passed');
    expect(attempt?.disposition).toBe('passed');
  });

  it('records a blocked attempt on launch failure', async () => {
    mockLaunchTask.mockRejectedValue(new Error('adapter failed'));

    await expect(startWork(deps, {
      projectId: 'proj',
      cwd: '/repo',
      prompt: 'test',
    })).rejects.toThrow('adapter failed');

    const attempts = attemptRepo.listByProject('proj');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('blocked');
    expect(attempts[0].evidenceSummary).toContain('adapter failed');
  });

  it('records a handoff on success', async () => {
    const result = await startWork(deps, {
      projectId: 'proj',
      cwd: '/repo',
      prompt: 'test prompt',
    });

    const handoffs = attemptRepo.listHandoffsByProject('proj');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].taskId).toBe('task-123');
    expect(handoffs[0].handoffId).toBe(result.handoffId);
  });

  it('passes through playbookId', async () => {
    await startWork(deps, {
      projectId: 'proj',
      cwd: '/repo',
      prompt: 'run playbook',
      playbookId: 'my-playbook',
    });

    expect(mockLaunchTask).toHaveBeenCalledWith(
      expect.objectContaining({ playbookId: 'my-playbook' }),
    );
  });
});
