import type { AgentAdapter, PreflightResult } from '../adapters/agent-adapter.js';
import type { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { AgentType } from '../core/agent-types.js';

/**
 * Per-adapter preflight summary surfaced to operators via `/api/health.agents`
 * and logged at startup. Mirrors {@link PreflightResult} but adds the agent
 * type so callers can index by it without correlating arrays.
 */
export type AgentPreflightSnapshot =
  | { agentType: AgentType; status: 'ok'; resolvedPath: string; version: string }
  | {
      agentType: AgentType;
      status: 'absent';
      reason: string;
      configuredVia: 'env' | 'default';
      envVarName: string;
    };

/**
 * Sink for the textual log lines a preflight run emits. Production wires
 * `console`; tests inject a recorder.
 */
export interface PreflightLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface RunAdapterPreflightsOptions {
  /**
   * Called when an adapter declared its binary via env var but the binary
   * is unreachable. The startup contract is fail-loud (matching dtach):
   * the host typically passes `() => process.exit(1)`. Tests pass a mock
   * to assert the policy without exiting the test runner.
   */
  onFatal: (snapshot: AgentPreflightSnapshot & { status: 'absent' }) => never;
  logger?: PreflightLogger;
}

const defaultLogger: PreflightLogger = {
  log: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

/**
 * Run preflight on every registered adapter that declares one. Returns
 * a snapshot keyed by agent type for the health endpoint. Adapters that
 * do not implement `preflight()` are skipped silently — non-launching
 * adapters (routing wrappers, fakes) need no probe.
 *
 * Policy:
 * - `kind:'ok'` → log `[startup] adapter=<name> binary=<path> version=<v>`
 * - `kind:'absent'`, `configuredVia:'env'` → fatal (`onFatal` is invoked
 *   and never returns); the adapter explicitly declared intent and lost it
 * - `kind:'absent'`, `configuredVia:'default'` → warn-and-continue; the
 *   operator did not configure the binary, so a Claude-only deployment
 *   should still boot when only Codex is missing
 *
 * See `docs/rfc/rfc-v8-tmux-removal.md §Startup hard requirement on the
 * dtach binary` for the matching precedent at `start.ts:42-67`.
 */
export async function runAdapterPreflights(
  registry: AdapterRegistry,
  options: RunAdapterPreflightsOptions,
): Promise<Record<string, AgentPreflightSnapshot>> {
  const logger = options.logger ?? defaultLogger;
  const out: Record<string, AgentPreflightSnapshot> = {};

  for (const adapter of registry.getAll()) {
    const snapshot = await runOneAdapterPreflight(adapter);
    if (!snapshot) continue;
    out[snapshot.agentType] = snapshot;
    if (snapshot.status === 'ok') {
      logger.log(
        `[startup] adapter=${snapshot.agentType} binary=${snapshot.resolvedPath} version=${snapshot.version}`,
      );
      continue;
    }
    if (snapshot.configuredVia === 'env') {
      logger.error(
        `[fatal] ${snapshot.agentType} binary unreachable: ${snapshot.reason}\n` +
          `  Set ${snapshot.envVarName}=<path> or unset it to fall back to PATH.`,
      );
      options.onFatal(snapshot);
    } else {
      logger.warn(
        `[startup] warning: ${snapshot.agentType} binary not found on PATH ` +
          `(${snapshot.reason}); tasks routed to ${snapshot.agentType} will fail at launch.`,
      );
    }
  }

  return out;
}

async function runOneAdapterPreflight(
  adapter: AgentAdapter,
): Promise<AgentPreflightSnapshot | null> {
  if (!adapter.preflight) return null;
  let result: PreflightResult;
  try {
    result = await adapter.preflight();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      agentType: adapter.agentType,
      status: 'absent',
      reason: `preflight() threw: ${message}`,
      configuredVia: 'default',
      envVarName: '',
    };
  }
  if (result.kind === 'ok') {
    return {
      agentType: adapter.agentType,
      status: 'ok',
      resolvedPath: result.resolvedPath,
      version: result.version,
    };
  }
  return {
    agentType: adapter.agentType,
    status: 'absent',
    reason: result.reason,
    configuredVia: result.configuredVia,
    envVarName: result.envVarName,
  };
}
