import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { PlaybookScope } from './playbook.js';
import { userPlaybooksDir, pluginPlaybooksDir } from './playbook-discovery.js';

/**
 * Resolve the playbooks directory for a single, known scope.
 *
 *   - 'project': `<cwd>/.kookr/playbooks/`
 *   - 'user':    `~/.kookr/playbooks/` (or `$KOOKR_USER_PLAYBOOKS_DIR`)
 *   - 'plugin':  `<kookr-toolkit>/playbooks/` — may be `undefined` when no
 *                plugin tree can be located.
 *
 * Returns `undefined` when the tier has no directory (no plugin installed) or
 * when `scope` is not a recognised tier — callers treat both as "unresolvable"
 * rather than throwing, so an unknown scope value from a newer client never
 * wedges resolution (see rfc-schedule-playbook-resolution R6/R11).
 */
export function playbookScopeDir(scope: PlaybookScope, cwd: string): string | undefined {
  switch (scope) {
    case 'project': return join(cwd, '.kookr', 'playbooks');
    case 'user':    return userPlaybooksDir();
    case 'plugin':  return pluginPlaybooksDir();
    default:        return undefined;
  }
}

/**
 * Resolve a bare playbook filename within ONE known scope. There is
 * deliberately no cross-tier fallback chain here: the caller pins a single
 * tier and we only ever look in that tier's *current* directory. A same-named
 * file in another tier never shadows the pinned one.
 *
 * Returns the absolute file path when the file exists inside the scope
 * directory and the path does not escape it (R11); otherwise `undefined`.
 */
export function resolvePlaybookInScope(
  playbookPath: string,
  scope: PlaybookScope,
  cwd: string,
): { filePath: string } | undefined {
  const dir = playbookScopeDir(scope, cwd);
  if (dir === undefined) return undefined;
  const filePath = join(dir, playbookPath);
  if (!isPathInside(filePath, dir)) return undefined; // R11: reject traversal
  return existsSync(filePath) ? { filePath } : undefined;
}

/**
 * True when `path` resolves to `parent` itself or a descendant of it. Used to
 * reject `playbook.path` values that escape the pinned tier directory.
 * (Relocated here from `playbook-launch.ts` so there is a single copy.)
 */
export function isPathInside(path: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(path));
  return relativePath === ''
    || (!relativePath.startsWith('..') && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}
