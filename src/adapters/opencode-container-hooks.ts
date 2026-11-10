import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHookWriterPath } from '../core/hook-writer-paths.js';

/**
 * Hook assets a container worker runs (RFC #3541 §2a "Hook commands are rewritten for the container").
 *
 * The files are COPIED into a per-task directory at launch (mounted read-only at `/kookr-hooks`), not bind-mounted from
 * the live install: a Kookr upgrade in the middle of a task cannot swap hook code under a running worker. The copy also
 * writes a MANIFEST of container-side paths; the image entrypoint refuses to start (exit 14) if any listed file is
 * missing, so a broken mapping blocks the launch instead of silently letting every Stop through (a missing command
 * exits 127 and only exit 2 blocks).
 */
export const CONTAINER_HOOKS_ROOT = '/kookr-hooks';
export const CONTAINER_SPOOL_ROOT = '/kookr-spool';
export const CONTAINER_LEDGER_FILE = `${CONTAINER_SPOOL_ROOT}/ledger.jsonl`;
export const CONTAINER_NODE = '/usr/local/bin/node';

export const CONTAINER_PATHS = {
  node: CONTAINER_NODE,
  pluginHooksDir: `${CONTAINER_HOOKS_ROOT}/plugin-hooks`,
  binDir: `${CONTAINER_HOOKS_ROOT}/bin`,
} as const;

const BIN_FILES = ['kookr-hook-writer.js', 'kookr-opencode-gate.js', 'kookr-stop-nudge.js'];
const PLUGIN_HOOK_FILES = ['nb-inject.sh', 'nb-inject.mjs', 'nb-retro.sh', 'nb-retro.mjs'];

export interface StageHooksOptions {
  hostBinDir: string;
  hostPluginHooksDir: string;
  destDir: string;
  /** Test seam: files to leave out of the copy while keeping them in the MANIFEST (the "hook missing" case). */
  omit?: string[];
}

export interface StagedHooks {
  dir: string;
  manifest: string[];
}

export async function stageContainerHooks(opts: StageHooksOptions): Promise<StagedHooks> {
  await rm(opts.destDir, { recursive: true, force: true });
  const binOut = join(opts.destDir, 'bin');
  const hooksOut = join(opts.destDir, 'plugin-hooks');
  await mkdir(binOut, { recursive: true, mode: 0o755 });
  await mkdir(hooksOut, { recursive: true, mode: 0o755 });
  const manifest: string[] = [];
  for (const f of BIN_FILES) {
    manifest.push(`${CONTAINER_PATHS.binDir}/${f}`);
    if (opts.omit?.includes(f)) continue;
    await copyFile(join(opts.hostBinDir, f), join(binOut, f));
    await chmod(join(binOut, f), 0o755);
  }
  for (const f of PLUGIN_HOOK_FILES) {
    manifest.push(`${CONTAINER_PATHS.pluginHooksDir}/${f}`);
    if (opts.omit?.includes(f)) continue;
    await copyFile(join(opts.hostPluginHooksDir, f), join(hooksOut, f));
    await chmod(join(hooksOut, f), 0o755);
  }
  await writeFile(join(opts.destDir, 'MANIFEST'), `${manifest.join('\n')}\n`, { mode: 0o644 });
  return { dir: opts.destDir, manifest };
}

/**
 * The command the plugin runs for every hook event inside the container: the existing hook writer appending to the
 * per-task ledger (no `--url`, so it never reaches for `localhost`, which in a container is not Kookr).
 */
export function buildContainerLedgerCommand(sessionKey: string): string {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  return `${q(CONTAINER_NODE)} ${q(`${CONTAINER_PATHS.binDir}/kookr-hook-writer.js`)} --session ${q(sessionKey)} --file ${q(CONTAINER_LEDGER_FILE)}`;
}

/** Host-side hook-writer presence check, so a launch is refused (not degraded) when the install lacks it. */
export function hostHookWriterAvailable(): boolean {
  return resolveHookWriterPath() !== undefined;
}
