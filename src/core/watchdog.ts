import type { AgentEvent, Anomaly } from './types.js';
import { analyzePaneSemantics, normalizePaneForActivity } from './pane-patterns.js';

/**
 * Configuration for the heartbeat watchdog.
 */
export interface WatchdogConfig {
  /** How often the watchdog ticks (ms). Default: 5000 (5s). */
  tickIntervalMs: number;
  /** Stale threshold when no tool in progress and pane is frozen (ms). Default: 30000 (30s). */
  staleThresholdMs: number;
  /** Unconditional stale threshold regardless of pane (ms). Default: 60000 (60s). */
  unconditionalStaleThresholdMs: number;
  /** Max tool execution time before overriding PreToolUse guard (ms). Default: 600000 (10min). */
  maxToolExecutionTimeMs: number;
  /** Grace period after agent registration before watchdog fires (ms). Default: 10000 (10s). */
  gracePeriodMs: number;
  /** How recent token activity must be to suppress stale alerts (ms). Default: 60000 (60s). */
  tokenActivityThresholdMs: number;
  /**
   * How long to suppress stuck-detection after a `mcp_startup_starting` notification (ms).
   * Default: 120000 (120s). Codex emits this hook before spinning up MCP servers, and server
   * startup commonly takes 30–60s of silence before the first real tool event arrives.
   */
  mcpStartupGracePeriodMs: number;
}

const DEFAULT_CONFIG: WatchdogConfig = {
  tickIntervalMs: 5_000,
  staleThresholdMs: 30_000,
  unconditionalStaleThresholdMs: 60_000,
  maxToolExecutionTimeMs: 600_000,
  gracePeriodMs: 10_000,
  tokenActivityThresholdMs: 60_000,
  mcpStartupGracePeriodMs: 120_000,
};

/**
 * Per-agent state tracked by the watchdog.
 */
export interface AgentWatchdogState {
  lastEventAt: number; // ms since epoch
  lastPaneHash: string; // fingerprint of pane content after stripping volatile UI chrome
  registeredAt: number; // ms since epoch — for grace period
  unmatchedToolUseIds: Set<string>; // PreToolUse ids without matching PostToolUse
  /** Fallback counter: number of tool_use events without matching tool_result (for events without toolUseId). */
  unmatchedToolCountFallback: number;
  /** Last time token consumption was detected (ms since epoch). 0 = no activity recorded. */
  lastTokenActivityAt: number;
  /**
   * Timestamp of the most recent `mcp_startup_starting` Notification (ms since epoch).
   * 0 = not currently in MCP startup. Cleared on the first subsequent tool/stop/session_end
   * event, which proxies "MCP startup is done and the agent is doing real work".
   */
  mcpStartupAt: number;
}

/**
 * Result of a single watchdog tick for one agent.
 */
export type WatchdogVerdict =
  | { status: 'healthy' }
  | { status: 'grace_period' }
  | { status: 'needs_input'; anomaly: Anomaly }
  | { status: 'permission_blocked'; anomaly: Anomaly }
  | { status: 'tool_running' }
  | { status: 'quiet_working' }
  | { status: 'mcp_starting' }
  | { status: 'stale_agent'; anomaly: Anomaly }
  | { status: 'hook_disconnected'; anomaly: Anomaly };

/**
 * Interface for pane snapshot provider (abstracted for testing).
 */
export interface PaneSnapshotProvider {
  capturePane(agentId: string): Promise<string>;
}

/**
 * Interface for hook file prober (abstracted for testing).
 * Returns new events found in the hook file since last known offset.
 */
export interface HookFileProber {
  /** Check if hook file has grown and return any new events. */
  probeHookFile(agentId: string): Promise<AgentEvent[]>;
}

/**
 * Heartbeat watchdog for stuck agent detection.
 *
 * Tracks three independent signals per agent:
 * 1. Hook events arriving (lastEventAt)
 * 2. Tool in progress (unmatched PreToolUse/PostToolUse)
 * 3. Meaningful pane output changing (lastPaneHash)
 *
 * The watchdog runs on a fixed interval and produces verdicts for each agent.
 * It does NOT own timers — the caller (server) is responsible for calling tick().
 */
export class Watchdog {
  private agents = new Map<string, AgentWatchdogState>();
  private config: WatchdogConfig;

