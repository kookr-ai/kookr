/**
 * opencode binary resolution + pinned-version preflight (RFC
 * rfc-opencode-agent-integration §1).
 *
 * The plugin API changed incompatibly between opencode 1.19.x and 2.x, so Kookr
 * pins one release and refuses any other unless the operator opts out with
 * `KOOKR_OPENCODE_ALLOW_ANY_VERSION=1`. Offline and cheap: one `--version` probe.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PreflightResult } from './agent-adapter.js';
import { probeAgentBinary, type ProbeExecRunner } from './probe-agent-binary.js';

export const OPENCODE_PINNED_VERSION = '1.19.5';
export const OPENCODE_BIN_ENV = 'KOOKR_OPENCODE_BIN';
export const OPENCODE_ENABLED_ENV = 'KOOKR_OPENCODE_ENABLED';
export const OPENCODE_ALLOW_ANY_VERSION_ENV = 'KOOKR_OPENCODE_ALLOW_ANY_VERSION';

export interface OpenCodeBinResolution {
  bin: string;
  configuredVia: 'env' | 'default';
}

/** Path of the Kookr-managed pinned install under `~/.kookr/tools`. */
export function pinnedOpenCodeToolPath(home: string = homedir()): string {
  return join(home, '.kookr', 'tools', `opencode-${OPENCODE_PINNED_VERSION}`, 'node_modules', '.bin', 'opencode');
}

/** `KOOKR_OPENCODE_BIN`, else the pinned tools install when present, else `opencode` on PATH. */
export function resolveOpenCodeBin(
  env: NodeJS.ProcessEnv = process.env,
  opts: { home?: string; exists?: (path: string) => boolean } = {},
): OpenCodeBinResolution {
  const configured = env[OPENCODE_BIN_ENV]?.trim();
  if (configured) return { bin: configured, configuredVia: 'env' };
  const pinned = pinnedOpenCodeToolPath(opts.home);
  if ((opts.exists ?? existsSync)(pinned)) return { bin: pinned, configuredVia: 'default' };
  return { bin: 'opencode', configuredVia: 'default' };
}

/** The opencode agent is opt-in: only `KOOKR_OPENCODE_ENABLED=1` (or `true`/`yes`) registers it. */
export function isOpenCodeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPENCODE_ENABLED_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function allowAnyVersion(env: NodeJS.ProcessEnv): boolean {
  const raw = env[OPENCODE_ALLOW_ANY_VERSION_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export interface OpenCodePreflightOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: `<bin> --version` runner. */
  exec?: ProbeExecRunner;
  /** Overrides the resolved binary (constructor `agentBin`). */
  resolution?: OpenCodeBinResolution;
}

export async function preflightOpenCode(opts: OpenCodePreflightOptions = {}): Promise<PreflightResult> {
  const env = opts.env ?? process.env;
  const { bin, configuredVia } = opts.resolution ?? resolveOpenCodeBin(env);
  const absent = (reason: string): PreflightResult => ({
    kind: 'absent',
    reason,
    configuredVia,
    envVarName: OPENCODE_BIN_ENV,
  });

  const probe = await probeAgentBinary(bin, { exec: opts.exec });
  if (probe.kind === 'absent') return absent(probe.reason);
  if (probe.version !== OPENCODE_PINNED_VERSION && !allowAnyVersion(env)) {
    return absent(
      `opencode ${probe.version} at "${bin}" does not match pinned ${OPENCODE_PINNED_VERSION} ` +
        `(plugin API is version-specific; set ${OPENCODE_ALLOW_ANY_VERSION_ENV}=1 to override)`,
    );
  }
  return { kind: 'ok', resolvedPath: bin, version: probe.version, probePath: probe.probePath };
}
