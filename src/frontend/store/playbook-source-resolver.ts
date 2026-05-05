import type { PlaybookParameterOption } from '../../core/playbook.js';
import type { ProjectSummary } from '../../core/project-summary.js';

/**
 * Resolve a dynamic parameter source to a list of options.
 * Async from day one — the initial `tracked-projects` source is synchronous,
 * but future sources (e.g., github-forks) may need API calls.
 */
export async function resolveParameterSource(
  sourceId: string,
  projectSummaries: ProjectSummary[],
): Promise<PlaybookParameterOption[]> {
  if (sourceId === 'tracked-projects') {
    return resolveTrackedProjects(projectSummaries);
  }

  console.warn(`Unknown playbook parameter source: "${sourceId}"`);
  return [];
}

function resolveTrackedProjects(
  projectSummaries: ProjectSummary[],
): PlaybookParameterOption[] {
  return projectSummaries
    .filter((p) => !p.project.startsWith('local/'))
    .map((p) => ({ label: p.displayName, value: p.displayName }));
}

/**
 * Merge source-resolved options with static options from the playbook YAML.
 * Source options come first; deduplicated by value. Static options can override labels.
 */
export function mergeSourceAndStaticOptions(
  sourceOptions: PlaybookParameterOption[],
  staticOptions: PlaybookParameterOption[] | undefined,
): PlaybookParameterOption[] {
  if (!staticOptions || staticOptions.length === 0) return sourceOptions;
  if (sourceOptions.length === 0) return staticOptions;

  const seen = new Map<string, PlaybookParameterOption>();

  for (const opt of sourceOptions) {
    seen.set(opt.value, opt);
  }

  // Static options override labels for existing values, or add new entries
  for (const opt of staticOptions) {
    seen.set(opt.value, opt);
  }

  return [...seen.values()];
}
