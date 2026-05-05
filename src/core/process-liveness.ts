/**
 * Process liveness detection — checks if the Claude Code process is still
 * running inside a tmux pane.
 *
 * When Claude Code crashes or exits, the tmux session stays alive (showing
 * bash). This strategy detects that by checking the pane's foreground process.
 *
 * Cross-platform: uses /proc/<pid>/cmdline on Linux, ps on macOS.
 */

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Anomaly } from './types.js';
import type { ShadowStrategy, ShadowInputs } from './shadow-detector.js';

const execFileAsync = promisify(execFile);

// --- Process info ---

export interface ProcessInfo {
  panePid: number | null;
  cmdline: string | null;
  isClaude: boolean;
  isAlive: boolean;
}

/**
 * Get the PID of the foreground process in a tmux pane.
 * Returns null if the session doesn't exist or the command fails.
 */
async function getPanePid(tmuxSession: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      'display-message', '-t', tmuxSession, '-p', '#{pane_pid}',
    ], { timeout: 5_000 });
    const pid = parseInt(stdout.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Get the command line for a PID.
 * Linux: reads /proc/<pid>/cmdline (fast, no subprocess).
 * macOS: falls back to ps (one subprocess).
 */
async function getProcessCmdline(pid: number): Promise<string | null> {
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
 * Full process liveness check for a tmux session.
 */
export async function checkProcessLiveness(tmuxSession: string): Promise<ProcessInfo> {
  const panePid = await getPanePid(tmuxSession);
  if (panePid === null) {
    return { panePid: null, cmdline: null, isClaude: false, isAlive: false };
  }

  const cmdline = await getProcessCmdline(panePid);
  if (cmdline === null) {
    // PID exists in tmux but process is gone — crashed
    return { panePid, cmdline: null, isClaude: false, isAlive: false };
  }

  const isClaude = isClaudeProcess(cmdline);
  return { panePid, cmdline, isClaude, isAlive: true };
}

// --- Shadow strategy ---

/**
 * Shadow strategy that checks process liveness.
 *
 * Since checkProcessLiveness is async (subprocess calls), this strategy
 * caches the most recent result and updates it asynchronously. The evaluate()
 * method returns the cached result (synchronous), while an async refresh
 * is triggered on each call.
 *
 * This is acceptable because:
 * - The watchdog ticks every 5s — one tick of staleness is fine for crash detection
 * - The strategy must not block the watchdog tick
 */
export class ProcessLivenessStrategy implements ShadowStrategy {
  readonly source = 'process_liveness' as const;
  private cachedResults = new Map<string, ProcessInfo>();

  evaluate(agentId: string, _inputs: ShadowInputs): Anomaly | null {
    // Trigger async refresh (fire-and-forget)
    checkProcessLiveness(agentId)
      .then((info) => this.cachedResults.set(agentId, info))
      .catch(() => { /* ignore */ });

    // Use cached result from previous tick
    const info = this.cachedResults.get(agentId);
    if (!info) return null; // No data yet — first tick

    if (!info.isAlive) {
      return {
        agentId,
        type: 'stale_agent',
        severity: 'warning',
        explanation: `Claude Code process is no longer running (PID ${info.panePid} not found)`,
        detectedAt: new Date(),
        confidence: 'high',
      };
    }

    if (!info.isClaude) {
      return {
        agentId,
        type: 'stale_agent',
        severity: 'info',
        explanation: `Pane process is not Claude Code: "${info.cmdline?.slice(0, 80)}"`,
        detectedAt: new Date(),
        confidence: 'medium',
      };
    }

    return null; // Claude is alive and running
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
