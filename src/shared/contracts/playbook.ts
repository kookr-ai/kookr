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
}

export interface PlaybookLoopConfig {
  iterationCap?: number;
  zeroDiffConsecutiveIterations?: number;
  costCapUsd?: number;
  stopPredicate?: string;
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

export interface Playbook {
  /** Unique identifier: relative file path from .kookr/playbooks/ (e.g., "create-mr.md") */
  id: string;
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
  /** Server-normalized bounded loop config for loopable playbooks. */
  effectiveLoop?: EffectivePlaybookLoop;
  /** Non-fatal loop metadata error. Standard launch remains available. */
  loopValidationError?: string;
  /** Markdown body after frontmatter — becomes the agent prompt */
  body: string;
  /** Optional target CWD declared in frontmatter — overrides the dialog CWD */
  cwd?: string;
  /** The CWD where this playbook was discovered */
  sourceCwd: string;
}
