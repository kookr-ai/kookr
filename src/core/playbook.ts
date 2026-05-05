// Playbook type definitions — a playbook is a task template stored as Markdown with frontmatter.

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
  /** Markdown body after frontmatter — becomes the agent prompt */
  body: string;
  /** Optional target CWD declared in frontmatter — overrides the dialog CWD */
  cwd?: string;
  /** The CWD where this playbook was discovered */
  sourceCwd: string;
}