  constructor(config?: Partial<WatchdogConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Reconfigure the watchdog with new thresholds. Uses atomic reference swap
   * so any in-progress tick sees a consistent config snapshot.
   */
  reconfigure(partial: Partial<WatchdogConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * Register an agent to be tracked. Sets initial timestamps.
   * @param lastEventAt - Override lastEventAt (e.g. from persisted session metadata on restart).
   *                      If provided, watchdog can immediately detect agents that were stale before restart.
   *                      If not provided (default), lastEventAt is set to registeredAt.
   * @param registeredAt - Override registeredAt (for testing). Defaults to Date.now().
   */
  registerAgent(agentId: string, lastEventAt?: number, registeredAt?: number): void {
    const regAt = registeredAt ?? Date.now();
    this.agents.set(agentId, {
      lastEventAt: lastEventAt ?? regAt,
      lastPaneHash: '',
      registeredAt: regAt,
      unmatchedToolUseIds: new Set(),
      unmatchedToolCountFallback: 0,
      lastTokenActivityAt: 0,
      mcpStartupAt: 0,
    });
  }

  /**
   * Unregister an agent (session completed/stopped).
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Remove all agent state. Used by test reset. */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Notify the watchdog that new events arrived for an agent.
   * Updates lastEventAt and tracks tool_use/tool_result pairing.
   */
  recordEvents(agentId: string, events: AgentEvent[], now = Date.now()): void {
    const state = this.agents.get(agentId);
    if (!state) return;

    state.lastEventAt = now;

    // MCP startup (issue #224): Codex fork emits `Notification(mcp_startup_starting)` right
    // before the MCP connection manager spawns servers. Startup commonly takes 30–60s of
    // silence before any tool event arrives, which would otherwise trip the stale_agent
    // threshold. `mcpStartupAt` is set on that notification and cleared by the first real
    // tool/stop/session_end event — all of which prove the agent has moved past startup.
    for (const event of events) {
      if (event.type === 'tool_use') {
        if (event.toolUseId) {
          state.unmatchedToolUseIds.add(event.toolUseId);
        } else {
          state.unmatchedToolCountFallback++;
        }
        state.mcpStartupAt = 0;
      } else if (event.type === 'tool_result' || event.type === 'tool_error') {
        if (event.toolUseId) {
          state.unmatchedToolUseIds.delete(event.toolUseId);
        } else if (state.unmatchedToolCountFallback > 0) {
          state.unmatchedToolCountFallback--;
        }
        state.mcpStartupAt = 0;
      } else if (event.type === 'stop' || event.type === 'session_end') {
        state.mcpStartupAt = 0;
      } else if (event.type === 'notification' && event.notificationType === 'mcp_startup_starting') {
        state.mcpStartupAt = now;
      }
    }
  }

  /**
   * Check if an agent has tools in progress (unmatched PreToolUse).
   */
  hasToolInProgress(agentId: string): boolean {
    const state = this.agents.get(agentId);
    if (!state) return false;
    return state.unmatchedToolUseIds.size > 0 || state.unmatchedToolCountFallback > 0;
  }

  /**
   * Record that an agent is actively consuming tokens (transcript growing).
   * Suppresses stale alerts for agents that are "quiet but working".
   */
  recordTokenActivity(agentId: string, now = Date.now()): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.lastTokenActivityAt = now;
  }

  /**
   * Get the watchdog state for an agent (for testing/debugging).
   */
  getState(agentId: string): AgentWatchdogState | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all tracked agent IDs.
   */
  getTrackedAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Run one watchdog tick for a single agent.
   *
   * The caller provides:
   * - currentPaneContent: result of tmux capture-pane (or empty string if unavailable)
   * - hookFileEvents: new events found by directly reading the hook file (bypassing watcher)
   * - now: current timestamp (for testing)
   *
   * Returns a verdict indicating the agent's status.
   */
  tick(
    agentId: string,
    currentPaneContent: string,
    hookFileEvents: AgentEvent[],
    now = Date.now(),
  ): WatchdogVerdict {
    const state = this.agents.get(agentId);
    if (!state) return { status: 'healthy' };

    // Process any events recovered from direct hook file read
    if (hookFileEvents.length > 0) {
      this.recordEvents(agentId, hookFileEvents, now);
      // Events recovered — agent state updated, re-check below
    }

    const timeSinceLastEvent = now - state.lastEventAt;
    const timeSinceRegistration = now - state.registeredAt;

    // Always update pane hash (even during grace period) so baseline is established.
    // Strip volatile UI rows first so elapsed-time redraws do not look like progress.
    const currentHash = simpleHash(normalizePaneForActivity(currentPaneContent));
    const paneChanged = state.lastPaneHash !== '' && currentHash !== state.lastPaneHash;
    state.lastPaneHash = currentHash;

    // Grace period: don't flag agents that were just registered
    if (timeSinceRegistration < this.config.gracePeriodMs) {
      return { status: 'grace_period' };
    }

    // MCP startup grace window: Codex emits `mcp_startup_starting` Notification before
    // spawning MCP servers, which commonly takes 30–60s of silence. Suppress stuck
    // detection within mcpStartupGracePeriodMs of that signal. The flag is cleared on
    // the first subsequent tool_use / tool_result / stop / session_end event.
    if (state.mcpStartupAt > 0 && (now - state.mcpStartupAt) < this.config.mcpStartupGracePeriodMs) {
      return { status: 'mcp_starting' };
    }

    const paneSemantics = analyzePaneSemantics(currentPaneContent);

    // Permission dialog: always actionable — check before staleness.
    if (paneSemantics.confidence === 'high' && paneSemantics.state === 'permission_dialog') {
      return {
        status: 'permission_blocked',
        anomaly: {
          agentId,
          type: 'permission_blocked',
          severity: 'warning',
          explanation: `Pane shows permission dialog: "${paneSemantics.matchedText ?? 'approval prompt'}"`,
          detectedAt: new Date(now),
        },
      };
    }

    const toolInProgress = this.hasToolInProgress(agentId);

    // Recent events — agent is healthy.
    // NOTE: input_prompt pane check is deferred to AFTER this gate. Claude Code
    // briefly shows the ❯ prompt between tool calls while the LLM thinks about
    // the next step. Firing needs_input here creates transient false positives
    // that flash in the UI for seconds before the next hook event clears them.
    // Permission dialog is exempt because it always requires user action.
    if (timeSinceLastEvent < this.config.staleThresholdMs) {
      return { status: 'healthy' };
    }

    // Tool in progress: suppress stale_agent unless tool has been running too long
    if (toolInProgress) {
      if (timeSinceLastEvent >= this.config.maxToolExecutionTimeMs) {
        // Tool has been running far too long — override the guard
        return {
          status: 'stale_agent',
          anomaly: {
            agentId,
            type: 'stale_agent',
            severity: 'warning',
            explanation: `Tool running for ${Math.round(timeSinceLastEvent / 1000)}s with no response — may be hung`,
            detectedAt: new Date(now),
          },
        };
      }
      return { status: 'tool_running' };
    }

    // Pane shows input prompt AND agent is stale — genuinely waiting for input.
    if (paneSemantics.confidence === 'high' && paneSemantics.state === 'input_prompt') {
      return {
        status: 'needs_input',
        anomaly: {
          agentId,
          type: 'needs_input',
          severity: 'info',
          explanation: `Pane shows input prompt: "${paneSemantics.matchedText ?? 'input prompt'}"`,
          detectedAt: new Date(now),
          subType: 'stop',
        },
      };
    }

    // No tool in progress, events stale past threshold
    if (paneChanged) {
      // Pane is changing but no events — hook pipeline is broken, not the agent
      if (timeSinceLastEvent >= this.config.unconditionalStaleThresholdMs) {
        return {
          status: 'hook_disconnected',
          anomaly: {
            agentId,
            type: 'hook_disconnected',
            severity: 'warning',
            explanation: `No hook events for ${Math.round(timeSinceLastEvent / 1000)}s but agent is visibly active — hook pipeline may be broken`,
            detectedAt: new Date(now),
          },
        };
      }
      // Under unconditional threshold, pane changing — likely healthy but hook lagging
      return { status: 'healthy' };
    }

    // Token activity check: agent is quiet but actively consuming tokens (thinking, reading)
    const timeSinceTokenActivity = state.lastTokenActivityAt > 0
      ? now - state.lastTokenActivityAt
      : Infinity;
    if (timeSinceTokenActivity < this.config.tokenActivityThresholdMs) {
      return { status: 'quiet_working' };
    }

    // Pane frozen + no events + no tool in progress + no token activity = stuck
    return {
      status: 'stale_agent',
      anomaly: {
        agentId,
        type: 'stale_agent',
        severity: 'warning',
        explanation: `No activity for ${Math.round(timeSinceLastEvent / 1000)}s — agent may be stuck or disconnected`,
        detectedAt: new Date(now),
      },
    };
  }
}

/**
 * Simple non-cryptographic hash for pane content comparison.
 * Not for security — just fast string fingerprinting.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
