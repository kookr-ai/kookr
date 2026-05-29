import type { AgentSelection } from './agent-types.js';
import type { LaunchDependency } from './playbook.js';
import type { TaskMetadataIntent } from './task.js';

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
   * `round-robin` sentinel, which the server resolves to a concrete agent.
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
   * the spawned agent so iteration 0 of a Ralph loop can write a verdict.
   */
  ralphVerdictEnv?: boolean;
}

export interface LaunchResult<TaskShape extends { id: string } = { id: string }> {
  task: TaskShape;
  queued: boolean;
  /** True when an active task with the same prompt already exists. */
  duplicate?: boolean;
}
