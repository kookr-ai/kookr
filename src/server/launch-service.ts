import { realpathSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import type { Task, TaskLaunchHealthSummary, TaskStore } from '../core/tasks.js';
import { type AgentType, DEFAULT_AGENT_TYPE } from '../core/agent-types.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { LaunchDependency } from '../core/playbook.js';
import {
  redactDiagnosticText,
  type DependencyPreflightRunner,
  type LaunchPreflightFinding,
} from '../core/launch-dependency-preflight.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import { defaultVerdictPath } from '../core/ralph-iteration-verdict.js';
import { MAX_ACTIVE_TASKS } from './config.js';
import { registerNewAgent, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { hashPrompt } from './hash-prompt.js';
import { runLaunchDependencyPreflights } from './launch-dependency-runner.js';
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
  /** Live getter for the configured default agent type. Falls back to the registry default if not provided. */
  getDefaultAgentType?: () => AgentType;
  interactionLog?: DeferredInteractionLogWriter;
  dependencyPreflightRunner?: DependencyPreflightRunner;
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
  /** Agent type to launch. Defaults to the registry default. */
  agentType?: AgentType;
  /** When true, always create a new task instead of returning an existing active duplicate. */
  disableDedup?: boolean;
  /** Explicit project ID (e.g., github.com/owner/repo) — skips CWD-based inference. */
  projectId?: string;
  /** Where the launch came from — for server-side log provenance. Default: 'api'. */
  launchSource?: 'cli' | 'ui' | 'api' | 'remote-chat-telegram';
  /** External services the launch should check and surface as launch health. */
  dependencies?: LaunchDependency[];
  /**
   * When true, inject `RALPH_VERDICT_FILE` and `RALPH_ITERATION` env into
   * the spawned agent so iteration 0 of a Ralph loop can write a verdict
   * (subsequent iterations get this via `launchFreshRuntime`'s extraEnv
   * injection). Path is computed as `defaultVerdictPath(opts.cwd, task.id)`
   * after the task record exists.
   *
   * Coverage and known gaps:
   * - **Fresh, non-queued launches** (POST /api/tasks/ralph-loop,
   *   POST /api/playbooks/ralph-loop): covered by PR4. Set this flag to
   *   true on the launch.
   * - **Queued ralph launches**: not covered. Promotion via
   *   `promotePendingTasks` re-launches with bare 3-arg adapter.launch.
   *   Mitigation: ralph route handlers reject `result.queued: true` with
   *   a 503 — no half-attached ralph loops.
   * - **Attach-existing-task** (POST /api/tasks/:id/ralph-loop): NOT
   *   covered. The existing session predates the loop attach and cannot
   *   receive new env vars retroactively. Iteration 0 silently misses the
   *   verdict channel; iteration 1+ get it via `launchFreshRuntime`.
   *   Documented as a known limitation; relaunch via fresh /api/tasks/ralph-loop
   *   for full iteration-0 coverage.
   * - **Crash-recovery resumes**: also not covered (separate path through
   *   `crash-recovery.ts`); tracked as a follow-up.
   *
   * See `docs/rfc/rfc-ralph-loop-stall-handling.md` §8 and PR4 (the
   * bug-fix companion to PR2 #165).
   */
  ralphVerdictEnv?: boolean;
}

export interface LaunchResult {
  task: Task;
  queued: boolean;
  /** True when an active task with the same prompt already exists. */
  duplicate?: boolean;
}

/** Active statuses — tasks in these states block duplicate submissions. */
const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);

