import type { Task, TaskLaunchHealthSummary, TaskStore } from '../core/tasks.js';
import {
  type AgentType,
  type AgentSelection,
  DEFAULT_AGENT_TYPE,
  ROUND_ROBIN_AGENT_TYPE,
  resolveRoundRobinAgent,
} from '../core/agent-types.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { LaunchDependency } from '../core/playbook.js';
import type { TaskMetadataIntent } from '../shared/contracts/task.js';
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
import { canonicalizeCwd } from './cwd.js';
import { normalizePromptFileReferences } from './prompt-file-paths.js';
import { applyWorktreeGuardrails } from './worktree-guardrails.js';

export interface LaunchServiceDeps {
  taskStore: TaskStore;
  adapterRegistry: AdapterRegistry;
  lifecycleDeps: AgentLifecycleDeps;
  /** Optional live session probe used to keep dedup from trusting stale inProgress records. */
  terminalBackend?: Pick<TerminalBackend, 'isAlive'>;
  /** Live getter for max concurrent tasks. Falls back to static default if not provided. */
  getMaxActiveTasks?: () => number;
  /**
   * Live getter for the configured default agent selection. Falls back to the
   * registry default if not provided. May return the `round-robin` sentinel,
   * which {@link roundRobinCursor} resolves to a concrete agent.
   */
  getDefaultAgentType?: () => AgentSelection;
  /**
   * Round-robin rotation cursor. `peek()` reads the rotation index for the
   * next launch *without* advancing; `advance()` moves the cursor forward and
   * persists it. The launch service peeks when resolving the `round-robin`
   * sentinel and advances only once a task record is actually committed, so a
   * deduplicated or rejected launch never consumes a rotation slot and skews
   * the alternation.
   */
  roundRobinCursor?: { peek: () => number; advance: () => void };
  interactionLog?: DeferredInteractionLogWriter;
  dependencyPreflightRunner?: DependencyPreflightRunner;
  /**
   * Operator drain gate (issue #659). When provided and returning false, the
   * node is draining and {@link launchTask} refuses new launches by throwing
   * {@link DrainModeError}. Omitted (or always-true) means the node accepts
   * launches normally — in-flight agents are never affected either way.
   */
  isAccepting?: () => boolean;
}

/**
 * Thrown by {@link launchTask} when the server is in operator drain mode and is
 * refusing new task launches. Callers map this to HTTP 503 (issue #659).
 */
