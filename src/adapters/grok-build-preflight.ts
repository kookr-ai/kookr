/**
 * Grok Build installed-state resolution (issue #1343, RFC "Binary identity,
 * readiness, and compatibility").
 *
 * Composes the two LOCAL, offline concerns the RFC keeps separate from
 * launch-time auth/model/region readiness:
 *   1. Installed-agent identity — realpath + stat + sha256 of the exact
 *      executable that will be exec'd, plus its advertised version/build id
 *      (`grok version`, NOT `grok --version`; POC-A verified the subcommand).
 *   2. Reviewed-compatibility qualification — matching that identity against the
 *      sole `grok-build-compatibility.v1` manifest.
 *
 * It performs NO auth, plugin, MCP, `grok inspect`, or network work (those may
 * load plugins/config and are forbidden on the startup/health path).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolveInstalledBinaryIdentity,
  type IdentityFsDeps,
  type InstalledBinaryIdentity,
  type ProbeExecRunner,
} from './probe-agent-binary.js';
import {
  loadCompatibilityRecord,
  qualifyInstalledBuild,
  type QualificationResult,
} from './grok-build-compatibility.js';

const execFileAsync = promisify(execFile);

export interface GrokVersionInfo {
  version: string;
  buildId: string;
  channel?: string;
}

/**
 * Parse `grok version` output. POC-A observed the exact format
 * `grok 0.2.93 (f00f96316d) [stable]` — `grok <semver> (<buildid>) [<channel>]`.
 * Returns `null` when the line does not match, so callers report an actionable
 * "unrecognized version output" rather than guessing.
 */
export function parseGrokVersionOutput(stdout: string): GrokVersionInfo | null {
  const line = stdout.split('\n')[0]?.trim() ?? '';
  const match = line.match(/^grok\s+(\S+)\s+\(([0-9a-f]+)\)(?:\s+\[([^\]]+)\])?/i);
  if (!match) return null;
  return { version: match[1]!, buildId: match[2]!, channel: match[3] };
}

/** Map Node's `process.arch`/`platform` to the manifest platform tuple vocabulary. */
export function resolveHostPlatform(
  proc: { platform: NodeJS.Platform; arch: string } = process,
): { os: string; arch: string } {
  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'arm64' };
  return { os: proc.platform, arch: archMap[proc.arch] ?? proc.arch };
}

export type GrokInstalledState =
  | {
      kind: 'ok';
      version: string;
      buildId: string;
      channel?: string;
      identity: InstalledBinaryIdentity;
      qualification: QualificationResult;
    }
  | { kind: 'absent'; reason: string };

export interface ResolveGrokInstalledStateOptions {
  agentBin: string;
  /** Injected `grok version` runner (defaults to execFile). */
  exec?: ProbeExecRunner;
  /** Injected fs seam for identity resolution. */
  identityFs?: IdentityFsDeps;
  env?: NodeJS.ProcessEnv;
  host?: { os: string; arch: string };
  timeoutMs?: number;
  /** Injected manifest reader (defaults to the on-disk reviewed manifest). */
  loadRecord?: typeof loadCompatibilityRecord;
}

/**
 * Resolve the full local installed state for a Grok binary: version/build id +
 * canonical identity + manifest qualification. Returns `{kind:'absent'}` when
 * the binary cannot be found or does not respond to `grok version`.
 */
export async function resolveGrokInstalledState(
  opts: ResolveGrokInstalledStateOptions,
): Promise<GrokInstalledState> {
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 5000;

  let versionInfo: GrokVersionInfo | null;
  try {
    const { stdout } = await exec(opts.agentBin, ['version'], { timeout: timeoutMs });
    versionInfo = parseGrokVersionOutput(stdout);
  } catch (err) {
    return { kind: 'absent', reason: describeVersionError(opts.agentBin, err) };
  }
  if (!versionInfo) {
    return { kind: 'absent', reason: `"${opts.agentBin} version" output was not recognized as a Grok build` };
  }

  const identityOutcome = await resolveInstalledBinaryIdentity(opts.agentBin, {
    ...opts.identityFs,
    env,
  });
  if (identityOutcome.kind === 'absent') {
    return { kind: 'absent', reason: identityOutcome.reason };
  }

  const host = opts.host ?? resolveHostPlatform();
  const loadRecord = opts.loadRecord ?? loadCompatibilityRecord;
  const loaded = loadRecord(env);
  let qualification: QualificationResult;
  if (loaded.kind === 'error') {
    qualification = { status: 'unknown', reason: loaded.reason };
  } else {
    qualification = qualifyInstalledBuild(
      { sha256: identityOutcome.identity.sha256, version: versionInfo.version, buildId: versionInfo.buildId },
      host,
      loaded.record,
    );
  }

  return {
    kind: 'ok',
    version: versionInfo.version,
    buildId: versionInfo.buildId,
    channel: versionInfo.channel,
    identity: identityOutcome.identity,
    qualification,
  };
}

const defaultExec: ProbeExecRunner = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: options.timeout,
    encoding: 'utf-8',
    windowsHide: true,
  });
  return { stdout, stderr };
};

function describeVersionError(bin: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return `binary "${bin}" not found on PATH`;
  if (code === 'EACCES') return `binary "${bin}" not executable (permission denied)`;
  if (code === 'ETIMEDOUT') return `binary "${bin}" timed out responding to "version"`;
  return `"${bin} version" failed: ${err instanceof Error ? err.message : String(err)}`;
}
