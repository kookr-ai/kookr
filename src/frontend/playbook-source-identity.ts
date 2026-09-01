import type { Playbook, PlaybookSourceIdentity } from '../shared/contracts/playbook.js';

/**
 * True when a catalog `playbook` is the same file *resource* a task recorded at
 * launch — same relative id in the same tier and directory (id + scope +
 * sourceCwd). The relative id alone is not unique: project, user, and plugin
 * tiers may each hold the same filename, and discovery collapses them with
 * project > user > plugin precedence. Pinning the tier + directory is what stops
 * a later same-id playbook in a higher tier from being silently substituted
 * (issue #2892).
 *
 * Digest is deliberately excluded: an in-place edit is still the same resource,
 * and relaunch means "run this workflow again" against its current definition.
 */
export function isSamePlaybookResource(playbook: Playbook, source: PlaybookSourceIdentity): boolean {
  return playbook.id === source.id
    && playbook.scope === source.scope
    && playbook.sourceCwd === source.sourceCwd;
}

/**
 * True when a catalog `playbook` is the exact resource *and* the exact version
 * (byte-identical `sourceDigest`) a task/schedule recorded at launch. Use this
 * where a specific version must be pinned — e.g. a schedule that repeatedly
 * re-executes a fixed workflow ("Schedule this playbook", #2887) — so an edit at
 * the same path is treated as a different pin. Relaunch uses the looser
 * {@link isSamePlaybookResource} instead.
 */
export function matchesPlaybookSource(playbook: Playbook, source: PlaybookSourceIdentity): boolean {
  return isSamePlaybookResource(playbook, source)
    && playbook.sourceDigest === source.sourceDigest;
}
