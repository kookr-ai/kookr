import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import type { RalphLoopService } from '../ralph-loop-service.js';
import {
  launchLoopedPlaybook,
  LoopedPlaybookLaunchError,
  replaceLoopedPlaybook,
} from './looped-playbook-launch.js';

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
      const startLoop = vi.fn(async (task, input) => {
        taskStore.getTaskForMutation(task.id)!.ralphLoop = {
          prompt: input.prompt,
          iterationCap: input.iterationCap,
          currentIteration: 0,
          status: 'running',
          lastIterationStartedAt: 0,
          cumulativeIterations: 0,
        };
        return { ok: true, changed: true, value: taskStore.getTask(task.id)!.ralphLoop };
      });
      const launchTask = vi.fn(async (opts) => {
        const task = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookId: opts.playbookId,
          playbookParameterValues: opts.playbookParameterValues,
        });
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
        parentTaskId: 'original-task',
        modelTier: 'small',
      });

      expect(result.task.playbookId).toBe('workflow.md');
      expect(launchTask).toHaveBeenCalledWith(
        expect.objectContaining({
          disableDedup: true,
          modelTier: 'small',
          parentTaskId: 'original-task',
          userInitiatedRelaunch: true,
          prompt: expect.stringContaining('This runtime is one loop iteration, not the whole loop.'),
        }),
        { deliveryPolicy: 'pre-authorized' },
      );
      const launchPrompt = launchTask.mock.calls[0][0].prompt;
      expect(launchPrompt).toContain('iteration cap of 7');
      expect(launchPrompt).toContain('complete at most one missing phase or one small unit of work');
      expect(launchPrompt).toContain('Loop repo.');
      expect(startLoop).toHaveBeenCalledWith(expect.objectContaining({ id: result.task.id }), {
        prompt: launchPrompt,
        iterationCap: 7,
        zeroDiffConvergence: { consecutiveIterations: 2 },
        costCapUsd: 3,
      });
      expect(result.task.ralphLoop).toMatchObject({
        prompt: launchPrompt,
        iterationCap: 7,
        status: 'running',
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
          playbookId: opts.playbookId,
          playbookParameterValues: opts.playbookParameterValues,
        });
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

  it('passes pre-authorized delivery policy for loopable playbooks', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
deliveryPreAuthorized: true
---

Loop.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const startLoop = vi.fn(async () => ({ ok: true, changed: true, value: undefined }));
      const launchTask = vi.fn(async (opts) => {
        const task = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookId: opts.playbookId,
          playbookParameterValues: opts.playbookParameterValues,
        });
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

      expect(launchTask).toHaveBeenCalledWith(
        expect.objectContaining({ disableDedup: true }),
        { deliveryPolicy: 'pre-authorized' },
      );
    });
  });

  it('propagates the deliveryPreAuthorized:false opt-out as ask-first delivery policy', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
deliveryPreAuthorized: false
---

Loop.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const startLoop = vi.fn(async () => ({ ok: true, changed: true, value: undefined }));
      const launchTask = vi.fn(async (opts) => {
        const task = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookId: opts.playbookId,
          playbookParameterValues: opts.playbookParameterValues,
        });
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

      expect(launchTask).toHaveBeenCalledWith(
        expect.objectContaining({ disableDedup: true }),
        { deliveryPolicy: 'ask-first' },
      );
    });
  });

  it('marks a partially-started loop failed when startLoop throws', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const launchedTaskIds: string[] = [];
      const launchTask = vi.fn(async (opts) => {
        const task = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookId: opts.playbookId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        launchedTaskIds.push(task.id);
        taskStore.getTaskForMutation(task.id)!.ralphLoop = {
          prompt: opts.prompt,
          iterationCap: 6,
          currentIteration: 0,
          status: 'running',
          lastIterationStartedAt: 0,
          cumulativeIterations: 0,
        };
        return { task, queued: false };
      });
      const markLoopFailed = vi.fn((taskId: string) => {
        const task = taskStore.getTaskForMutation(taskId);
        if (task?.ralphLoop) task.ralphLoop.status = 'failed';
        return true;
      });
      const cleanupFailedTask = vi.fn(async () => undefined);

      await expect(launchLoopedPlaybook({
        taskStore,
        launchTask,
        ralphLoopService: {
          startLoop: vi.fn(async () => {
            throw new Error('start failed');
          }),
          markLoopFailed,
        } as unknown as RalphLoopService,
        cleanupFailedTask,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: {},
      })).rejects.toThrow('start failed');

      expect(markLoopFailed).toHaveBeenCalledWith(launchedTaskIds[0]);
      expect(cleanupFailedTask).toHaveBeenCalledWith(launchedTaskIds[0]);
      expect(taskStore.getTask(launchedTaskIds[0]!)!.ralphLoop!.status).toBe('failed');
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
        playbookId: 'workflow.md',
        playbookParameterValues: { target: 'repo' },
      });
      taskStore.getTaskForMutation(existing.id)!.ralphLoop = {
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
        details: {
          taskId: existing.id,
          // The new conflictKind discriminator + ralphLoop snapshot are what
          // the frontend narrows on to render the inline confirm dialog.
          conflictKind: 'duplicate_active_loop',
          ralphLoop: {
            status: 'running',
            currentIteration: 0,
          },
        },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      expect(launchTask).not.toHaveBeenCalled();
    });
  });

  it('reports duplicate active loop before standalone plugin coexistence', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(
        join(cwd, '.claude', 'settings.local.json'),
        JSON.stringify({ enabledPlugins: { 'ralph-wiggum@claude-code-plugins': true } }),
      );

      const taskStore = new TaskStore();
      const existing = taskStore.createTask({
        prompt: 'Loop repo.',
        cwd,
        playbookId: 'workflow.md',
        playbookParameterValues: { target: 'repo' },
      });
      taskStore.getTaskForMutation(existing.id)!.ralphLoop = {
        prompt: 'Loop repo.',
        iterationCap: 6,
        currentIteration: 2,
        status: 'running',
        lastIterationStartedAt: Date.now(),
        cumulativeIterations: 2,
      };

      await expect(launchLoopedPlaybook({
        taskStore,
        launchTask: vi.fn(),
        ralphLoopService: { startLoop: vi.fn() } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      })).rejects.toMatchObject({
        status: 409,
        details: {
          taskId: existing.id,
          conflictKind: 'duplicate_active_loop',
          ralphLoop: {
            currentIteration: 2,
          },
        },
      } satisfies Partial<LoopedPlaybookLaunchError>);
    });
  });

  it('returns a typed standalone-plugin conflict when no duplicate loop exists', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop.
`, async (cwd) => {
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(
        join(cwd, '.claude', 'settings.local.json'),
        JSON.stringify({ enabledPlugins: { 'ralph-wiggum@claude-code-plugins': true } }),
      );

      await expect(launchLoopedPlaybook({
        taskStore: new TaskStore(),
        launchTask: vi.fn(),
        ralphLoopService: { startLoop: vi.fn() } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: {},
      })).rejects.toMatchObject({
        status: 409,
        details: {
          conflictKind: 'standalone_ralph_plugin',
          code: 'standalone_ralph_plugin_detected',
          matchedFiles: [join(cwd, '.claude', 'settings.local.json')],
          reasons: ['enabledPlugins["ralph-wiggum@claude-code-plugins"] is true'],
        },
      } satisfies Partial<LoopedPlaybookLaunchError>);
    });
  });

  it('cancelled+cancelled task is excluded from the active-loop check', async () => {
    // Regression for the post-Replace state: cancelTaskLifecycle sets
    // task.status='cancelled' and cancelLoop sets loop.status='cancelled'.
    // findActiveLoopedPlaybook must NOT match this combination, otherwise
    // the launch following Replace would 409 against the loop it just
    // killed.
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const stale = taskStore.createTask({
        prompt: 'Loop repo.',
        cwd,
        playbookId: 'workflow.md',
        playbookParameterValues: { target: 'repo' },
      });
      taskStore.cancelTask(stale.id);
      taskStore.getTaskForMutation(stale.id)!.ralphLoop = {
        prompt: 'Loop repo.',
        iterationCap: 6,
        currentIteration: 0,
        status: 'cancelled',
        lastIterationStartedAt: 0,
        cumulativeIterations: 0,
      };

      const startLoop = vi.fn(async () => ({ ok: true, changed: true, value: undefined }));
      const launchTask = vi.fn(async (opts) => {
        const t = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookParameterValues: opts.playbookParameterValues,
        });
        t.playbookId = opts.playbookId;
        return { task: t, queued: false };
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

      // Launch succeeded — the cancelled stale task did not block.
      expect(result.task.id).not.toBe(stale.id);
      expect(launchTask).toHaveBeenCalledOnce();
    });
  });

  it('loads looped playbooks from the catalog cwd and launches in the target cwd', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'looped-playbook-source-'));
    const targetCwd = await mkdtemp(join(tmpdir(), 'looped-playbook-target-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'workflow.md'), `---
name: Loopable
tags: [workflow, loopable]
---

Loop in docs/target-note.md.
`);
      await mkdir(join(targetCwd, 'docs'), { recursive: true });
      await writeFile(join(targetCwd, 'docs', 'target-note.md'), 'target');

      const taskStore = new TaskStore();
      const startLoop = vi.fn(async () => ({ ok: true, changed: true, value: undefined }));
      const launchTask = vi.fn(async (opts) => {
        const task = taskStore.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        return { task, queued: false };
      });

      const result = await launchLoopedPlaybook({
        taskStore,
        launchTask,
        ralphLoopService: { startLoop } as unknown as RalphLoopService,
      }, {
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: targetCwd,
        projectId: `local/${basename(targetCwd)}`,
        playbookPath: 'workflow.md',
        parameterValues: {},
      });

      expect(result.task.cwd).toBe(targetCwd);
      expect(result.task.projectId).toBe(`local/${basename(targetCwd)}`);
      expect(launchTask).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: targetCwd,
          projectId: `local/${basename(targetCwd)}`,
        }),
        { deliveryPolicy: 'pre-authorized' },
      );
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(targetCwd, { recursive: true, force: true });
    }
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

  it('starts the Ralph loop when launch is parked for dependency recovery', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
dependencies: [kb]
---

Loop.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask({ prompt: 'Loop.', cwd, playbookId: 'workflow.md' });
      const startLoop = vi.fn(async () => ({ ok: true, changed: true, value: undefined }));
      const launchTask = vi.fn(async () => ({
        task,
        queued: true,
        parked: true,
      }));

      const result = await launchLoopedPlaybook({
        taskStore,
        launchTask,
        ralphLoopService: { startLoop } as unknown as RalphLoopService,
      }, {
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: {},
      });

      expect(result.parked).toBe(true);
      expect(launchTask).toHaveBeenCalledWith(
        expect.objectContaining({ dependencies: ['kb'] }),
        { deliveryPolicy: 'pre-authorized' },
      );
      expect(startLoop).toHaveBeenCalledOnce();
      expect(startLoop).toHaveBeenCalledWith(task, expect.objectContaining({ prompt: expect.any(String) }));
    });
  });
});

describe('replaceLoopedPlaybook', () => {
  function setupActiveLoop(taskStore: TaskStore, cwd: string) {
    const old = taskStore.createTask({
      prompt: 'Loop repo.',
      cwd,
      playbookId: 'workflow.md',
      playbookParameterValues: { target: 'repo' },
    });
    taskStore.getTaskForMutation(old.id)!.ralphLoop = {
      prompt: 'Loop repo.',
      iterationCap: 6,
      currentIteration: 3,
      status: 'running',
      lastIterationStartedAt: Date.now(),
      cumulativeIterations: 3,
    };
    return old;
  }

  function makeLaunchTask(taskStore: TaskStore) {
    return vi.fn(async (opts) => {
      const t = taskStore.createTask({
        prompt: opts.prompt,
        cwd: opts.cwd,
        playbookId: opts.playbookId,
        projectId: opts.projectId,
        playbookParameterValues: opts.playbookParameterValues,
      });
      return { task: t, queued: false };
    });
  }

  const baseDeps = (taskStore: TaskStore, overrides: Record<string, unknown> = {}) => ({
    taskStore,
    launchTask: makeLaunchTask(taskStore),
    ralphLoopService: {
      cancelLoop: vi.fn((task) => {
        const mutableTask = taskStore.getTaskForMutation(task.id);
        if (mutableTask?.ralphLoop && mutableTask.ralphLoop.status === 'running') {
          mutableTask.ralphLoop.status = 'cancelled';
        }
        return { ok: true, value: 'cancelled', changed: true };
      }),
      startLoop: vi.fn(async (task, input) => {
        taskStore.getTaskForMutation(task.id)!.ralphLoop = {
          prompt: input.prompt,
          iterationCap: input.iterationCap,
          currentIteration: 0,
          status: 'running',
          lastIterationStartedAt: 0,
          cumulativeIterations: 0,
        };
        return { ok: true, changed: true, value: taskStore.getTask(task.id)!.ralphLoop };
      }),
    } as unknown as RalphLoopService,
    cancelReplacedTask: vi.fn(async () => undefined),
    ...overrides,
  });

  it('flips loop.status="cancelled" BEFORE invoking lifecycle cancel', async () => {
    // Race protection: a buffered Stop event from the old session must see
    // loop.status='cancelled' (not 'running') by the time it reaches the
    // cycler, otherwise the cycler spawns iteration N+1 over the doomed
    // session. Mirrors the precedent in ws-handlers/lifecycle-handler.ts.
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, cwd);
      const order: string[] = [];

      const ralphLoopService = {
        cancelLoop: vi.fn((task) => {
          order.push('cancelLoop');
          // cancelLoop in production flips loop.status synchronously.
          const mutableTask = taskStore.getTaskForMutation(task.id);
          if (mutableTask?.ralphLoop && mutableTask.ralphLoop.status === 'running') {
            mutableTask.ralphLoop.status = 'cancelled';
          }
          return { ok: true, value: 'cancelled', changed: true };
        }),
        startLoop: vi.fn(async () => ({ ok: true, changed: true, value: undefined })),
      };
      const cancelReplacedTask = vi.fn(async (taskId) => {
        order.push('cancelReplacedTask');
        // At this point loop.status MUST already be 'cancelled' — otherwise
        // a Stop event arriving during this await spawns iteration N+1.
        const t = taskStore.getTaskForMutation(taskId);
        expect(t?.ralphLoop?.status).toBe('cancelled');
        taskStore.cancelTask(taskId);
      });

      await replaceLoopedPlaybook({
        taskStore,
        launchTask: makeLaunchTask(taskStore),
        ralphLoopService: ralphLoopService as unknown as RalphLoopService,
        cancelReplacedTask,
      } as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      });

      expect(order).toEqual(['cancelLoop', 'cancelReplacedTask']);
      expect(ralphLoopService.cancelLoop).toHaveBeenCalledWith(expect.objectContaining({ id: old.id }));
    });
  });

  it('cancels the old task and launches a new one when keys match', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, cwd);
      const cancelReplacedTask = vi.fn(async (taskId) => {
        // Simulate what real cancelTaskLifecycle does.
        taskStore.cancelTask(taskId);
        const t = taskStore.getTaskForMutation(taskId);
        if (t?.ralphLoop) t.ralphLoop.status = 'cancelled';
      });
      const writeReplaceAudit = vi.fn(async () => undefined);
      const deps = baseDeps(taskStore, { cancelReplacedTask, writeReplaceAudit });

      const { result, oldIteration } = await replaceLoopedPlaybook(deps as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      });

      expect(cancelReplacedTask).toHaveBeenCalledWith(old.id);
      expect(result.task.id).not.toBe(old.id);
      expect(result.task.ralphLoop).toMatchObject({
        prompt: expect.stringContaining('Loop {{target}}.'),
        status: 'running',
      });
      expect(oldIteration).toBe(3);
      expect(writeReplaceAudit).toHaveBeenCalledWith(expect.objectContaining({
        replacedTaskId: old.id,
        newTaskId: result.task.id,
        oldIteration: 3,
      }));
    });
  });

  it('passes pre-authorized delivery policy when replacing a looped playbook', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
deliveryPreAuthorized: true
parameters:
  - name: target
    required: true
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, cwd);
      const deps = baseDeps(taskStore);

      await replaceLoopedPlaybook(deps as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      });

      expect(deps.launchTask).toHaveBeenCalledWith(
        expect.objectContaining({ disableDedup: true }),
        { deliveryPolicy: 'pre-authorized' },
      );
    });
  });

  it('returns a typed standalone-plugin conflict before replacing the old runtime', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(
        join(cwd, '.claude', 'settings.local.json'),
        JSON.stringify({ enabledPlugins: { 'ralph-wiggum@claude-code-plugins': true } }),
      );

      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, cwd);
      const cancelReplacedTask = vi.fn(async () => undefined);

      await expect(replaceLoopedPlaybook(baseDeps(taskStore, { cancelReplacedTask }) as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      })).rejects.toMatchObject({
        status: 409,
        details: {
          conflictKind: 'standalone_ralph_plugin',
          code: 'standalone_ralph_plugin_detected',
          matchedFiles: [join(cwd, '.claude', 'settings.local.json')],
        },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      expect(cancelReplacedTask).not.toHaveBeenCalled();
    });
  });

  it('returns 400 with replacedTaskId_key_mismatch when input params do not match the stored task', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, cwd);
      const cancelReplacedTask = vi.fn(async () => undefined);
      const deps = baseDeps(taskStore, { cancelReplacedTask });

      await expect(replaceLoopedPlaybook(deps as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'OTHER' }, // mismatch
      })).rejects.toMatchObject({
        status: 400,
        details: { code: 'replacedTaskId_key_mismatch' },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      expect(cancelReplacedTask).not.toHaveBeenCalled();
    });
  });

  it('matches replace-loop keys against the target cwd when catalog and target differ', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'replace-looped-source-'));
    const targetCwd = await mkdtemp(join(tmpdir(), 'replace-looped-target-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'workflow.md'), `---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`);

      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, targetCwd);
      const cancelReplacedTask = vi.fn(async (taskId) => {
        taskStore.cancelTask(taskId);
        const t = taskStore.getTask(taskId);
        if (t?.ralphLoop) t.ralphLoop.status = 'cancelled';
      });
      const deps = baseDeps(taskStore, { cancelReplacedTask });

      await expect(replaceLoopedPlaybook(baseDeps(taskStore) as never, {
        replacedTaskId: old.id,
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: sourceCwd,
        projectId: `local/${basename(sourceCwd)}`,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      })).rejects.toMatchObject({
        status: 400,
        details: { code: 'replacedTaskId_key_mismatch' },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      const { result } = await replaceLoopedPlaybook(deps as never, {
        replacedTaskId: old.id,
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: targetCwd,
        projectId: `local/${basename(targetCwd)}`,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      });

      expect(result.task.cwd).toBe(targetCwd);
      expect(result.task.projectId).toBe(`local/${basename(targetCwd)}`);
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(targetCwd, { recursive: true, force: true });
    }
  });

  it('returns 400 when replacedTaskId is unknown', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const cancelReplacedTask = vi.fn(async () => undefined);
      const deps = baseDeps(taskStore, { cancelReplacedTask });

      await expect(replaceLoopedPlaybook(deps as never, {
        replacedTaskId: 'does-not-exist',
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      })).rejects.toMatchObject({
        status: 400,
        details: { code: 'replacedTaskId_not_found' },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      expect(cancelReplacedTask).not.toHaveBeenCalled();
    });
  });

  it('returns 500 with lifecycle_cancel_failed and DOES NOT launch when cancel throws', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, cwd);
      const launchTask = makeLaunchTask(taskStore);
      const cancelReplacedTask = vi.fn(async () => {
        throw new Error('runtime kill failed');
      });

      await expect(replaceLoopedPlaybook({
        taskStore,
        launchTask,
        ralphLoopService: {
          cancelLoop: vi.fn((task) => {
            const mutableTask = taskStore.getTaskForMutation(task.id);
            if (mutableTask?.ralphLoop && mutableTask.ralphLoop.status === 'running') {
              mutableTask.ralphLoop.status = 'cancelled';
            }
            return { ok: true, value: 'cancelled', changed: true };
          }),
          startLoop: vi.fn(async () => ({ ok: true, changed: true, value: undefined })),
        } as unknown as RalphLoopService,
        cancelReplacedTask,
      } as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      })).rejects.toMatchObject({
        status: 500,
        details: { code: 'lifecycle_cancel_failed' },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      // Critical: no new task was launched over a half-killed runtime.
      expect(launchTask).not.toHaveBeenCalled();
    });
  });

  it('returns 409 when a concurrent replace holds the in-flight key', async () => {
    await withPlaybook(`---
name: Loopable
tags: [workflow, loopable]
---

Loop {{target}}.
`, async (cwd) => {
      const taskStore = new TaskStore();
      const old = setupActiveLoop(taskStore, cwd);

      // Hold firstP suspended inside lifecycle cancellation. We wait until
      // cancelLoop fires: replaceLoopedPlaybook has already acquired the
      // in-flight key by then, while the stored task is not terminal yet.
      let cancelLoopReached!: () => void;
      const cancelLoopReachedP = new Promise<void>((resolve) => { cancelLoopReached = resolve; });
      const cancelReplacedTask = vi.fn(() => new Promise<void>(() => {
        /* never resolves; firstP intentionally leaks */
      }));
      const launchOne = vi.fn();

      const sharedRalphService = {
        cancelLoop: vi.fn((task) => {
          const mutableTask = taskStore.getTaskForMutation(task.id);
          if (mutableTask?.ralphLoop && mutableTask.ralphLoop.status === 'running') {
            mutableTask.ralphLoop.status = 'cancelled';
          }
          cancelLoopReached();
          return { ok: true, value: 'cancelled', changed: true };
        }),
        startLoop: vi.fn(async () => ({ ok: true, changed: true, value: undefined })),
      };

      const firstP = replaceLoopedPlaybook({
        taskStore,
        launchTask: launchOne,
        ralphLoopService: sharedRalphService as unknown as RalphLoopService,
        cancelReplacedTask,
      } as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      });

      // Avoid an unhandled-rejection warning if firstP is gc'd while pending.
      firstP.catch(() => undefined);

      await cancelLoopReachedP;

      const secondP = replaceLoopedPlaybook({
        taskStore,
        launchTask: makeLaunchTask(taskStore),
        ralphLoopService: sharedRalphService as unknown as RalphLoopService,
        cancelReplacedTask: vi.fn(async () => undefined),
      } as never, {
        replacedTaskId: old.id,
        cwd,
        playbookPath: 'workflow.md',
        parameterValues: { target: 'repo' },
      });

      await expect(secondP).rejects.toMatchObject({
        status: 409,
        details: { code: 'replace_already_in_progress' },
      } satisfies Partial<LoopedPlaybookLaunchError>);

      // firstP intentionally leaks — holding the in-flight key was the only
      // behavior under test.
    });
  });
});
