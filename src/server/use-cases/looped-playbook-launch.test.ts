import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import type { RalphLoopService } from '../ralph-loop-service.js';
import { launchLoopedPlaybook, LoopedPlaybookLaunchError } from './looped-playbook-launch.js';

async function withPlaybook(content: string, fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'looped-playbook-'));
  try {
    await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
    await writeFile(join(cwd, '.kookr', 'playbooks', 'workflow.md'), content);
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('launchLoopedPlaybook', () => {
  it('launches a loopable playbook with bounded Ralph config', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
loop:
  iterationCap: 7
  zeroDiffConsecutiveIterations: 2
  costCapUsd: 3
parameters:
  - name: target
    required: true
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const startLoop = vi.fn(async () => ({ ok: true, changed: true, value: undefined }));
      const launchTask = vi.fn(async (opts) => {
        const task = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookParameterValues: opts.playbookParameterValues,
        });
        task.playbookId = opts.playbookId;
        return { task, queued: false };
      });

      const result = await launchLoopedPlaybook({
        taskStore,
        launchTask,
        ralphLoopService: { startLoop } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      });

      expect(result.task.playbookId).toBe('workflow.md');
      expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
        disableDedup: true,
        prompt: expect.stringContaining('This runtime is one loop iteration, not the whole loop.'),
      }));
      const launchPrompt = launchTask.mock.calls[0][0].prompt;
      expect(launchPrompt).toContain('iteration cap of 7');
      expect(launchPrompt).toContain('complete at most one missing phase or one small unit of work');
      expect(launchPrompt).toContain('Loop repo.');
      expect(startLoop).toHaveBeenCalledWith(result.task, {
        prompt: launchPrompt,
        iterationCap: 7,
        zeroDiffConvergence: { consecutiveIterations: 2 },
        costCapUsd: 3,
      });
    });
  });

  it('forwards stopPredicate from playbook frontmatter into the Ralph loop request', async () => {
    await withPlaybook(`---
name: Predicate loop
tags: [workflow, loopable]
loop:
  iterationCap: 5
  stopPredicate: 'test -f .batch-stop && grep -qE "^STOP:" .batch-stop'
---

Body.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const startLoop = vi.fn(async () => ({ ok: true, changed: true, value: undefined }));
      const launchTask = vi.fn(async (opts) => {
        const task = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookParameterValues: opts.playbookParameterValues,
        });
        task.playbookId = opts.playbookId;
        return { task, queued: false };
      });

      await launchLoopedPlaybook({
        taskStore,
        launchTask,
        ralphLoopService: { startLoop } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: {},
      });

      const startLoopArgs = startLoop.mock.calls[0]?.[1] as { stopPredicate?: string } | undefined;
      expect(startLoopArgs?.stopPredicate).toBe('test -f .batch-stop && grep -qE "^STOP:" .batch-stop');
    });
  });

  it('rejects non-loopable playbooks before creating a task', async () => {
    await withPlaybook(`---
name: Plain
---

Run once.
`, async (cwd) => {
      const launchTask = vi.fn();

      await expect(launchLoopedPlaybook({
        taskStore: new TaskStore(),
        launchTask,
        ralphLoopService: { startLoop: vi.fn() } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: {},
      })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('not tagged loopable'),
      } satisfies Partial<LoopedPlaybookLaunchError>);

      expect(launchTask).not.toHaveBeenCalled();
    });
  });

  it('rejects duplicate active looped playbook tasks', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const existing = taskStore.createTask({
        prompt: 'Loop repo.',
        cwd,
        playbookParameterValues: { target: 'repo' },
      });
      existing.playbookId = 'workflow.md';
      existing.ralphLoop = {
        prompt: 'Loop repo.',
        iterationCap: 6,
        currentIteration: 0,
        status: 'running',
        lastIterationStartedAt: Date.now(),
        cumulativeIterations: 0,
      };

      const launchTask = vi.fn();

      await expect(launchLoopedPlaybook({
        taskStore,
        launchTask,
        ralphLoopService: { startLoop: vi.fn() } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      })).rejects.toMatchObject({
        status: 409,
        details: { taskId: existing.id },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      expect(launchTask).not.toHaveBeenCalled();
    });
  });

  it('rejects looped playbook launch when active task capacity is full', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop.
`, async (cwd) => {
      const launchTask = vi.fn();

      await expect(launchLoopedPlaybook({
        taskStore: new TaskStore(),
        launchTask,
        getMaxActiveTasks: () => 0,
        ralphLoopService: { startLoop: vi.fn() } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: {},
      })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('task queue is full'),
      } satisfies Partial<LoopedPlaybookLaunchError>);

      expect(launchTask).not.toHaveBeenCalled();
    });
  });
});
