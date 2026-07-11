/**
 * Per-session GROK_HOME composer (issue #1343, POC-A constraint 1 + RFC
 * "Hooks and normalization").
 *
 * POC-A proved that Kookr must inject its launch-scoped monitoring hooks via a
 * per-session `GROK_HOME` composition, NOT via `--plugin-dir` (which the
 * interactive root `grok` rejects) and NEVER by mutating the operator's real
 * `~/.grok` as a launch side effect. This helper builds an isolated, owned
 * `GROK_HOME` directory for one managed session:
 *
 *   <grokHome>/
 *     hooks/kookr-monitoring.json   ← Kookr's monitoring instrumentation
 *     plugins/<name> -> <real>/plugins/<name>   ← toolkit discovery (read-only links)
 *     auth.json (+ .lock)           ← copied 0600 from the real home, if present
 *
 * The real `~/.grok` is only READ (auth + plugin listing); it is never written.
 * Grok's own config root is redirected here by setting `GROK_HOME` — the
 * process keeps the real `HOME` so git/ssh/etc. still work for the coding task.
 *
 * The Toolkit itself is distributed into the real `~/.grok/plugins/` by the
 * deploy flow (mirroring `~/.claude/plugins`); this composer merely links those
 * plugins into the session home so an isolated `GROK_HOME` can still discover
 * them.
 */
import { chmod, copyFile, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildGrokMonitoringHooksConfig,
  type BuildGrokMonitoringHooksOptions,
} from './grok-build-instrumentation/monitoring-hooks.js';

/** Filesystem seam so composition is unit-testable without touching a real home. */
export interface GrokHomeFs {
  mkdir: (p: string, opts: { recursive: true }) => Promise<unknown>;
  writeFile: (p: string, data: string) => Promise<void>;
  copyFile: (src: string, dest: string) => Promise<void>;
  chmod: (p: string, mode: number) => Promise<void>;
  symlink: (target: string, path: string) => Promise<void>;
  readdir: (p: string) => Promise<string[]>;
}

const defaultFs: GrokHomeFs = {
  mkdir: (p, opts) => mkdir(p, opts),
  writeFile: (p, data) => writeFile(p, data),
  copyFile: (src, dest) => copyFile(src, dest),
  chmod: (p, mode) => chmod(p, mode),
  symlink: (target, path) => symlink(target, path),
  readdir: (p) => readdir(p),
};

export const GROK_MONITORING_HOOKS_FILENAME = 'kookr-monitoring.json';

export interface ComposeGrokHomeOptions {
  /** Absolute path of the per-session directory to populate as GROK_HOME. */
  grokHome: string;
  /** The operator's real Grok home (`~/.grok`) to seed auth + plugins from. */
  sourceGrokHome: string;
  /** Monitoring-hook wiring (session id, hook file, writer path, port). */
  monitoring: BuildGrokMonitoringHooksOptions;
  fs?: Partial<GrokHomeFs>;
}

export interface ComposedGrokHome {
  grokHome: string;
  hooksPath: string;
  /** Plugin names linked in from the source home (empty when none present). */
  linkedPlugins: string[];
  /** Whether an `auth.json` was seeded from the source home. */
  authSeeded: boolean;
}

/**
 * Compose the session GROK_HOME. Idempotent per directory. Auth/plugin seeding
 * degrade gracefully: a missing source `auth.json` or `plugins/` is not fatal
 * (auth surfaces later as a launch-readiness diagnostic; missing plugins just
 * means no toolkit that session), so composition never blocks a launch on
 * optional inputs.
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

  // 2. Seed auth (copy 0600, never symlink into the real home so a session
  //    cannot mutate the operator's credential).
  const authSeeded = await seedAuth(fs, opts.sourceGrokHome, opts.grokHome);

  // 3. Link toolkit plugins from the real home for discovery (read-only links).
  const linkedPlugins = await linkPlugins(fs, opts.sourceGrokHome, pluginsDir);

  return { grokHome: opts.grokHome, hooksPath, linkedPlugins, authSeeded };
}

async function seedAuth(fs: GrokHomeFs, sourceGrokHome: string, grokHome: string): Promise<boolean> {
  const src = join(sourceGrokHome, 'auth.json');
  const dest = join(grokHome, 'auth.json');
  try {
    await fs.copyFile(src, dest);
    await fs.chmod(dest, 0o600);
  } catch {
    return false; // No credential to seed — launch readiness will report the 403/absent auth.
  }
  // Best-effort lock file; ignore if absent.
  try {
    await fs.copyFile(join(sourceGrokHome, 'auth.json.lock'), join(grokHome, 'auth.json.lock'));
  } catch {
    /* optional */
  }
  return true;
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