export class DrainModeError extends Error {
  readonly code = 'draining';
  constructor() {
    super('Server is draining; not accepting new task launches');
    this.name = 'DrainModeError';
  }
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
  /**
   * Agent to launch. Defaults to the configured default agent. May be the
   * `round-robin` sentinel, which is resolved to a concrete agent here; the
   * created task record always stores a concrete {@link AgentType}.
   */
  agentType?: AgentSelection;
  /** When true, always create a new task instead of returning an existing active duplicate. */
  disableDedup?: boolean;
  /** Explicit operator intent for duplicate-preserving launches. */
  metadataIntent?: TaskMetadataIntent;
  /** Explicit project ID (e.g., github.com/owner/repo) — skips CWD-based inference. */
  projectId?: string;
  /** Where the launch came from — for server-side log provenance. Default: 'api'. */
  launchSource?: 'cli' | 'ui' | 'api' | 'remote-chat-telegram' | 'remote-relay';
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

function isSessionTerminal(session: Task['sessions'][number]): boolean {
  return session.lastStatus === 'completed' || session.lastStatus === 'aborted';
}

function isRalphLoopActive(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

async function hasLiveBackingSession(
  task: Task,
  terminalBackend: Pick<TerminalBackend, 'isAlive'>,
): Promise<boolean> {
  const sessions = task.sessions.filter((session) => !isSessionTerminal(session));
  if (sessions.length === 0) return false;

  for (const session of sessions) {
    try {
      if (await terminalBackend.isAlive(session.tmuxSession)) return true;
    } catch {
      // Treat backend probe failures like a missing session for dedup. The
      // stale record will be reconciled below instead of blocking a retry.
    }
  }
  return false;
}

function reconcileStaleDuplicate(taskStore: TaskStore, task: Task): void {
  const current = taskStore.getTask(task.id);
  if (!current || current.status !== 'inProgress') return;

  for (const session of current.sessions) {
    if (!isSessionTerminal(session)) {
      taskStore.updateSession(current.id, session.tmuxSession, { lastStatus: 'completed' });
    }
  }

  const updated = taskStore.getTask(current.id);
  if (
    updated?.status === 'inProgress'
    && (updated.sessions.length === 0 || updated.sessions.every(isSessionTerminal))
  ) {
    taskStore.terminateTask(updated.id);
  }
}

async function validateDuplicateCandidate(
  deps: LaunchServiceDeps,
  candidate: Task,
): Promise<Task | undefined> {
  if (candidate.status !== 'inProgress') return candidate;
  if (isRalphLoopActive(candidate)) return candidate;
  if (!deps.terminalBackend) return candidate;
  if (await hasLiveBackingSession(candidate, deps.terminalBackend)) return candidate;

  reconcileStaleDuplicate(deps.taskStore, candidate);
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
  // Operator drain gate (issue #659): refuse new launches while draining, before
  // any task record or side effect is created. In-flight agents are untouched.
  if (deps.isAccepting && !deps.isAccepting()) {
    throw new DrainModeError();
  }
  const maxActive = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
  // Resolve the agent for this launch. An explicit per-launch request wins
  // over the configured default; either may be the `round-robin` sentinel,
  // which is resolved to a concrete agent *here* — before dedup and task
  // creation — so the task record always stores a concrete agent type.
  const requestedAgent: AgentSelection =
    opts.agentType ??
    deps.getDefaultAgentType?.() ??
    adapterRegistry.getDefaultType() ??
    DEFAULT_AGENT_TYPE;
  const isRoundRobin = requestedAgent === ROUND_ROBIN_AGENT_TYPE;
  // `peek` (not advance): the rotation cursor must only move once a task is
  // actually committed, so a deduplicated or rejected launch does not consume
  // a rotation slot. The matching `advance()` calls fire after `createTask`.
  const agentType: AgentType = isRoundRobin
    ? resolveRoundRobinAgent(
        deps.roundRobinCursor?.peek() ?? 0,
        adapterRegistry.getTypes(),
      )
    : requestedAgent;

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

  const userPrompt = normalizePromptFileReferences(opts.prompt, opts.cwd);
  const guardedPrompt = await applyWorktreeGuardrails(opts.prompt, opts.cwd);
  const effectivePrompt = normalizePromptFileReferences(guardedPrompt, opts.cwd);

  // Dedup: if an active task with the same prompt and canonical cwd exists,
  // return it idempotently
  if (!opts.disableDedup) {
    let staleDuplicate: Task | undefined;
    let existing: Task | undefined;
    while ((existing = checkSubmission(taskStore, effectivePrompt, agentType, opts.cwd))) {
      const activeDuplicate = await validateDuplicateCandidate(deps, existing);
      if (activeDuplicate) {
        const canonicalCwd = canonicalizeCwd(opts.cwd);
        console.log(`[dedup] Rejected duplicate prompt (existing task ${activeDuplicate.id}, status=${activeDuplicate.status}, cwd=${canonicalCwd})`);
        await deps.interactionLog?.append({
          type: 'submission_rejected_dedup',
          existingTaskId: activeDuplicate.id,
          promptHash: hashPrompt(effectivePrompt),
          canonicalCwd,
          timestamp: nowISO(),
        });
        return { task: activeDuplicate, queued: false, duplicate: true };
      }
      staleDuplicate = existing;
    }
    if (staleDuplicate) {
      console.log(`[dedup] Ignored stale duplicate prompt (existing task ${staleDuplicate.id}, status=${staleDuplicate.status}, cwd=${canonicalizeCwd(opts.cwd)})`);
    }
  }

  const task = taskStore.createTask({
    prompt: effectivePrompt,
    userPrompt,
    cwd: opts.cwd,
    criteria: opts.criteria,
    parentTaskId: opts.parentTaskId,
    agentType,
    name: opts.name,
    playbookId: opts.playbookId,
    projectId: opts.projectId,
    playbookParameterValues: opts.playbookParameterValues,
    metadata: opts.metadataIntent ? { intent: opts.metadataIntent } : undefined,
    launchHealthSummary,
    launchNote,
  });

  if (taskStore.getActiveCount() >= maxActive) {
    const queuedTask = taskStore.pendTask(task.id);
    // The task record is committed (queued for promotion), so the round-robin
    // launch consumed its slot — advance the rotation.
    if (isRoundRobin) deps.roundRobinCursor?.advance();
    return { task: queuedTask, queued: true };
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
    // Clean up the task record so dedup doesn't block future retries. The
    // round-robin cursor was not advanced yet, so a failed launch leaves the
    // rotation untouched.
    taskStore.deleteTask(task.id);
    throw err;
  }
  // The launch succeeded — advance the rotation now that the task is live.
  if (isRoundRobin) deps.roundRobinCursor?.advance();
  const source = opts.launchSource ?? 'api';
  console.log(`[launch] source=${source} agent=${agentType} taskId=${task.id} cwd=${opts.cwd}`);
  const launchedTask = taskStore.getTask(task.id) ?? task;
  await registerNewAgent(launchedTask, lifecycleDeps);
  return { task: launchedTask, queued: false };
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
 *
 * Deliberately NOT subject to the drain gate (issue #659): this continues
 * *in-flight* work on an existing task rather than creating a new one, and
 * drain's contract is that already-running agents and in-flight work run to
 * completion. The cordon is enforced on {@link launchTask} (new-task creation)
 * and on the scheduler, not here.
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
  const launchedTask = deps.taskStore.getTask(task.id) ?? task;
  await registerNewAgent(launchedTask, deps.lifecycleDeps);
  return sessionId;
}
