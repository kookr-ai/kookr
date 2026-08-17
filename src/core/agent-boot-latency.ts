/**
 * Boot-reliability (launch-latency) signal, derived from the per-phase launch
 * timings of issue #1589 (issue #1898, WS1.6 of the #1699 failover spine).
 *
 * ## Why
 * grok-build's registration preflight (`grok-build-preflight.ts`) verifies
 * binary identity/reachability but NOT boot reliability. The >90s launch hang
 * (#1642) was mitigated by the per-fire wall-clock cap (#1708), not by a
 * preflight — so round-robin failover could still *select* a grok-build that
 * then hangs in `agent-boot` for ~90s before the cap trips.
 *
 * This monitor closes that gap WITHOUT a new probe (which would itself be a
 * hang risk): it passively observes the `agent-boot` phase of each completed or
 * abandoned launch — the exact wall-clock #1589 already records — and exposes a
 * per-agent-type "recent boot latency is unhealthy" verdict. The rotation
 * consults that verdict as a failover precondition (see
 * {@link resolveRoundRobinAgent}) and deprioritizes an unhealthy agent while a
 * healthy alternative exists, instead of selecting it and relying on the
 * fire() cap.
 *
 * ## Self-healing
 * Samples older than {@link AgentBootLatencyConfig.staleMs} are ignored, so an
 * agent that stops being launched (because it was deprioritized) eventually
 * ages out of the unhealthy window and re-enters the rotation to be re-probed
 * by a real launch. No background timer is needed — staleness is evaluated at
 * read time against the injected clock.
 *
 * The monitor is generic across agent types; grok-build is the motivating case
 * but the mechanism is fair to any provider whose recent boots degrade.
 *
 * Slow-boot bars are per-agent. Claude/Codex healthy boots finish in well
 * under 20s. grok-build's healthy boot under load is ~25–50s (session auth
 * + first token), so a shared 20s bar permanently marks it unhealthy after
 * two routine launches. The schedule runner then substitutes every
 * grok-default fire onto claude-code (`schedule_sub`) even while grok is
 * succeeding. The grok bar sits above that healthy band and below the >90s
 * hang class (#1642).
 */
import type { AgentType } from '../shared/contracts/agent-types.js';
import type { LaunchPhaseTimings } from './launch-phase-timings.js';

/** One observed `agent-boot` outcome for an agent type. */
export interface AgentBootLatencySample {
  /**
   * Wall-clock spent in the `agent-boot` phase (ms). For a launch abandoned
   * WHILE in `agent-boot`, this is the partial time consumed up to abandonment.
   */
  bootMs: number;
  /** True when the launch was abandoned (timed out / threw) during `agent-boot`. */
  bootHung: boolean;
  /** Recording time (ms epoch) — used only for the staleness window. */
  atMs: number;
}

export interface AgentBootLatencyConfig {
  /**
   * `agent-boot` duration (ms) at or above which a completed sample counts as
   * "slow". When set, this override applies to every agent (tests). When
   * omitted, each agent uses {@link defaultSlowBootMsFor}: 20s for
   * Claude/Codex, 75s for grok-build. Hung boots (`bootHung`) always count
   * as slow regardless of this bar.
   */
  slowBootMs?: number;
  /** How many most-recent samples per agent to retain and consider. Default 5. */
  windowSize?: number;
  /**
   * Minimum slow samples within the retained window to flag the agent
   * unhealthy. Default 2 — a single transient slow boot does not deprioritize;
   * a sustained pattern does.
   */
  minSlowSamples?: number;
  /**
   * Samples older than this (ms) are ignored when evaluating health, so a
   * deprioritized agent self-heals back into the rotation. Default 600_000
   * (10 minutes).
   */
  staleMs?: number;
  /** Injected clock (ms epoch). Defaults to {@link Date.now}. */
  now?: () => number;
}

/** Diagnostic view of one agent type's boot-latency health. */
export interface AgentBootLatencyStatus {
  agentType: AgentType;
  /** Fresh (non-stale) samples currently in the window. */
  samples: number;
  /** Fresh samples that are slow (hung, or `bootMs >= slowBootMs`). */
  slowSamples: number;
  unhealthy: boolean;
}

/** Default slow-boot bar for Claude Code / Codex CLI. */
export const DEFAULT_SLOW_BOOT_MS = 20_000;

/**
 * grok-build slow-boot bar. Healthy boots under load land in the 25–50s
 * band; the >90s hang class (#1642) is the failure we still want to catch.
 * 75s sits above the observed healthy max (~50s under contention) and below
 * that hang.
 */
export const GROK_BUILD_SLOW_BOOT_MS = 75_000;

const DEFAULT_WINDOW_SIZE = 5;
const DEFAULT_MIN_SLOW_SAMPLES = 2;
const DEFAULT_STALE_MS = 10 * 60_000;

/**
 * Per-agent slow-boot bar used when {@link AgentBootLatencyConfig.slowBootMs}
 * is omitted. Exhaustive `Record<AgentType, number>` so a new agent type
 * fails the typecheck instead of silently inheriting the Claude/Codex 20s
 * bar (same #1343 lesson as `effortLevelsForAgent`).
 */
