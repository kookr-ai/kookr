import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Which probe flag produced an accepted outcome. `--version` is an authentic
 * version read; `--help` is a liveness fallback whose version is best-effort
 * (usage text usually carries no version, so it reports {@link UNKNOWN_VERSION}).
 * Surfaced so logs can distinguish a real version read from a fallback check.
 */
export type ProbePath = '--version' | '--help';

/**
 * Explicit marker reported when probe stdout carries no version-shaped
 * substring (e.g. `--help` usage text). Guarantees usage/help text is never
 * surfaced verbatim as a version string.
 */
export const UNKNOWN_VERSION = 'unknown';

/**
 * Outcome of {@link probeAgentBinary}. The "absent" branch carries a
 * human-readable reason; configuredVia / envVarName are bolted on by the
 * caller (the adapter knows its own env var; the probe only knows whether
 * the binary actually responded). The "ok" branch records which probe path
 * ({@link ProbePath}) succeeded so a fallback liveness check is distinguishable
 * from a genuine version read.
 */
export type ProbeOutcome =
  | { kind: 'ok'; resolvedPath: string; version: string; probePath: ProbePath }
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

/** Timeout for the `--help` liveness fallback (matches the dtach preflight). */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;
/**
 * The `--version` attempt gets a longer budget than the `--help` fallback: a
 * slow cold start (the binary being loaded/JIT-warmed) previously timed out at
 * 2 s and demoted the boot onto the `--help` fallback, which reports no real
 * version. A wider window lets the authentic read win before falling back.
 */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * Probe an agent binary by spawning `<bin> --version`, falling back to
 * `<bin> --help` if `--version` fails or returns nothing useful. Any non-empty
 * stdout under exit 0 is accepted; the version string is the first numeric
 * sequence (e.g. `1.0.86`) found on the first line of stdout, or the explicit
 * {@link UNKNOWN_VERSION} marker if no version-shaped substring is present (so
 * `--help` usage text is never surfaced verbatim as a version).
 *
 * The `--version` attempt is bounded by {@link DEFAULT_VERSION_PROBE_TIMEOUT_MS}
 * (overridable via `versionTimeoutMs`) to survive slow cold starts; the `--help`
 * fallback uses the shorter {@link DEFAULT_PROBE_TIMEOUT_MS} (`timeoutMs`). On
 * any failure path the probe returns `{kind:'absent', reason}` so the caller can
 * decide fatal-vs-warn from policy. The accepted outcome records which
 * {@link ProbePath} won.
 */
export async function probeAgentBinary(
  bin: string,
  options: { exec?: ProbeExecRunner; timeoutMs?: number; versionTimeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const exec = options.exec ?? defaultExec;
  const helpTimeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS;

  const versionAttempt = await tryProbe(exec, bin, '--version', versionTimeoutMs);
  if (versionAttempt.kind === 'ok') return versionAttempt;
  const helpAttempt = await tryProbe(exec, bin, '--help', helpTimeoutMs);
  if (helpAttempt.kind === 'ok') return helpAttempt;
  return { kind: 'absent', reason: versionAttempt.reason };
}

async function tryProbe(
  exec: ProbeExecRunner,
  bin: string,
  probePath: ProbePath,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  try {
    const { stdout } = await exec(bin, [probePath], { timeout: timeoutMs });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { kind: 'absent', reason: `${bin} ${probePath} produced empty output` };
    }
    return { kind: 'ok', resolvedPath: bin, version: extractVersion(trimmed), probePath };
  } catch (err) {
    return { kind: 'absent', reason: describeProbeError(bin, err) };
  }
}

/**
 * Extract a version from probe stdout, scanning only the first line for a
 * semver-shaped substring. Returns {@link UNKNOWN_VERSION} when none matches —
 * never the raw first line — so `--help` usage text (e.g.
 * `Usage: claude [options] [command] [prompt]`) can never be reported as a
 * version.
 */
function extractVersion(stdout: string): string {
  const firstLine = stdout.split('\n')[0]!.trim();
  const match = firstLine.match(/[\d]+(?:\.[\d]+){1,3}(?:-[A-Za-z0-9.]+)?/);
  return match ? match[0] : UNKNOWN_VERSION;
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

/**
 * In-process SHA-256 cache keyed by the file's on-disk identity. Agent binaries
 * are large (the Grok build is ~240 MB, ~0.9 s to hash), and identity is
 * re-resolved on every server boot and before every Grok launch. Any write,
 * rename-over or replacement changes the inode or ctime, and ctime cannot be
 * set from userland, so an unchanged key means the bytes the earlier hash
 * covered are still the bytes on disk.
 *
 * Kernel file timestamps are coarse (a few ms), so a second write landing in
 * the same tick as the first would keep the same ctime. Like git's "racily
 * clean" rule, a file changed within the last few seconds is hashed but never
 * cached; only a settled file is trusted by its stat identity.
 */
export interface CachedFileHasherOptions {
  /** Hashes the file's bytes (defaults to a streaming SHA-256). */
  hashUncached?: (p: string) => Promise<string>;
  /** Wall clock in ms (defaults to Date.now). */
  now?: () => number;
  /** A file whose ctime is younger than this is never cached. */
  settleMs?: number;
  maxEntries?: number;
}

/** Build a file hasher that reuses a result while the file's identity is unchanged. */
export function createCachedFileHasher(opts: CachedFileHasherOptions = {}): (p: string) => Promise<string> {
  const hashUncached = opts.hashUncached ?? hashFileSha256Uncached;
  const now = opts.now ?? Date.now;
  const settleMs = opts.settleMs ?? 2_000;
  const maxEntries = opts.maxEntries ?? 32;
  const byIdentity = new Map<string, Promise<string>>();
  return async (p) => {
    const s = await stat(p, { bigint: true });
    const key = `${p}\0${s.dev}\0${s.ino}\0${s.size}\0${s.mtimeNs}\0${s.ctimeNs}`;
    const cached = byIdentity.get(key);
    if (cached) return cached;
    const pending = hashUncached(p);
    if (now() - Number(s.ctimeMs) < settleMs) return pending;
    if (byIdentity.size >= maxEntries) byIdentity.clear();
    byIdentity.set(key, pending);
    pending.catch(() => byIdentity.delete(key));
    return pending;
  };
}

const hashFileSha256 = createCachedFileHasher();

export function hashFileSha256Uncached(p: string): Promise<string> {
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
