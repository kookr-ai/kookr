import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
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

/**
 * Local installed-agent identity for the executable Kookr will actually exec.
 * Distinct from launch readiness (auth/model/region) — this check performs NO
 * auth, plugin, MCP, or network work (RFC "Binary identity, readiness, and
 * compatibility" §1). Fields mirror the reviewed `grok-build-compatibility.v1`
 * manifest so a resolved identity can be matched against it.
 */
export interface InstalledBinaryIdentity {
  /** The command as configured (bare name or path), before resolution. */
  configured: string;
  /** Absolute path the command resolves to on PATH (pre-symlink-resolution). */
  launcherPath: string;
  /** realpath of {@link launcherPath} — the exact file that is exec'd. */
  canonicalPath: string;
  /** SHA-256 of the canonical file's bytes. */
  sha256: string;
  sizeBytes: number;
  /** File mode permission bits (`st_mode & 0o777`). */
  mode: number;
  uid: number;
  gid: number;
}

export type BinaryIdentityOutcome =
  | { kind: 'ok'; identity: InstalledBinaryIdentity }
  | { kind: 'absent'; reason: string };

/**
 * Injected filesystem seam so {@link resolveInstalledBinaryIdentity} is unit
 * testable without a real 152 MB binary on disk.
 */
export interface IdentityFsDeps {
  /** Resolve a bare command to an absolute path via PATH lookup; identity for absolute inputs. */
  resolveExecutablePath?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  realpath?: (p: string) => Promise<string>;
  stat?: (p: string) => Promise<{ size: number; mode: number; uid: number; gid: number }>;
  hashFile?: (p: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the canonical identity of an installed binary: PATH-resolve the
 * configured command, follow symlinks to the real file (Grok's launcher
 * `~/.grok/bin/grok` is a symlink to the versioned `grok-<ver>` binary), then
 * stat + hash the canonical file. Returns `{kind:'absent'}` on any failure so
 * callers degrade to an actionable diagnostic instead of throwing.
 */
export async function resolveInstalledBinaryIdentity(
  bin: string,
  deps: IdentityFsDeps = {},
): Promise<BinaryIdentityOutcome> {
  const env = deps.env ?? process.env;
  const resolveExec = deps.resolveExecutablePath ?? defaultResolveExecutablePath;
  const rp = deps.realpath ?? ((p) => realpath(p));
  const st =
    deps.stat ??
    (async (p) => {
      const s = await stat(p);
      return { size: s.size, mode: s.mode & 0o777, uid: s.uid, gid: s.gid };
    });
  const hf = deps.hashFile ?? hashFileSha256;

  let launcherPath: string | null;
  try {
    launcherPath = await resolveExec(bin, env);
  } catch (err) {
    return { kind: 'absent', reason: `failed to resolve "${bin}" on PATH: ${describeErr(err)}` };
  }
  if (!launcherPath) {
    return { kind: 'absent', reason: `binary "${bin}" not found on PATH` };
  }

  try {
    const canonicalPath = await rp(launcherPath);
    const s = await st(canonicalPath);
    const sha256 = await hf(canonicalPath);
    return {
      kind: 'ok',
      identity: {
        configured: bin,
        launcherPath,
        canonicalPath,
        sha256,
        sizeBytes: s.size,
        mode: s.mode,
        uid: s.uid,
        gid: s.gid,
      },
    };
  } catch (err) {
    return { kind: 'absent', reason: `identity resolution failed for "${launcherPath}": ${describeErr(err)}` };
  }
}

/** PATH-resolve a bare command; pass through an already-absolute path if executable. */
async function defaultResolveExecutablePath(
  bin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (bin.includes('/') || isAbsolute(bin)) {
    return (await isExecutable(bin)) ? bin : null;
  }
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, bin);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hashFileSha256(p: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(p);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe whether `<bin> --help` advertises a specific flag (e.g. `--plugin-dir`).
 * Used by adapters to detect optional capability of an external binary at
 * runtime, so the adapter can adapt its arg construction instead of hardcoding
 * a "this binary version supports X" assumption.
 *
 * Returns false on any failure (binary missing, timeout, non-zero exit) so the
 * caller can degrade gracefully — fail-open, never throws.
 *
 * Diagnostic mirror: `scripts/lib/probe-codex-plugin-dir.sh` implements the
 * same contract for `pnpm doctor` and `prod-restart.sh`. Keep both probes in
 * sync if the criterion changes (flag rename, version-range check, stderr
 * probing, etc.).
 */
export async function probeBinaryFlagSupport(
  bin: string,
  flag: string,
  options: { exec?: ProbeExecRunner; timeoutMs?: number } = {},
): Promise<boolean> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 2000;
  try {
    const { stdout } = await exec(bin, ['--help'], { timeout: timeoutMs });
    return stdout.includes(flag);
  } catch {
    return false;
  }
}