const SLOW_BOOT_MS_BY_AGENT: Record<AgentType, number> = {
  'claude-code': DEFAULT_SLOW_BOOT_MS,
  'codex-cli': DEFAULT_SLOW_BOOT_MS,
  'grok-build': GROK_BUILD_SLOW_BOOT_MS,
};

export function defaultSlowBootMsFor(agentType: AgentType): number {
  return SLOW_BOOT_MS_BY_AGENT[agentType];
}

/**
 * Extract the `agent-boot` boot-latency sample from a launch's #1589 phase
 * timings. Returns `null` when the launch never reached (or recorded) the
 * `agent-boot` phase — a launch that hung in `preflight`/`reserve`/
 * `session-create` is a launch failure, but it is NOT boot-latency evidence and
 * must not skew the boot-reliability signal.
 */
export function extractAgentBootSample(
  timings: LaunchPhaseTimings,
  atMs: number,
): AgentBootLatencySample | null {
  const entry = timings.phases.find((p) => p.phase === 'agent-boot');
  if (!entry) return null;
  return {
    bootMs: entry.durationMs,
    // `completed === false` marks the phase that was in-flight when the launch
    // was abandoned (the tracker's `abort()` flags it); that is exactly a
    // boot hang. `incompletePhase` corroborates it for defence in depth.
    bootHung: !entry.completed || timings.incompletePhase === 'agent-boot',
    atMs,
  };
}

/**
 * Rolling, in-memory boot-latency monitor. Fed one sample per finalized launch
 * (success or abandonment) from the launch service, read by the round-robin
 * resolver to deprioritize agents whose recent boots are unhealthy.
 *
 * In-memory and per-process by design: the signal describes the *current*
 * runtime's recent launch behaviour and re-warms naturally after a restart, so
 * no persistence is warranted.
 */
export class AgentBootLatencyMonitor {
  /** Explicit override from config; `undefined` means use per-agent defaults. */
  private readonly slowBootMsOverride: number | undefined;
  private readonly windowSize: number;
  private readonly minSlowSamples: number;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly samplesByAgent = new Map<AgentType, AgentBootLatencySample[]>();

  constructor(config: AgentBootLatencyConfig = {}) {
    this.slowBootMsOverride = config.slowBootMs;
    this.windowSize = Math.max(1, config.windowSize ?? DEFAULT_WINDOW_SIZE);
    this.minSlowSamples = Math.max(1, config.minSlowSamples ?? DEFAULT_MIN_SLOW_SAMPLES);
    this.staleMs = config.staleMs ?? DEFAULT_STALE_MS;
    this.now = config.now ?? Date.now;
  }

  private slowBootMsFor(agentType: AgentType): number {
    return this.slowBootMsOverride ?? defaultSlowBootMsFor(agentType);
  }

  /**
   * Record one launch's boot latency from its #1589 phase timings. A no-op when
   * the launch produced no `agent-boot` sample (see {@link extractAgentBootSample}).
   * Never throws — instrumentation must never be able to fail a launch.
   */
  record(agentType: AgentType, timings: LaunchPhaseTimings): void {
    try {
      const sample = extractAgentBootSample(timings, this.now());
      if (!sample) return;
      const arr = this.samplesByAgent.get(agentType) ?? [];
      arr.push(sample);
      // Bounded ring: keep only the most-recent `windowSize` samples.
      if (arr.length > this.windowSize) arr.splice(0, arr.length - this.windowSize);
      this.samplesByAgent.set(agentType, arr);
    } catch {
      // Instrumentation must never be able to fail a launch: this is called
      // from the launch service's finalization paths (issue #1898). Swallow
      // any malformed-timings / clock fault rather than propagate it.
    }
  }

  /**
   * True when the agent's recent (non-stale) boot latency is unhealthy: at
   * least {@link minSlowSamples} of the retained window are slow or hung.
   */
  isUnhealthy(agentType: AgentType): boolean {
    return this.countFreshSlow(agentType).slow >= this.minSlowSamples;
  }

  /**
   * Of `candidates`, the subset whose recent boot latency is unhealthy — the
   * "deprioritize" set the round-robin resolver consults. Order follows
   * `candidates`.
   */
  deprioritizedTypes(candidates: readonly AgentType[]): AgentType[] {
    return candidates.filter((type) => this.isUnhealthy(type));
  }

  /** Diagnostic snapshot for every agent type with retained samples. */
  snapshot(): AgentBootLatencyStatus[] {
    const out: AgentBootLatencyStatus[] = [];
    for (const agentType of this.samplesByAgent.keys()) {
      const { fresh, slow } = this.countFreshSlow(agentType);
      out.push({ agentType, samples: fresh, slowSamples: slow, unhealthy: slow >= this.minSlowSamples });
    }
    return out;
  }

  private countFreshSlow(agentType: AgentType): { fresh: number; slow: number } {
    const arr = this.samplesByAgent.get(agentType);
    if (!arr || arr.length === 0) return { fresh: 0, slow: 0 };
    const cutoff = this.now() - this.staleMs;
    let fresh = 0;
    let slow = 0;
    for (const s of arr) {
      if (s.atMs < cutoff) continue;
      fresh += 1;
      if (s.bootHung || s.bootMs >= this.slowBootMsFor(agentType)) slow += 1;
    }
    return { fresh, slow };
  }
}
