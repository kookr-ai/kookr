import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Playbook, PlaybookScope } from './playbook.js';
import { parsePlaybook, PlaybookParseError } from './playbook-parser.js';
import { resolvePluginDir } from './plugin-paths.js';
import { detectRepoTags, repoTagsAllow } from './repo-tags.js';

const PROJECT_PLAYBOOKS_SUBDIR = '.kookr/playbooks';
const PLUGIN_PLAYBOOKS_SUBDIR = 'playbooks';

/**
 * Resolve the per-user playbooks directory. Honours `KOOKR_USER_PLAYBOOKS_DIR`
 * (intended for tests and power users); defaults to `~/.kookr/playbooks/`.
 */
export function userPlaybooksDir(): string {
  const override = process.env.KOOKR_USER_PLAYBOOKS_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), '.kookr', 'playbooks');
}

/**
 * Resolve the plugin playbooks directory inside the kookr-toolkit plugin tree.
 * Returns `undefined` when no plugin can be located — caller skips that tier.
 * Defers to `resolvePluginDir` so the discovery and adapter layers always
 * point at the same plugin tree.
 */
export function pluginPlaybooksDir(): string | undefined {
  const pluginRoot = resolvePluginDir(undefined);
  return pluginRoot ? join(pluginRoot, PLUGIN_PLAYBOOKS_SUBDIR) : undefined;
}

/**
 * Discover playbooks visible from the given project cwd. Scans three tiers:
 *   - project: `<cwd>/.kookr/playbooks/*.md`
 *   - user:    `~/.kookr/playbooks/*.md`             (or `$KOOKR_USER_PLAYBOOKS_DIR`)
 *   - plugin:  `<kookr-toolkit>/playbooks/*.md`      (auto-detected or via `$KOOKR_PLUGIN_DIR`)
 *
 * Precedence on id collision: project > user > plugin. So a project can shadow
 * a user playbook by id, and either can shadow a plugin one.
 *
 * Missing directories are treated as empty. Files that fail to parse are
 * skipped with a warning. The returned list is sorted by id.
 */
export async function discoverPlaybooks(cwd: string): Promise<Playbook[]> {
  const projectDir = join(cwd, PROJECT_PLAYBOOKS_SUBDIR);
  const userDir = userPlaybooksDir();
  const pluginDir = pluginPlaybooksDir();

  // Build the scan list, skipping any tier whose dir collides with another to
  // avoid double-reading identical files when paths overlap (e.g. a user runs
  // Kookr inside their home dir and projectDir == userDir).
  const seen = new Set<string>();
  const scans: Promise<Playbook[]>[] = [];

  scans.push(scanPlaybooksDir(projectDir, cwd, 'project'));
  seen.add(projectDir);

  if (!seen.has(userDir)) {
    scans.push(scanPlaybooksDir(userDir, userDir, 'user'));
    seen.add(userDir);
  }
  if (pluginDir !== undefined && !seen.has(pluginDir)) {
    scans.push(scanPlaybooksDir(pluginDir, pluginDir, 'plugin'));
    seen.add(pluginDir);
  }

  const [projectPlaybooks, userPlaybooks, pluginPlaybooks, repoTags] = await Promise.all([
    scans[0],
    scans[1] ?? Promise.resolve([] as Playbook[]),
    scans[2] ?? Promise.resolve([] as Playbook[]),
    detectRepoTags(cwd),
  ]);

  // Merge with project > user > plugin precedence by id. Plugin-tier
  // playbooks that declare `repo-tags` are filtered out when the cwd's
  // detected tags don't intersect — this is what hides e.g. `oss-bug-fix`
  // outside github-hosted repos. Project and user playbooks bypass the
  // filter (the user explicitly placed those files).
  const byId = new Map<string, Playbook>();
  for (const pb of pluginPlaybooks) {
    if (repoTagsAllow(pb.repoTags, repoTags)) byId.set(pb.id, pb);
  }
  for (const pb of userPlaybooks) byId.set(pb.id, pb);
  for (const pb of projectPlaybooks) byId.set(pb.id, pb);

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function scanPlaybooksDir(
  dir: string,
  sourceCwd: string,
  scope: PlaybookScope,
): Promise<Playbook[]> {
  let filenames: string[];
  try {
    const entries = await readdir(dir);
    filenames = entries.filter((e) => e.endsWith('.md')).sort();
  } catch {
    return [];
  }

  const playbooks: Playbook[] = [];

  for (const filename of filenames) {
    try {
      const content = await readFile(join(dir, filename), 'utf-8');
      const playbook = parsePlaybook(content, filename, sourceCwd, scope);
      playbooks.push(playbook);
    } catch (err) {
      if (err instanceof PlaybookParseError) {
        console.warn(`Skipping invalid playbook ${filename} in ${dir}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  return playbooks;
}
