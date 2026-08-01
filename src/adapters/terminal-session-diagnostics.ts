/**
 * Adapter-internal per-session transport diagnostics.
 *
 * This module deliberately lives OFF the {@link TerminalBackend} port. The raw
 * shape below exposes adapter-internal transport internals (`masterPid`,
 * `agentPid`, `attachChildAlive`, `attachGeneration`, `ringHead`, …) that must
 * never reach browser clients. Keeping the type and its accessor here — rather
 * than on the generic `TerminalBackend` port — makes that guard STRUCTURAL: a
 * plain `TerminalBackend` handle cannot reach these internals, so a consumer
 * has to opt in explicitly by depending on {@link TerminalSessionDiagnosticsSource}.
 *
 * Server-side consumers (the session-health service and the liveness probe)
 * legitimately need these raw fields, but the only browser-facing surface is
 * the privacy-safe DTO projected in `shared/contracts/session-health.ts`
 * (`SessionHealthBackend`), derived by `classifySessionHealth`. Nothing raw is
 * exposed at the port boundary.
 *
 * See: GitHub issue #1828 (arch: move TerminalSessionDiagnostics off the port).
 */

import type { SessionId } from './terminal-backend.js';

/**
 * Server-only per-session transport diagnostics. The session-health service
 * projects this raw adapter shape to a privacy-safe wire DTO; callers must not
 * forward this interface directly to browser clients.
 */
export interface TerminalSessionDiagnostics {
  sessionId: SessionId;
  socketPresent: boolean | null;
  identityVerified: boolean | null;
  masterPid: number | null;
  agentPid: number | null;
  attachChildAlive: boolean | null;
  /** True while startup/restart recovery is actively repairing this session. */
  recoveryInProgress?: boolean;
  attachGeneration: number;
  reattachCount: number;
  ringHead: number;
  lastByteAt: number | null;
  lastAttachAt: number | null;
}

/**
 * Narrow, server-only capability for reading raw per-session transport
 * diagnostics. Concrete backends (e.g. `LocalDtachBackend`) implement this
 * alongside {@link TerminalBackend}; the generic port does not carry it, so
 * only code that explicitly asks for this source can reach adapter internals.
 */
export interface TerminalSessionDiagnosticsSource {
  /** Optional per-session transport diagnostics for cross-signal health. */
  getSessionDiagnostics(id: SessionId): TerminalSessionDiagnostics | null;
}
