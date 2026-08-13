/**
 * Per-session GROK_HOME composer (issue #1343, POC-A constraint 1 + RFC
 * "Hooks and normalization").
 *
 * POC-A proved that Kookr must inject its launch-scoped monitoring hooks via a
 * per-session `GROK_HOME` composition, NOT via `--plugin-dir` (which the
 * interactive root `grok` rejects) and NEVER by mutating the operator's real
 * `~/.grok` as a launch side effect for hooks/plugins. This helper builds an
 * isolated, owned `GROK_HOME` directory for one managed session:
 *
 *   <grokHome>/
 *     hooks/kookr-monitoring.json          ← Kookr's monitoring instrumentation
 *     hooks/kookr-writing-review-nudge.json ← soft gh-pr-create reminder (#2455)
 *     plugins/<name> -> <real>/plugins/<name>   ← toolkit discovery (read-only links)
 *     plugins/kookr-toolkit -> <resolved plugin dir>  ← fallback when ~/.grok/plugins is empty
 *
 * Credentials are NOT copied into the session home. Copying `auth.json` clones
 * a rotating OIDC refresh token into N private files; the first agent refresh
 * revokes the RT for every other agent and for the operator's real home.
 * Instead, the adapter points Grok at the operator's real credential via
 * `GROK_AUTH_PATH` (shared file + shared flock). See
 * {@link resolveSharedGrokAuthPath}.
 *
 * Grok's config root for hooks/plugins is redirected here by setting
 * `GROK_HOME` — the process keeps the real `HOME` so git/ssh/etc. still work
 * for the coding task.
 *
 * The Toolkit itself is distributed into the real `~/.grok/plugins/` by the
 * deploy flow (mirroring `~/.claude/plugins`); this composer merely links those
 * plugins into the session home so an isolated `GROK_HOME` can still discover
 * them.
 */
import { access, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildGrokMonitoringHooksConfig,
  type BuildGrokMonitoringHooksOptions,
} from './grok-build-instrumentation/monitoring-hooks.js';
import {
  GROK_WRITING_REVIEW_NUDGE_FILENAME,
  buildGrokWritingReviewNudgeConfig,
} from './grok-build-instrumentation/writing-review-nudge.js';

/** Filesystem seam so composition is unit-testable without touching a real home. */
export interface GrokHomeFs {
  mkdir: (p: string, opts: { recursive: true }) => Promise<unknown>;
  writeFile: (p: string, data: string) => Promise<void>;
  access: (p: string) => Promise<void>;
  symlink: (target: string, path: string) => Promise<void>;
  readdir: (p: string) => Promise<string[]>;
}

const defaultFs: GrokHomeFs = {
  mkdir: (p, opts) => mkdir(p, opts),
  writeFile: (p, data) => writeFile(p, data),
  access: (p) => access(p),
  symlink: (target, path) => symlink(target, path),
  readdir: (p) => readdir(p),
};

export const GROK_MONITORING_HOOKS_FILENAME = 'kookr-monitoring.json';
export { GROK_WRITING_REVIEW_NUDGE_FILENAME };
/** File name of the shared OIDC/session credential store inside a Grok home. */
export const GROK_AUTH_FILENAME = 'auth.json';
export const GROK_TOOLKIT_PLUGIN_NAME = 'kookr-toolkit';

export interface ComposeGrokHomeOptions {
  /** Absolute path of the per-session directory to populate as GROK_HOME. */
  grokHome: string;
  /** The operator's real Grok home (`~/.grok`) to seed plugins from + share auth. */
  sourceGrokHome: string;
  /** Monitoring-hook wiring (session id, hook file, writer path, port). */
  monitoring: BuildGrokMonitoringHooksOptions;
  /**
   * Plugin directory to symlink when the operator's ~/.grok/plugins has no
   * kookr-toolkit. Isolated Grok sessions cannot take `--plugin-dir`, so we
   * reuse the same tree Claude already resolved.
   */
  toolkitPluginDir?: string;
  fs?: Partial<GrokHomeFs>;
}

export interface ComposedGrokHome {
  grokHome: string;
  hooksPath: string;
  /** Plugin names linked in from the source home (empty when none present). */
  linkedPlugins: string[];
  /**
   * Absolute path of the operator's real `auth.json` when present. Callers set
   * `GROK_AUTH_PATH` to this so every managed session shares one rotating RT.
   * `null` when the source home has no credential file yet.
   */
  authPath: string | null;
  /** @deprecated Prefer {@link authPath}; true when `authPath` is non-null. */
  authSeeded: boolean;
}

