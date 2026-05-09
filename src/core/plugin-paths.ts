import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PLUGIN_MANIFEST_REL = '.claude-plugin/plugin.json';

/**
 * The compile-time module location, used as the fallback origin for resolving
 * the bundled `<repo-root>/plugin` directory. Both `src/core/*.ts` (dev/test)
 * and `dist/core/*.js` (compiled) sit two levels deep, so `../../plugin`
 * lands on the same path either way.
 */
const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/**
 * Resolve the kookr-toolkit plugin tree.
 *
 * Resolution order:
 *   1. The explicit `explicit` argument (including empty string = disable).
 *   2. `KOOKR_PLUGIN_DIR` env var.
 *   3. `<repo-root>/plugin` inferred from this module's compiled location.
 *
 * Returns `undefined` if no candidate contains `.claude-plugin/plugin.json`,
 * so callers can skip plugin injection rather than passing a bad path.
 */
export function resolvePluginDir(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = moduleDir,
): string | undefined {
  if (explicit !== undefined) {
    return explicit && pluginDirIsValid(explicit) ? explicit : undefined;
  }
  const fromEnv = env.KOOKR_PLUGIN_DIR;
  if (fromEnv !== undefined) {
    return fromEnv && pluginDirIsValid(fromEnv) ? fromEnv : undefined;
  }
  const candidate = resolve(baseDir, '..', '..', 'plugin');
  return pluginDirIsValid(candidate) ? candidate : undefined;
}

export function pluginDirIsValid(p: string): boolean {
  return existsSync(resolve(p, PLUGIN_MANIFEST_REL));
}
