/**
 * Process liveness detection for shadow stuck-detection.
 *
 * Post-ADR-014 the product backend is dtach-only. This module no longer shells
 * `tmux display-message`. Callers inject a {@link ProcessLivenessProbe} that
 * typically wraps `TerminalBackend.isAlive` (+ optional cmdline inspection).
 *
 * When no probe is configured the strategy never fires (safe no-op for tests
 * and hermetic environments).
 */

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Anomaly } from './types.js';
import type { ShadowStrategy, ShadowInputs } from './shadow-detector.js';

const execFileAsync = promisify(execFile);

// --- Process info ---

export interface ProcessInfo {
  /** Best-effort process id (dtach master / agent pid), or null when unknown. */
  panePid: number | null;
  cmdline: string | null;
  isClaude: boolean;
  isAlive: boolean;
}

/**
 * Async probe that maps a session id (legacy agentId / tmuxSession name) to
 * process liveness. Implemented at the server/adapters boundary so `core`
 * never imports TerminalBackend.
 */
export type ProcessLivenessProbe = (sessionId: string) => Promise<ProcessInfo>;

/**
 * Get the command line for a PID.
 * Linux: reads /proc/<pid>/cmdline (fast, no subprocess).
 * macOS: falls back to ps (one subprocess).
 */
export async function getProcessCmdline(pid: number): Promise<string | null> {
  // Try Linux /proc first
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
    // /proc/pid/cmdline uses null bytes as separators
    return cmdline.replace(/\0/g, ' ').trim();
  } catch {
    // Not Linux or process is gone
  }

  // Fall back to ps (macOS and other Unix)
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if a command line looks like a Claude Code process.
 * Claude Code runs as a Node.js process with 'claude' in the path or arguments.
 * @internal Exported for testing only — not part of the public API.
 */
export function isClaudeProcess(cmdline: string): boolean {
  // Match: node .../claude, npx claude, claude (direct binary)
  return /\bclaude\b/i.test(cmdline);
}

/**
 * Full process liveness check for a managed session.
 * Requires an injected probe — there is no tmux fallback.
 */
export async function checkProcessLiveness(
  sessionId: string,
  probe: ProcessLivenessProbe,
): Promise<ProcessInfo> {
  return probe(sessionId);
}

// --- Shadow strategy ---

/**
 * Shadow strategy that checks process liveness via an injected probe.
 *
 * Since probes are async (backend /proc / ps), this strategy caches the most
 * recent result and updates it asynchronously. The evaluate() method returns
 * the cached result (synchronous), while an async refresh is triggered on each
 * call.
 *
 * This is acceptable because:
 * - The watchdog ticks every 5s — one tick of staleness is fine for crash detection
 * - The strategy must not block the watchdog tick
 */
export class ProcessLivenessStrategy implements ShadowStrategy {
  readonly source = 'process_liveness' as const;
  private cachedResults = new Map<string, ProcessInfo>();
  private readonly probe: ProcessLivenessProbe | null;

  constructor(probe?: ProcessLivenessProbe | null) {
    this.probe = probe ?? null;
  }

  evaluate(agentId: string, _inputs: ShadowInputs): Anomaly | null {
    if (this.probe) {
      // Trigger async refresh (fire-and-forget)
      this.probe(agentId)
        .then((info) => this.cachedResults.set(agentId, info))
        .catch(() => { /* ignore */ });
    }

    // Use cached result from previous tick
    const info = this.cachedResults.get(agentId);
    if (!info) return null; // No data yet — first tick or no probe

    if (!info.isAlive) {
      return {
        agentId,
        type: 'stale_agent',
        severity: 'warning',
        explanation: `Agent session process is no longer running (PID ${info.panePid} not found)`,
        detectedAt: new Date(),
        confidence: 'high',
      };
    }

    if (!info.isClaude) {
      return {
        agentId,
        type: 'stale_agent',
        severity: 'info',
        explanation: `Session process is not a known agent binary: "${info.cmdline?.slice(0, 80)}"`,
        detectedAt: new Date(),
        confidence: 'medium',
      };
    }

    return null; // Agent session is alive
  }

  /** Clear cached state for an agent (when unregistered). */
  clearCache(agentId: string): void {
    this.cachedResults.delete(agentId);
  }

  /** Get cached info for testing. */
  getCachedInfo(agentId: string): ProcessInfo | undefined {
    return this.cachedResults.get(agentId);
  }
}