/**
 * Absolute path of the shared credential file under the operator's real Grok
 * home. Does not check existence — use {@link resolveSharedGrokAuthPath}.
 */
export function sharedGrokAuthPath(sourceGrokHome: string): string {
  return join(sourceGrokHome, GROK_AUTH_FILENAME);
}

/**
 * Return the operator's real `auth.json` path if it exists; otherwise `null`.
 * Used so launches can fail closed before creating a terminal, and so the
 * child env can set `GROK_AUTH_PATH` to a single shared file.
 */
export async function resolveSharedGrokAuthPath(
  sourceGrokHome: string,
  fs: Pick<GrokHomeFs, 'access'> = defaultFs,
): Promise<string | null> {
  const path = sharedGrokAuthPath(sourceGrokHome);
  try {
    await fs.access(path);
    return path;
  } catch {
    return null;
  }
}

/**
 * Compose the session GROK_HOME. Idempotent per directory. Auth is shared via
 * the operator's real home (not copied). Missing plugins degrade gracefully.
 */
export async function composeGrokHome(opts: ComposeGrokHomeOptions): Promise<ComposedGrokHome> {
  const fs: GrokHomeFs = { ...defaultFs, ...opts.fs };
  const hooksDir = join(opts.grokHome, 'hooks');
  const pluginsDir = join(opts.grokHome, 'plugins');
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.mkdir(pluginsDir, { recursive: true });

  // 1. Monitoring hooks — Kookr's internal instrumentation, launch-scoped.
  const hooksConfig = buildGrokMonitoringHooksConfig(opts.monitoring);
  const hooksPath = join(hooksDir, GROK_MONITORING_HOOKS_FILENAME);
  await fs.writeFile(hooksPath, JSON.stringify(hooksConfig, null, 2));

  // 1b. Soft writing/review reminder on gh pr create (issue #2455). Omitted
  // when the bundled script is missing so composition still succeeds.
  const nudgeConfig = buildGrokWritingReviewNudgeConfig();
  if (nudgeConfig) {
    await fs.writeFile(
      join(hooksDir, GROK_WRITING_REVIEW_NUDGE_FILENAME),
      JSON.stringify(nudgeConfig, null, 2),
    );
  }

  // 2. Resolve shared auth path (no copy — OIDC RT must have a single writer).
  const authPath = await resolveSharedGrokAuthPath(opts.sourceGrokHome, fs);

  // 3. Link toolkit plugins from the real home for discovery (read-only links).
  const linkedPlugins = await linkPlugins(fs, opts.sourceGrokHome, pluginsDir);

  // 3b. When ~/.grok/plugins is empty or lacks kookr-toolkit, fall back to the
  // same resolved plugin tree Claude already injects via --plugin-dir.
  if (!linkedPlugins.includes(GROK_TOOLKIT_PLUGIN_NAME) && opts.toolkitPluginDir) {
    const linked = await linkToolkitFallback(fs, opts.toolkitPluginDir, pluginsDir);
    if (linked) linkedPlugins.push(GROK_TOOLKIT_PLUGIN_NAME);
  }

  return {
    grokHome: opts.grokHome,
    hooksPath,
    linkedPlugins,
    authPath,
    authSeeded: authPath !== null,
  };
}

async function linkPlugins(fs: GrokHomeFs, sourceGrokHome: string, destPluginsDir: string): Promise<string[]> {
  const sourcePlugins = join(sourceGrokHome, 'plugins');
  let entries: string[];
  try {
    entries = await fs.readdir(sourcePlugins);
  } catch {
    return []; // No plugins deployed to the real home — not fatal.
  }
  const linked: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    try {
      await fs.symlink(join(sourcePlugins, name), join(destPluginsDir, name));
      linked.push(name);
    } catch {
      /* skip un-linkable entry; discovery of the others still works */
    }
  }
  return linked;
}

/**
 * If the operator's ~/.grok/plugins has no toolkit, symlink the plugin
 * directory Claude already found. Fail-open: a missing or unlinkable tree
 * leaves linkedPlugins unchanged.
 */
async function linkToolkitFallback(
  fs: GrokHomeFs,
  toolkitPluginDir: string,
  destPluginsDir: string,
): Promise<boolean> {
  try {
    await fs.access(join(toolkitPluginDir, '.claude-plugin', 'plugin.json'));
  } catch {
    return false;
  }
  try {
    await fs.symlink(toolkitPluginDir, join(destPluginsDir, GROK_TOOLKIT_PLUGIN_NAME));
    return true;
  } catch {
    return false;
  }
}