function allowRemoteChatCodex(): boolean {
  return process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX === '1';
}

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
  const agentType =
    opts.agentType ??
    deps.getDefaultAgentType?.() ??
    adapterRegistry.getDefaultType() ??
    DEFAULT_AGENT_TYPE;

  // R19 trust-boundary check (rfc-remote-chat-trigger §4): Telegram-spawned
  // Codex is opt-in because its permission model is more permissive than
  // Claude Code's supervised path. The integration checks this before
  // confirmation; this server-side check is the defense-in-depth boundary.
  if (
    opts.launchSource === 'remote-chat-telegram' &&
    agentType !== 'claude-code' &&
    !(agentType === 'codex-cli' && allowRemoteChatCodex())
  ) {
    throw new Error(
      `R19: remote-chat-telegram tasks cannot use ${agentType} unless KOOKR_REMOTE_CHAT_ALLOW_CODEX=1`,
    );
  }

  const dependencyFindings = sanitizeLaunchPreflightFindings(await collectAdvisoryDependencyFindings(
    deps.dependencyPreflightRunner ?? runLaunchDependencyPreflights,
    opts.dependencies,
  ));
  const launchHealthSummary = summarizeLaunchHealth(dependencyFindings);
  const launchNote = formatLaunchNote(dependencyFindings);

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
    agentType,
    playbookParameterValues: opts.playbookParameterValues,
    launchHealthSummary,
    launchNote,
  });

  if (opts.name) task.name = opts.name;
  if (opts.playbookId) task.playbookId = opts.playbookId;
  if (opts.projectId) taskStore.setProjectId(task.id, opts.projectId);

  if (taskStore.getActiveCount() >= maxActive) {
    taskStore.pendTask(task.id);
    return { task, queued: true };
  }

  // PR4: ralph-loop launches need verdict env injected so iteration 0 can
  // write a verdict. Subsequent iterations get this via `launchFreshRuntime`;
  // this fills the gap on the first launch.
  const adapterOpts = opts.ralphVerdictEnv
    ? {
        extraEnv: {
          RALPH_VERDICT_FILE: defaultVerdictPath(opts.cwd, task.id),
          RALPH_ITERATION: '0',
        },
      }
    : undefined;

  try {
    await adapterRegistry.get(agentType).launch(task.id, promptWithLaunchNote(task), opts.cwd, undefined, adapterOpts);
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

export function promptWithLaunchNote(task: Pick<Task, 'prompt' | 'launchNote'>): string {
  return task.launchNote ? `${task.launchNote}\n\n${task.prompt}` : task.prompt;
}

function summarizeLaunchHealth(findings: LaunchPreflightFinding[]): TaskLaunchHealthSummary | undefined {
  if (findings.length === 0) return undefined;
  return {
    degradedDependencies: [...new Set(findings.map((finding) => finding.dependency))],
    findings,
  };
}

function sanitizeLaunchPreflightFindings(findings: LaunchPreflightFinding[]): LaunchPreflightFinding[] {
  return findings.map((finding) => ({
    ...finding,
    ...(finding.detail ? { detail: redactDiagnosticText(finding.detail, 500) } : {}),
  }));
}

function formatLaunchNote(findings: LaunchPreflightFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  const lines = findings.map((finding) => {
    const detail = finding.detail ? ` Detail: ${finding.detail}` : '';
    return `- ${finding.summary} (${finding.category}).${detail} Recommended action: ${finding.recommendedAction}`;
  });
  return [
    '[Kookr launch warning] One or more advisory launch dependencies are degraded. Continue the task without assuming those services are available.',
    ...lines,
  ].join('\n');
}

async function collectAdvisoryDependencyFindings(
  runner: DependencyPreflightRunner,
  dependencies: LaunchDependency[] | undefined,
): Promise<LaunchPreflightFinding[]> {
  try {
    return await runner(dependencies);
  } catch (err) {
    console.warn('[launch] advisory dependency preflight failed internally:', err);
    if (!dependencies?.includes('kb')) return [];
    return [{
      dependency: 'kb',
      status: 'failed',
      category: 'unknown',
      summary: 'KB dependency preflight could not complete',
      detail: redactDiagnosticText(err instanceof Error ? err.message : String(err), 500),
      recommendedAction: 'Run `kb doctor --format=json` manually and address the reported KB failure.',
    }];
  }
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
  opts?: import('../adapters/agent-adapter.js').AdapterLaunchOptions,
): Promise<string> {
  const sessionId = await deps.adapterRegistry.get(task.agentType).launch(
    task.id,
    prompt,
    task.cwd,
    undefined,
    opts,
  );
  await registerNewAgent(task, deps.lifecycleDeps);
  return sessionId;
}
