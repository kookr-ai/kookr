import { realpathSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import type { Task, TaskStore, AutonomyLevel } from '../core/tasks.js';
import { type AgentType, DEFAULT_AGENT_TYPE } from '../core/agent-types.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import { MAX_ACTIVE_TASKS } from './config.js';
import { registerNewAgent, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { hashPrompt } from './hash-prompt.js';
import { normalizePromptFileReferences } from './prompt-file-paths.js';
import { applyWorktreeGuardrails } from './worktree-guardrails.js';

/**
 * Canonical form of a cwd for dedup comparison. Resolves symlinks and, on
 * case-insensitive filesystems (default macOS), the on-disk casing. Falls back
 * to path.resolve() when the directory does not exist or is not readable —
 * which keeps dedup consistent between a fresh submission and a stored task
 * that referred to a now-missing directory. The fallback is also what lets
 * unit tests pass paths like "/tmp" without caring whether that dir is present.
 */
export function canonicalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return pathResolve(cwd);
  }
}

export interface LaunchServiceDeps {
  taskStore: TaskStore;
  adapterRegistry: AdapterRegistry;
  lifecycleDeps: AgentLifecycleDeps;
  /** Live getter for max concurrent tasks. Falls back to static default if not provided. */
  getMaxActiveTasks?: () => number;
  interactionLog?: DeferredInteractionLogWriter;
}

export interface LaunchOpts {
  prompt: string;
  cwd: string;
  criteria?: string;
  parentTaskId?: string;
  /** Pre-set task name (e.g. from playbooks). Skips AI naming when set. */
  name?: string;
  /** Playbook identifier for traceability. */
  playbookId?: string;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  /** Autonomy level for the task. Default: 'supervised'. */
  autonomy?: AutonomyLevel;
  /** Agent type to launch. Defaults to the registry default. */
  agentType?: AgentType;
  /** When true, always create a new task instead of returning an existing active duplicate. */
  disableDedup?: boolean;
  /** Explicit project ID (e.g., github.com/owner/repo) — skips CWD-based inference. */
  projectId?: string;
  /** Where the launch came from — for server-side log provenance. Default: 'api'. */
  launchSource?: 'cli' | 'ui' | 'api' | 'remote-chat-telegram';
}

export interface LaunchResult {
  task: Task;
  queued: boolean;
  /** True when an active task with the same prompt already exists. */
  duplicate?: boolean;
}

/** Active statuses — tasks in these states block duplicate submissions. */
const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);

/**
 * Check if an active task with the same prompt hash and canonical cwd already
 * exists. Returns the existing task if found, undefined otherwise.
 *
 * Dedup key is (promptHash, agentType, canonicalCwd). Two launches with the
 * same prompt in different directories are different tasks; two launches with
 * the same prompt in the same directory — even reached via symlink, trailing
 * slash, relative path, or case-aliased path on case-insensitive FS — dedup
 * to the first.
 */
export function checkSubmission(
  taskStore: TaskStore,
  prompt: string,
  agentType: AgentType,
  cwd: string,
): Task | undefined {
  const hash = hashPrompt(prompt);
  const canonicalIncoming = canonicalizeCwd(cwd);
  for (const task of taskStore.listTasks()) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    if (task.agentType !== agentType) continue;
    if (hashPrompt(task.prompt) !== hash) continue;
    if (canonicalizeCwd(task.cwd) !== canonicalIncoming) continue;
    // Verify live status — don't rely on cached state
    const liveTask = taskStore.getTask(task.id);
    if (liveTask && liveTask.agentType === agentType && ACTIVE_STATUSES.has(liveTask.status)) {
      return liveTask;
    }
  }
  return undefined;
}

/**
 * Unified launch orchestration: create task, check concurrency, launch via
 * adapter, and run post-launch registration. Used by both the WS message
 * router and the REST API.
 */
export async function launchTask(
  deps: LaunchServiceDeps,
  opts: LaunchOpts,
): Promise<LaunchResult> {
  const { taskStore, adapterRegistry, lifecycleDeps } = deps;
  const maxActive = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
  const agentType = opts.agentType ?? adapterRegistry.getDefaultType() ?? DEFAULT_AGENT_TYPE;

  // R19 trust-boundary check (rfc-remote-chat-trigger §4): remote-chat-spawned
  // tasks MUST use claude-code. This prevents a crafted /task command from trying to
  // silently route a remote-chat task to Codex.
  if (opts.launchSource === 'remote-chat-telegram' && agentType !== 'claude-code') {
    throw new Error(
      `R19: remote-chat-telegram tasks must use claude-code, not ${agentType}`,
    );
  }

  const guardedPrompt = await applyWorktreeGuardrails(opts.prompt, opts.cwd);
  const effectivePrompt = normalizePromptFileReferences(guardedPrompt, opts.cwd);

  // Dedup: if an active task with the same prompt and canonical cwd exists,
  // return it idempotently
  if (!opts.disableDedup) {
    const existing = checkSubmission(taskStore, effectivePrompt, agentType, opts.cwd);
    if (existing) {
      const canonicalCwd = canonicalizeCwd(opts.cwd);
      console.log(`[dedup] Rejected duplicate prompt (existing task ${existing.id}, status=${existing.status}, cwd=${canonicalCwd})`);
      await deps.interactionLog?.append({
        type: 'submission_rejected_dedup',
        existingTaskId: existing.id,
        promptHash: hashPrompt(effectivePrompt),
        canonicalCwd,
        timestamp: nowISO(),
      });
      return { task: existing, queued: false, duplicate: true };
    }
  }

  const task = taskStore.createTask({
    prompt: effectivePrompt,
    cwd: opts.cwd,
    criteria: opts.criteria,
    parentTaskId: opts.parentTaskId,
    autonomy: opts.autonomy,
    agentType,
    playbookParameterValues: opts.playbookParameterValues,
  });

  if (opts.name) task.name = opts.name;
  if (opts.playbookId) task.playbookId = opts.playbookId;
  if (opts.projectId) taskStore.setProjectId(task.id, opts.projectId);

  if (taskStore.getActiveCount() >= maxActive) {
    taskStore.pendTask(task.id);
    return { task, queued: true };
  }

  try {
    await adapterRegistry.get(agentType).launch(task.id, effectivePrompt, opts.cwd);
  } catch (err) {
    // Clean up the task record so dedup doesn't block future retries
    taskStore.deleteTask(task.id);
    throw err;
  }
  const source = opts.launchSource ?? 'api';
  console.log(`[launch] source=${source} agent=${agentType} taskId=${task.id} cwd=${opts.cwd}`);
  await registerNewAgent(task, lifecycleDeps);
  return { task, queued: false };
}

/**
 * Launch a fresh runtime session for an already-existing task (used by the
 * Ralph loop service to re-inject the loop prompt after each iteration).
 * Returns the new tmux session name.
 */
export async function launchFreshTaskSession(
  deps: LaunchServiceDeps,
  task: Task,
  prompt: string,
): Promise<string> {
  const sessionId = await deps.adapterRegistry.get(task.agentType).launch(
    task.id,
    prompt,
    task.cwd,
  );
  await registerNewAgent(task, deps.lifecycleDeps);
  return sessionId;
}
