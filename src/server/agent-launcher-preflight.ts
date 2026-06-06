/**
 * Startup preflight for the spawned-agent `kookr` launcher (issue #786).
 *
 * Agents are told to run `kookr signal completion-ready`. That only works if a
 * bare `kookr` resolves on the agent PATH, which Kookr arranges by prepending
 * the bundled launcher's `bin/` dir in `buildAgentLaunchContext`. This preflight
 * proves that end-to-end *at boot* — it reconstructs the same prepended PATH and
 * runs a bare `kookr --help` through it — so a missing/broken launcher fails
 * loudly at startup rather than silently at the final completion signal.
 *
 * It mirrors the agent's own resolution path (spawn `kookr` by name, not by
 * absolute path) so it catches the exact failure mode from the issue: the shim
 * absent, not executable, or `node` itself missing from PATH.
 */
import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import { resolveAgentLauncherBinDir } from '../core/hook-writer-paths.js';

/** `kookr --help` is a pure local dispatch (~node startup); 5s is generous. */
const PREFLIGHT_TIMEOUT_MS = 5_000;
const PREFLIGHT_MAX_BUFFER_BYTES = 256 * 1024;

export type AgentLauncherPreflight =
  | { status: 'ok'; launcherDir: string }
  | { status: 'absent'; reason: string }
  | { status: 'broken'; reason: string };

export interface AgentLauncherPreflightOptions {
  /**
   * Override the resolved launcher dir. `undefined` (the default) resolves via
   * {@link resolveAgentLauncherBinDir}; an explicit `null` forces the `absent`
   * path (no launcher resolvable) — mirroring {@link buildAgentLaunchContext}'s
   * opt-out and letting tests exercise the absent branch directly.
   */
  launcherBinDir?: string | null;
  /** Base PATH the launcher dir is prepended to. Defaults to `process.env.PATH`. */
  basePath?: string;
  timeoutMs?: number;
}

/**
 * Verify that a bare `kookr` resolves and dispatches with the launcher dir
 * prepended to PATH. Resolve-only — never rejects; the caller decides how loud
 * to be. `ok` means an agent's `kookr signal …` will reach the dispatcher (exit
 * 0/3/4, never 127).
 */
export function runAgentLauncherPreflight(
  opts: AgentLauncherPreflightOptions = {},
): Promise<AgentLauncherPreflight> {
  const launcherDir =
    opts.launcherBinDir === undefined ? resolveAgentLauncherBinDir() : opts.launcherBinDir;
  if (!launcherDir) {
    return Promise.resolve({
      status: 'absent',
      reason:
        'no `kookr` launcher found next to bin/kookr.js; spawned agents cannot resolve `kookr` on PATH ' +
        '(agent `kookr signal completion-ready` would fail with exit 127). Expected an executable `bin/kookr` shim.',
    });
  }

  const basePath = opts.basePath ?? process.env.PATH ?? '';
  const PATH = basePath ? `${launcherDir}${delimiter}${basePath}` : launcherDir;

  return new Promise((resolve) => {
    execFile(
      'kookr',
      ['--help'],
      {
        env: { ...process.env, PATH },
        timeout: opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
        maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES,
      },
      (error) => {
        if (!error) {
          resolve({ status: 'ok', launcherDir });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') {
          // ENOENT here means the `kookr` shim itself was not found on PATH even
          // with launcherDir prepended (missing or not executable). A *resolved*
          // shim whose `exec node` target is missing fails differently — execFile
          // surfaces the shim's numeric exit (e.g. 127) via the generic branch
          // below, not ENOENT.
          resolve({
            status: 'broken',
            reason: `\`kookr\` did not resolve on PATH even with ${launcherDir} prepended (is the shim present and executable?)`,
          });
          return;
        }
        if (e.killed) {
          resolve({ status: 'broken', reason: `\`kookr --help\` timed out from ${launcherDir}` });
          return;
        }
        // Shim ran but exited non-zero — e.g. `node` not on PATH (exit 127) or a
        // dispatcher error. `e.message` carries the exit code + captured stderr.
        resolve({
          status: 'broken',
          reason: `\`kookr --help\` failed from ${launcherDir}: ${e.message}`,
        });
      },
    );
  });
}
