/**
 * Playbook DTOs — wire contract for playbook discovery and parameter
 * forms. A playbook is a task template stored as Markdown with frontmatter.
 *
 * Used by: WS `playbooks` message, `launchPlaybook` client message, and
 * the playbook browser UI.
 */

export interface PlaybookParameterOption {
  label: string;
  value: string;
}

export interface PlaybookParameter {
  name: string;
  description: string;
  required: boolean;
  default?: string;
  type?: 'text' | 'select' | 'textarea';
  options?: PlaybookParameterOption[];
  /** Dynamic data source ID (e.g., 'tracked-projects'). Resolved at render time. */
  source?: string;
  /** Server-side default resolver used when the launch form leaves this parameter blank. */
  defaultFrom?: 'git-remote';
  /**
   * Launch dependency this parameter is only meaningful when present. When the
   * dependency is probed `absent` on the host, the launch form collapses the
   * parameter to its default and annotates it. Pure form-rendering hint — never
   * enforced server-side. See `docs/rfc/rfc-capability-gated-playbook-params.md`.
   */
  gatedBy?: LaunchDependency;
}

export interface PlaybookLoopConfig {
  iterationCap?: number;
  zeroDiffConsecutiveIterations?: number;
  costCapUsd?: number;
  stopPredicate?: string;
}

/**
 * Cheap pre-check the scheduler execs instead of launching an agent
 * (issue #2569). When the command exits a non-escalate code (default: not 2),
 * the fire completes with no task and no fleet slot. Exit 2 (or a declared
 * escalateOnExit) still launches the playbook agent for heal + P0.
 */
export interface PlaybookProbe {
  command: string;
  escalateOnExit?: number[];
}

export interface EffectivePlaybookLoop {
  iterationCap: number;
  costCapUsd?: number;
  zeroDiffConsecutiveIterations?: number;
  stopPredicate?: string;
  sources: {
    iterationCap: 'default' | 'playbook';
    costCapUsd?: 'default' | 'playbook';
    zeroDiffConsecutiveIterations?: 'playbook';
  };
}

/**
 * Where a playbook was discovered. Drives both UI grouping and which directory
 * the launcher reads the file from. Precedence on id collision: project > user > plugin.
 *
 * - 'project': `<cwd>/.kookr/playbooks/` — only surfaces when work path matches.
 * - 'user':    `~/.kookr/playbooks/` (or `$KOOKR_USER_PLAYBOOKS_DIR`) — per-user personal playbooks.
 * - 'plugin':  `<kookr-toolkit-plugin>/playbooks/` — ships with the plugin; available to every install.
 */
export type PlaybookScope = 'project' | 'user' | 'plugin';

export const LAUNCH_DEPENDENCIES = ['kb', 'evolution-config'] as const;
export type LaunchDependency = typeof LAUNCH_DEPENDENCIES[number];

export interface Playbook {
  /** Unique identifier: relative file path from the playbooks dir (e.g., "create-mr.md") */
  id: string;
  /** Discovery origin — drives where the launcher reads the file from. */
  scope: PlaybookScope;
  /** Human-readable name from frontmatter */
  name: string;
  /** Short description from frontmatter */
  description: string;
  /** Parameters the user fills in before triggering */
  parameters: PlaybookParameter[];
  /** Checklist items — become task completion criteria */
  checklist: string[];
  /** Display/behavior tags from frontmatter, e.g. workflow, loopable. */
  tags: string[];
  /** Raw loop defaults declared in frontmatter. */
  loop?: PlaybookLoopConfig;
  /**
   * Optional cheap probe the scheduler execs before launching an agent
   * (issue #2569). Absent playbooks still match a well-known path fallback
   * (kookr/lucy deploy-convergence).
   */
  probe?: PlaybookProbe;
  /**
   * Server-consumed policy flag. Delivery is pre-authorized by default: playbook
   * launches complete the full delivery cycle (commit, push, open/update PR)
   * without asking first. Set to `false` to require the agent to ask before
   * pushing and opening a PR (`ask-first` delivery).
   */
  deliveryPreAuthorized?: boolean;
  /**
   * Server-consumed delivery mode. When set to `'self-advancing'` the playbook
   * launches a dependent-phase chain that self-merges each phase and spawns the
   * next (umbrella #2711). This is a distinct delivery-mode value threaded to
   * `worktree-guardrails`, not an authorization boolean; its self-merge grant is
   * re-verified at merge time and gated by the `KOOKR_SELF_ADVANCING_DISABLED`
   * kill switch and a per-chain rate cap. Absent (the default) preserves the
   * existing `deliveryPreAuthorized`-driven `pre-authorized`/`ask-first` shape.
   */
  deliveryMode?: 'self-advancing';
  /**
   * Server-consumed policy flag: when true, tasks launched from this playbook
   * auto-complete after a `completion_ready` signal has been pending for the
   * grace period instead of waiting indefinitely for manual review. Successors
   * spawned via parentTaskId inherit it automatically.
   * See docs/reference/auto-close-on-signal.md.
   */
  autoCloseOnSignal?: boolean;
  /** Server-normalized bounded loop config for loopable playbooks. */
  effectiveLoop?: EffectivePlaybookLoop;
  /** Non-fatal loop metadata error. Standard launch remains available. */
  loopValidationError?: string;
  /** Markdown body after frontmatter — becomes the agent prompt */
  body: string;
  /** Optional target CWD declared in frontmatter — overrides the dialog CWD */
  cwd?: string;
  /** External services this playbook needs before an agent starts. */
  dependencies?: LaunchDependency[];
  /** The CWD where this playbook was discovered */
  sourceCwd: string;
  /**
   * Frontmatter `repo-tags`. When non-empty, plugin-tier playbooks are only
   * visible in cwds whose detected repo-tags intersect this set. Ignored for
   * project/user scope (those are explicitly placed by the user).
   */
  repoTags?: string[];
}
