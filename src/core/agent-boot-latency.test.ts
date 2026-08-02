import { describe, it, expect } from 'vitest';
import {
  AgentBootLatencyMonitor,
  extractAgentBootSample,
  type AgentBootLatencyConfig,
} from './agent-boot-latency.js';
import type { LaunchPhaseTimings } from './launch-phase-timings.js';

const ALL_AGENTS = ['claude-code', 'codex-cli', 'grok-build'] as const;

/** A launch whose `agent-boot` phase completed in `bootMs`. */
function healthyBoot(bootMs: number): LaunchPhaseTimings {
  return {
    phases: [
      { phase: 'session-create', durationMs: 50, completed: true },
      { phase: 'agent-boot', durationMs: bootMs, completed: true },
      { phase: 'ack', durationMs: 10, completed: true },
    ],
    totalMs: bootMs + 60,
  };
}

/** A launch abandoned WHILE in `agent-boot` (the #1642 >90s hang shape). */
function hungBoot(bootMs = 90_000): LaunchPhaseTimings {
  return {
    phases: [
      { phase: 'session-create', durationMs: 50, completed: true },
      { phase: 'agent-boot', durationMs: bootMs, completed: false },
    ],
    totalMs: bootMs + 50,
    incompletePhase: 'agent-boot',
  };
}

/** A launch that never reached `agent-boot` (hung earlier). */
function preBootFailure(): LaunchPhaseTimings {
  return {
    phases: [{ phase: 'session-create', durationMs: 1_000, completed: false }],
    totalMs: 1_000,
    incompletePhase: 'session-create',
  };
}

function monitor(overrides: AgentBootLatencyConfig = {}): AgentBootLatencyMonitor {
  // Default the clock to a fixed time so staleness is deterministic; callers
  // that exercise staleness inject their own advancing `now`.
  return new AgentBootLatencyMonitor({ now: () => 1_000, ...overrides });
}

describe('extractAgentBootSample', () => {
  it('reads the agent-boot duration and completed flag', () => {
    expect(extractAgentBootSample(healthyBoot(3_000), 42)).toEqual({
      bootMs: 3_000,
      bootHung: false,
      atMs: 42,
    });
  });

  it('flags a launch abandoned in agent-boot as hung', () => {
    expect(extractAgentBootSample(hungBoot(90_000), 7)).toEqual({
      bootMs: 90_000,
      bootHung: true,
      atMs: 7,
    });
  });

  it('returns null when the launch never reached agent-boot', () => {
    // A pre-agent-boot failure is a launch failure but not boot-latency
    // evidence — it must not skew the boot-reliability signal.
    expect(extractAgentBootSample(preBootFailure(), 1)).toBeNull();
  });
});

describe('AgentBootLatencyMonitor', () => {
  it('does not flag an agent with no samples', () => {
    const m = monitor();
    expect(m.isUnhealthy('grok-build')).toBe(false);
    expect(m.deprioritizedTypes(ALL_AGENTS)).toEqual([]);
  });

  it('flags an agent unhealthy after enough recent slow boots', () => {
    const m = monitor({ minSlowSamples: 2 });
    m.record('grok-build', hungBoot());
    // One slow sample is not yet unhealthy — a single transient stall must not
    // deprioritize.
    expect(m.isUnhealthy('grok-build')).toBe(false);
    m.record('grok-build', hungBoot());
    expect(m.isUnhealthy('grok-build')).toBe(true);
    expect(m.deprioritizedTypes(ALL_AGENTS)).toEqual(['grok-build']);
  });

  it('treats a slow-but-completed boot as slow (not only hangs)', () => {
    const m = monitor({ minSlowSamples: 2, slowBootMs: 20_000 });
    m.record('grok-build', healthyBoot(25_000));
    m.record('grok-build', healthyBoot(30_000));
    expect(m.isUnhealthy('grok-build')).toBe(true);
  });

  it('does not flag an agent whose boots are fast', () => {
    const m = monitor({ minSlowSamples: 2, slowBootMs: 20_000 });
    m.record('grok-build', healthyBoot(2_000));
    m.record('grok-build', healthyBoot(3_000));
    m.record('grok-build', healthyBoot(1_500));
    expect(m.isUnhealthy('grok-build')).toBe(false);
    expect(m.deprioritizedTypes(ALL_AGENTS)).toEqual([]);
  });

  it('keeps agent types independent', () => {
    const m = monitor({ minSlowSamples: 2 });
    m.record('grok-build', hungBoot());
    m.record('grok-build', hungBoot());
    m.record('claude-code', healthyBoot(1_000));
    expect(m.deprioritizedTypes(ALL_AGENTS)).toEqual(['grok-build']);
  });

  it('ignores launches that produced no agent-boot sample', () => {
    const m = monitor({ minSlowSamples: 1 });
    m.record('grok-build', preBootFailure());
    m.record('grok-build', preBootFailure());
    expect(m.isUnhealthy('grok-build')).toBe(false);
  });

  it('self-heals once fresh healthy boots push slow samples out of the window', () => {
    const m = monitor({ minSlowSamples: 2, windowSize: 3 });
    m.record('grok-build', hungBoot());
    m.record('grok-build', hungBoot());
    expect(m.isUnhealthy('grok-build')).toBe(true);
    // Three fresh healthy boots evict both hangs from the 3-sample window.
    m.record('grok-build', healthyBoot(1_000));
    m.record('grok-build', healthyBoot(1_000));
    m.record('grok-build', healthyBoot(1_000));
    expect(m.isUnhealthy('grok-build')).toBe(false);
  });

  it('self-heals when slow samples age past the staleness window', () => {
    let clock = 1_000;
    const m = new AgentBootLatencyMonitor({ minSlowSamples: 2, staleMs: 10_000, now: () => clock });
    m.record('grok-build', hungBoot());
    m.record('grok-build', hungBoot());
    expect(m.isUnhealthy('grok-build')).toBe(true);
    // Advance past the staleness window with no new samples: the agent ages
    // back into the rotation to be re-probed by a real launch.
    clock += 20_000;
    expect(m.isUnhealthy('grok-build')).toBe(false);
  });

  it('exposes a diagnostic snapshot', () => {
    const m = monitor({ minSlowSamples: 2 });
    m.record('grok-build', hungBoot());
    m.record('grok-build', healthyBoot(1_000));
    expect(m.snapshot()).toEqual([
      { agentType: 'grok-build', samples: 2, slowSamples: 1, unhealthy: false },
    ]);
  });
});
