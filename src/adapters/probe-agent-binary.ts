import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Outcome of {@link probeAgentBinary}. The "absent" branch carries a
 * human-readable reason; configuredVia / envVarName are bolted on by the
 * caller (the adapter knows its own env var; the probe only knows whether
 * the binary actually responded).
 */
export type ProbeOutcome =
  | { kind: 'ok'; resolvedPath: string; version: string }
  | { kind: 'absent'; reason: string };

/**
 * Spawned-process result shape that {@link probeAgentBinary} expects from
 * its injected runner. Mirrors `util.promisify(execFile)`'s resolved value.
 */
export interface ProbeRunResult {
  stdout: string;
  stderr: string;
}

export type ProbeExecRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<ProbeRunResult>;

/**
 * Probe an agent binary by spawning `<bin> --version`, falling back to
 * `<bin> --help` if `--version` fails or returns nothing useful. Any non-empty
 * stdout under exit 0 is accepted; the version string is the first numeric
 * sequence (e.g. `1.0.86`) found in stdout, or the trimmed first line if no
 * version-shaped substring is present.
 *
 * Spawn is bounded by a 2 s timeout per probe (matching the dtach preflight
 * in `start.ts:54-58`). On any failure path the probe returns `{kind:'absent',
 * reason}` so the caller can decide fatal-vs-warn from policy.
 */
export async function probeAgentBinary(
  bin: string,
  options: { exec?: ProbeExecRunner; timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 2000;

  const versionAttempt = await tryProbe(exec, bin, ['--version'], timeoutMs);
  if (versionAttempt.kind === 'ok') return versionAttempt;
  const helpAttempt = await tryProbe(exec, bin, ['--help'], timeoutMs);
  if (helpAttempt.kind === 'ok') return helpAttempt;
  return { kind: 'absent', reason: versionAttempt.reason };
}

async function tryProbe(
  exec: ProbeExecRunner,
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<ProbeOutcome> {
  try {
    const { stdout } = await exec(bin, args, { timeout: timeoutMs });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { kind: 'absent', reason: `${bin} ${args.join(' ')} produced empty output` };
    }
    return { kind: 'ok', resolvedPath: bin, version: extractVersion(trimmed) };
  } catch (err) {
    return { kind: 'absent', reason: describeProbeError(bin, err) };
  }
}

function extractVersion(stdout: string): string {
  const firstLine = stdout.split('\n')[0]!.trim();
  const match = firstLine.match(/[\d]+(?:\.[\d]+){1,3}(?:-[A-Za-z0-9.]+)?/);
  return match ? match[0] : firstLine;
}

function describeProbeError(bin: string, err: unknown): string {
  if (!(err instanceof Error)) return `${bin} probe failed: ${String(err)}`;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return `binary "${bin}" not found on PATH`;
  if (code === 'EACCES') return `binary "${bin}" not executable (permission denied)`;
  if (code === 'ETIMEDOUT') return `binary "${bin}" timed out responding to probe`;
  return `${bin} probe failed: ${err.message}`;
}

const defaultExec: ProbeExecRunner = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: options.timeout,
    encoding: 'utf-8',
    windowsHide: true,
  });
  return { stdout, stderr };
};
