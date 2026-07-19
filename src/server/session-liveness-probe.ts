// --- Session liveness probe for shadow process_liveness (#1462) ---
//
// Bridges TerminalBackend (dtach) into core's ProcessLivenessProbe without
// letting core import adapters. Uses backend.isAlive + optional diagnostics
// for pid/cmdline when available.

import type { TerminalBackend } from '../adapters/terminal-backend.js';
import {
  getProcessCmdline,
  isClaudeProcess,
  type ProcessInfo,
  type ProcessLivenessProbe,
} from '../core/process-liveness.js';

/**
 * Build a {@link ProcessLivenessProbe} from the live terminal backend.
 *
 * - Dead / unknown sessions → `isAlive: false`
 * - Live sessions → best-effort pid + cmdline; when cmdline is unavailable but
 *   the backend reports alive, treat as a live agent session (`isClaude: true`)
 *   because dtach sessions are only created for managed agents.
 */
export function createSessionLivenessProbe(backend: TerminalBackend): ProcessLivenessProbe {
  return async (sessionId: string): Promise<ProcessInfo> => {
    const alive = await backend.isAlive(sessionId);
    if (!alive) {
      return { panePid: null, cmdline: null, isClaude: false, isAlive: false };
    }

    const diag = backend.getSessionDiagnostics?.(sessionId) ?? null;
    const pid = diag?.agentPid ?? diag?.masterPid ?? null;
    let cmdline: string | null = null;
    if (pid != null && pid > 0) {
      cmdline = await getProcessCmdline(pid);
    }

    if (cmdline == null) {
      // Backend says the session is alive (socket + master identity). Without a
      // cmdline we cannot disprove the agent binary, so treat as live agent.
      return { panePid: pid, cmdline: null, isClaude: true, isAlive: true };
    }

    return {
      panePid: pid,
      cmdline,
      isClaude: isClaudeProcess(cmdline),
      isAlive: true,
    };
  };
}
