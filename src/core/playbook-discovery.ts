import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Playbook, PlaybookScope } from './playbook.js';
import { parsePlaybook, PlaybookParseError } from './playbook-parser.js';
import { resolvePluginDir } from './plugin-paths.js';
import { detectRepoTags, repoTagsAllow } from './repo-tags.js';

const PROJECT_PLAYBOOKS_SUBDIR = '.kookr/playbooks';
const PLUGIN_PLAYBOOKS_SUBDIR = 'playbooks';
const MAX_PLAYBOOK_DIR_CACHE_ENTRIES = 128;

type PlaybookFileSignature = {
  filename: string;
  mtimeMs: number;
  size: number;
};

type PlaybookDirFingerprint = {
  dirMtimeMs: number;
  files: PlaybookFileSignature[];
};

type PlaybookDirCacheEntry = PlaybookDirFingerprint & {
  playbooks: Playbook[];
};

const playbookDirCache = new Map<string, PlaybookDirCacheEntry>();

/**
 * Resolve the per-user playbooks directory. Honours `KOOKR_USER_PLAYBOOKS_DIR`
 * (intended for tests and power users); defaults to `~/.kookr/playbooks/`.
 */
export function userPlaybooksDir(): string {
  const override = process.env.KOOKR_USER_PLAYBOOKS_DIR;
  // Resolve the override to an absolute path: a relative value would flow into
  // each playbook's `filePath`, and the launch context header advertises that
  // path for the agent to edit — a relative one resolves against the agent's
  // own cwd, i.e. the wrong directory (issue #1431).
  if (override && override.trim().length > 0) return resolve(override);
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
export async function discoverPlaybooks(
  cwd: string,
  options: { includeShadowed?: boolean } = {},
): Promise<Playbook[]> {
  const projectDir = join(cwd, PROJECT_PLAYBOOKS_SUBDIR);
  const userDir = userPlaybooksDir();
  const pluginDir = pluginPlaybooksDir();

  // Build the scan list, skipping any tier whose dir collides with another to
  // avoid double-reading identical files when paths overlap (e.g. a user runs
  // Kookr inside their home dir and projectDir == userDir).
  const seen = new Set<string>();

  const projectPlaybooksPromise = scanPlaybooksDirCached(projectDir, cwd, 'project');
  seen.add(projectDir);

  let userPlaybooksPromise: Promise<Playbook[]> = Promise.resolve([]);
  if (!seen.has(userDir)) {
    userPlaybooksPromise = scanPlaybooksDirCached(userDir, userDir, 'user');
    seen.add(userDir);
  }
  let pluginPlaybooksPromise: Promise<Playbook[]> = Promise.resolve([]);
  if (pluginDir !== undefined && !seen.has(pluginDir)) {
    pluginPlaybooksPromise = scanPlaybooksDirCached(pluginDir, pluginDir, 'plugin');
    seen.add(pluginDir);
  }

  const [projectPlaybooks, userPlaybooks, pluginPlaybooks, repoTags] = await Promise.all([
    projectPlaybooksPromise,
    userPlaybooksPromise,
    pluginPlaybooksPromise,
    detectRepoTags(cwd),
  ]);

  const visiblePluginPlaybooks = pluginPlaybooks.filter((playbook) => repoTagsAllow(playbook.repoTags, repoTags));

  // Schedule cloning needs every concrete resource so it can match the task's
  // immutable source identity even when a higher-precedence tier now shadows
  // the same id. Ordinary discovery keeps the winner-only catalog below.
  if (options.includeShadowed) {
    const scopeOrder: Record<PlaybookScope, number> = { project: 0, user: 1, plugin: 2 };
    return [...projectPlaybooks, ...userPlaybooks, ...visiblePluginPlaybooks]
      .sort((a, b) => a.id.localeCompare(b.id) || scopeOrder[a.scope] - scopeOrder[b.scope]);
  }

  // Merge with project > user > plugin precedence by id. Plugin-tier
  // playbooks that declare `repo-tags` are filtered out when the cwd's
  // detected tags don't intersect — this is what hides e.g. `oss-bug-fix`
  // outside github-hosted repos. Project and user playbooks bypass the
  // filter (the user explicitly placed those files).
  const byId = new Map<string, Playbook>();
  for (const pb of visiblePluginPlaybooks) byId.set(pb.id, pb);
  for (const pb of userPlaybooks) byId.set(pb.id, pb);
  for (const pb of projectPlaybooks) byId.set(pb.id, pb);

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function scanPlaybooksDirCached(
  dir: string,
  sourceCwd: string,
  scope: PlaybookScope,
): Promise<Playbook[]> {
  const cacheKey = `${scope}\0${sourceCwd}\0${dir}`;
  const fingerprint = await fingerprintPlaybooksDir(dir);
  if (fingerprint === undefined) {
    playbookDirCache.delete(cacheKey);
    return [];
  }

  const cached = playbookDirCache.get(cacheKey);
  if (cached !== undefined && fingerprintsEqual(cached, fingerprint)) {
    return cached.playbooks.slice();
  }

  const playbooks = await scanPlaybooksDir(
    dir,
    sourceCwd,
    scope,
    fingerprint.files.map((file) => file.filename),
  );
  rememberPlaybookDir(cacheKey, { ...fingerprint, playbooks });
  return playbooks.slice();
}

async function fingerprintPlaybooksDir(dir: string): Promise<PlaybookDirFingerprint | undefined> {
  let dirMtimeMs: number;
  let filenames: string[];
  try {
    const [dirStats, entries] = await Promise.all([stat(dir), readdir(dir)]);
    dirMtimeMs = dirStats.mtimeMs;
    filenames = entries.filter((entry) => entry.endsWith('.md')).sort();
  } catch {
    return undefined;
  }

  const files: PlaybookFileSignature[] = [];
  for (const filename of filenames) {
    const fileStats = await stat(join(dir, filename));
    files.push({ filename, mtimeMs: fileStats.mtimeMs, size: fileStats.size });
  }
  return { dirMtimeMs, files };
}

function fingerprintsEqual(
  cached: PlaybookDirFingerprint,
  current: PlaybookDirFingerprint,
): boolean {
  if (cached.dirMtimeMs !== current.dirMtimeMs) return false;
  if (cached.files.length !== current.files.length) return false;
  return cached.files.every((cachedFile, index) => {
    const currentFile = current.files[index];
    return (
      currentFile !== undefined &&
      cachedFile.filename === currentFile.filename &&
      cachedFile.mtimeMs === currentFile.mtimeMs &&
      cachedFile.size === currentFile.size
    );
  });
}

function rememberPlaybookDir(cacheKey: string, entry: PlaybookDirCacheEntry): void {
  playbookDirCache.delete(cacheKey);
  playbookDirCache.set(cacheKey, entry);

  if (playbookDirCache.size <= MAX_PLAYBOOK_DIR_CACHE_ENTRIES) return;
  const oldestKey = playbookDirCache.keys().next().value;
  if (oldestKey !== undefined) playbookDirCache.delete(oldestKey);
}

async function scanPlaybooksDir(
  dir: string,
  sourceCwd: string,
  scope: PlaybookScope,
  filenames: string[],
): Promise<Playbook[]> {
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
