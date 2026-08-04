import { describe, test, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Watchdog, type WatchdogConfig } from './watchdog.js';
import { ToolLatencyMetrics } from './tool-latency-metrics.js';
import { parseHookEvent } from './hook-parser.js';
import type { AgentEvent } from './types.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

function makeToolUse(sessionId: string, toolName: string, toolUseId: string): AgentEvent {
  return { type: 'tool_use', sessionId, toolName, toolUseId };
}

function makeToolResult(sessionId: string, toolName: string, toolUseId: string): AgentEvent {
  return { type: 'tool_result', sessionId, toolName, toolUseId };
}

function makeToolError(sessionId: string, toolName: string, toolUseId: string, error = 'tool failed'): AgentEvent {
  return { type: 'tool_error', sessionId, toolName, toolUseId, error, isInterrupt: false };
}

function makeStop(sessionId: string, lastMessage = ''): AgentEvent {
  return { type: 'stop', sessionId, lastMessage };
}

function makePermissionRequest(sessionId: string, toolName: string): AgentEvent {
  return { type: 'permission_request', sessionId, toolName };
}

function makeSessionStart(sessionId: string): AgentEvent {
  return { type: 'session_start', sessionId, transcriptPath: '/tmp/test.jsonl' };
}

// Fast config for testing: 10s stale, 30s unconditional, 100s max tool, 10s grace, 30s token activity
const FAST_CONFIG: Partial<WatchdogConfig> = {
  tickIntervalMs: 5_000,
  staleThresholdMs: 10_000,
  unconditionalStaleThresholdMs: 30_000,
  maxToolExecutionTimeMs: 100_000,
  gracePeriodMs: 10_000,
  tokenActivityThresholdMs: 30_000,
};

describe('Watchdog', () => {
  let watchdog: Watchdog;
  const agentId = 'kookr-test';

  beforeEach(() => {
    watchdog = new Watchdog(FAST_CONFIG);
  });

  describe('registration', () => {
    test('tracks registered agents', () => {
      watchdog.registerAgent(agentId, 1000, 1000);
      expect(watchdog.getTrackedAgents()).toContain(agentId);
    });

    test('unregistered agent returns healthy (no-op)', () => {
      const verdict = watchdog.tick('unknown', 'pane output', [], 1000);
      expect(verdict.status).toBe('healthy');
    });

    test('unregister removes agent', () => {
      watchdog.registerAgent(agentId, 1000, 1000);
      watchdog.unregisterAgent(agentId);
      expect(watchdog.getTrackedAgents()).not.toContain(agentId);
    });
  });

  describe('grace period', () => {
    // T2.7: Agent just launched — grace period
    test('returns grace_period for newly registered agent', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      // No events, no pane change, 5s after registration (within grace period)
      const verdict = watchdog.tick(agentId, 'pane', [], t0 + 5_000);
      expect(verdict.status).toBe('grace_period');
    });

    test('grace period ends after configured time', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      // First tick establishes pane hash
      watchdog.tick(agentId, 'pane', [], t0 + 5_000);
      // After grace period + stale threshold: no events, frozen pane
      const verdict = watchdog.tick(agentId, 'pane', [], t0 + 21_000);
      expect(verdict.status).toBe('stale_agent');
    });
  });

  describe('Category 1: True Positives — agent IS stuck', () => {
    // T1.5: Stale agent — no events, pane frozen, no tool in progress
    test('T1.5: stale_agent when no events, pane frozen, no tool in progress', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Read', 't1'), makeToolResult('s1', 'Read', 't1')], t0);

      // Establish initial pane hash
      watchdog.tick(agentId, 'some pane output', [], t0 + 5_000);

      // 11s later, same pane, no events → stale
      const verdict = watchdog.tick(agentId, 'some pane output', [], t0 + 11_000);
      expect(verdict.status).toBe('stale_agent');
      // Status already asserted — access anomaly directly (TypeScript narrowing via assertion)
      const anomaly = (verdict as { status: 'stale_agent'; anomaly: { type: string; severity: string } }).anomaly;
      expect(anomaly.type).toBe('stale_agent');
      expect(anomaly.severity).toBe('warning');
    });

    // T1.6: LLM API stall — PostToolUse last event, no new events, pane frozen
    test('T1.6: stale_agent on LLM API stall (post-tool, no streaming)', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Read', 't1'),
        makeToolResult('s1', 'Read', 't1'),
      ], t0);

      watchdog.tick(agentId, 'frozen pane', [], t0 + 5_000);
      const verdict = watchdog.tick(agentId, 'frozen pane', [], t0 + 11_000);
      expect(verdict.status).toBe('stale_agent');
    });

    // T1.7: 30s unconditional timeout — pane IS changing but no events
    test('T1.7: hook_disconnected when pane changing but no events for 30s', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);

      // Establish pane hash (during grace period — hash is still updated)
      watchdog.tick(agentId, 'pane v1', [], t0 + 5_000);

      // Pane changes, but no events for 31s (past grace period + unconditional threshold)
      const verdict = watchdog.tick(agentId, 'pane v2 different', [], t0 + 31_000);
      expect(verdict.status).toBe('hook_disconnected');
      if (verdict.status === 'hook_disconnected') {
        expect(verdict.anomaly.type).toBe('hook_disconnected');
      }
    });
  });

  describe('Category 2: True Negatives — agent is NOT stuck', () => {
    // T2.1: CRITICAL — sleep 60, frozen pane, no events, but PreToolUse unmatched
    test('T2.1: NO anomaly during sleep 60 (PreToolUse guard)', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Bash', 't1'), // sleep 60 starts
      ], t0);

      // Establish pane hash
      watchdog.tick(agentId, 'frozen pane', [], t0 + 5_000);

      // 30s later, still no PostToolUse, pane frozen → tool_running (not stale)
      const verdict = watchdog.tick(agentId, 'frozen pane', [], t0 + 30_000);
      expect(verdict.status).toBe('tool_running');
    });

    // T2.2: Long Bash with output (npm test)
    test('T2.2: NO anomaly during npm test with output', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'pane v1', [], t0 + 5_000);
      // 60s later, pane changed (test output), still no PostToolUse
      const verdict = watchdog.tick(agentId, 'pane v2 test output', [], t0 + 60_000);
      expect(verdict.status).toBe('tool_running');
    });

    // T2.4: LLM thinking time — normal inference delay (under threshold)
    test('T2.4: NO anomaly for brief thinking time (under 10s)', () => {
      const t0 = 0; // Start early so we're past grace period
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Read', 't1'),
        makeToolResult('s1', 'Read', 't1'),
      ], t0 + 11_000); // Events at 11s (past grace period)

      watchdog.tick(agentId, 'pane', [], t0 + 12_000);
      // 8s since events — under stale threshold
      const verdict = watchdog.tick(agentId, 'pane changed (streaming)', [], t0 + 19_000);
      expect(verdict.status).toBe('healthy');
    });

    // T2.5: LLM thinking — slow but actively streaming (pane changing)
    test('T2.5: NO stale_agent when pane is changing (LLM streaming)', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Read', 't1'),
        makeToolResult('s1', 'Read', 't1'),
      ], t0 + 11_000);

      watchdog.tick(agentId, 'pane v1', [], t0 + 12_000);
      // 15s since events, pane changed — LLM is streaming, under unconditional threshold
      const verdict = watchdog.tick(agentId, 'pane v2 LLM streaming...', [], t0 + 26_000);
      expect(verdict.status).toBe('healthy');
    });

    // T2.6: Rapid tool calls
    test('T2.6: NO anomaly during rapid tool calls', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      for (let i = 0; i < 20; i++) {
        watchdog.recordEvents(agentId, [
          makeToolUse('s1', 'Read', `t${i}`),
          makeToolResult('s1', 'Read', `t${i}`),
        ], t0 + 11_000 + i * 100);
      }
      // Latest event at t0 + 12900ms
      watchdog.tick(agentId, 'pane', [], t0 + 13_000);
      const verdict = watchdog.tick(agentId, 'pane', [], t0 + 14_000);
      expect(verdict.status).toBe('healthy');
    });

    // T2.8: Brief silence between tool calls
    test('T2.8: NO anomaly for brief silence between tools (3s)', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Read', 't1'),
        makeToolResult('s1', 'Read', 't1'),
      ], t0 + 11_000);

      watchdog.tick(agentId, 'frozen', [], t0 + 12_000);
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 14_000);
      expect(verdict.status).toBe('healthy');
    });

    // T2.9: Agent running a 2-minute build
    test('T2.9: NO stale_agent during 2-minute build (PreToolUse guard)', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);
      // 90s into build, still frozen
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 90_000);
      expect(verdict.status).toBe('tool_running');
    });

    test('does not detect Codex idle prompt as needs_input when events are recent', () => {
      // FAST_CONFIG uses staleThresholdMs: 10_000
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      // Record event at t0+5000 so it's recent relative to the tick
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0 + 5_000);

      watchdog.tick(agentId, '› ', [], t0 + 5_000);
      const verdict = watchdog.tick(
        agentId,
        '› \n\n  gpt-5.4 fast · 100% left · /tmp/project',
        [],
        t0 + 11_000, // 6s since last event < 10s stale threshold → healthy
      );
      // Pane-based input_prompt is deferred past staleness to prevent transient
      // false positives when the prompt is briefly visible between tool calls.
      expect(verdict.status).toBe('healthy');
    });

    test('detects Codex idle prompt as needs_input when agent is stale', () => {
      // FAST_CONFIG uses staleThresholdMs: 10_000
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);

      watchdog.tick(agentId, '› ', [], t0 + 5_000);
      const verdict = watchdog.tick(
        agentId,
        '› \n\n  gpt-5.4 fast · 100% left · /tmp/project',
        [],
        t0 + 11_000, // 11s > 10s stale threshold → needs_input
      );
      expect(verdict.status).toBe('needs_input');
      if (verdict.status === 'needs_input') {
        expect(verdict.anomaly.type).toBe('needs_input');
        expect(verdict.anomaly.subType).toBe('stop');
      }
    });

    test('does not misclassify Codex running status as needs_input', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);

      watchdog.tick(agentId, '• Working (0s • esc to interrupt)\n\n› Ask Codex to do anything', [], t0 + 5_000);
      const verdict = watchdog.tick(
        agentId,
        '• Investigating rendering code (0s • esc to interrupt)\n\n› Summarize recent commits\n\n  tab to queue message                                       100% context left',
        [],
        t0 + 11_000,
      );
      expect(verdict.status).toBe('healthy');
    });

    test('detects Codex approval dialog as permission_blocked', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);

      watchdog.tick(agentId, 'Would you like to run the following command?', [], t0 + 5_000);
      const verdict = watchdog.tick(
        agentId,
        'Would you like to run the following command?\n\n$ echo hello world\n\n› 1. Yes, proceed (y)\n  Press enter to confirm or esc to cancel',
        [],
        t0 + 11_000,
      );
      expect(verdict.status).toBe('permission_blocked');
      if (verdict.status === 'permission_blocked') {
        expect(verdict.anomaly.type).toBe('permission_blocked');
      }
    });

    test('structured PermissionRequest overrides low-confidence pane and recent activity', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);
      watchdog.tick(agentId, 'ordinary pane output', [], t0 + 5_000);

      watchdog.recordEvents(agentId, [makePermissionRequest('s1', 'Bash')], t0 + 12_000);
      const verdict = watchdog.tick(
        agentId,
        'ordinary pane output without a recognized permission dialog',
        [],
        t0 + 13_000,
      );

      expect(verdict.status).toBe('permission_blocked');
      if (verdict.status === 'permission_blocked') {
        expect(verdict.anomaly.type).toBe('permission_blocked');
        expect(verdict.anomaly.explanation).toContain('Bash');
        expect(verdict.anomaly.detectedAt).toEqual(new Date(t0 + 12_000));
      }
    });

    test('clears structured pending permission after the request advances', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);
      watchdog.recordEvents(agentId, [makePermissionRequest('s1', 'Bash')], t0 + 12_000);
      expect(watchdog.tick(agentId, 'low-confidence pane', [], t0 + 13_000).status).toBe('permission_blocked');

      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], t0 + 14_000);
      const verdict = watchdog.tick(agentId, 'low-confidence pane', [], t0 + 15_000);

      expect(verdict.status).toBe('healthy');
    });

    test('clears structured pending permission when explicit input is sent', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);
      watchdog.recordEvents(agentId, [makePermissionRequest('s1', 'Bash')], t0 + 12_000);
      expect(watchdog.tick(agentId, 'low-confidence pane', [], t0 + 13_000).status).toBe('permission_blocked');

      watchdog.recordInputReceived(agentId, t0 + 14_000);
      const verdict = watchdog.tick(agentId, 'low-confidence pane', [], t0 + 15_000);

      expect(verdict.status).toBe('healthy');
    });
  });

  describe('T2.10 CRITICAL: blocked events + tool finishes + agent stuck', () => {
    test('direct hook file read recovers missed PostToolUse + Stop', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      // PreToolUse delivered normally
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // 11s later: events blocked, but hook file probe finds PostToolUse + Stop
      const recoveredEvents: AgentEvent[] = [
        makeToolResult('s1', 'Bash', 't1'),
        makeStop('s1', 'Done'),
      ];
      const verdict = watchdog.tick(agentId, 'frozen', recoveredEvents, t0 + 11_000);

      // Events are processed: tool is now matched, stop recorded
      // But the question is: does the watchdog itself detect this as stale?
      // After processing recovered events, lastEventAt is updated to t0+11000
      // So timeSinceLastEvent = 0 → healthy!
      // The actual stale_agent/needs_input detection happens in the Monitor via processEvents
      expect(verdict.status).toBe('healthy');
      // The recovered events should have been recorded
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });

    test('without hook file probe, PreToolUse guard hides stuck agent', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // 11s later: NO recovered events (probe returns empty)
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 11_000);

      // PreToolUse guard active — reports tool_running, not stale
      expect(verdict.status).toBe('tool_running');
    });
  });

  describe('T2.11: sleep 60 with blocked events, tool genuinely running', () => {
    test('no anomaly when hook file confirms tool still running', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // 30s later: hook file probe finds nothing new (tool genuinely still running)
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 30_000);
      expect(verdict.status).toBe('tool_running');
    });
  });

  describe('PreToolUse/PostToolUse pairing', () => {
    // T8.1: Basic pairing
    test('T8.1: single tool paired correctly', () => {
      watchdog.registerAgent(agentId, 0, 0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], 0);
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], 100);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });

    // T8.2: Overlapping tools
    test('T8.2: overlapping tools tracked independently', () => {
      watchdog.registerAgent(agentId, 0, 0);
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Bash', 't1'),
        makeToolUse('s1', 'Read', 't2'),
      ], 0);
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      // Read finishes, Bash still running
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't2')], 100);
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      // Bash finishes — now no tools in progress
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], 200);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });

    // T8.3: PostToolUse without PreToolUse (orphaned)
    test('T8.3: orphaned PostToolUse does not crash or create false in-progress', () => {
      watchdog.registerAgent(agentId, 0, 0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], 0);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
      expect(watchdog.getToolLatencyMetrics().snapshot().toolCount).toBe(0);
    });

    test('PostToolUseFailure clears matched tool_use by toolUseId', () => {
      watchdog.registerAgent(agentId, 0, 0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], 0);
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      watchdog.recordEvents(agentId, [makeToolError('s1', 'Bash', 't1')], 100);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });

    test('records PreToolUse→PostToolUse duration into the per-tool latency histogram', () => {
      const metrics = new ToolLatencyMetrics();
      const wd = new Watchdog(FAST_CONFIG, { toolLatencyMetrics: metrics });
      wd.registerAgent(agentId, 1_000, 1_000);

      wd.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], 1_000);
      wd.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], 1_030);
      wd.recordEvents(agentId, [makeToolUse('s1', 'Read', 't2')], 1_040);
      wd.recordEvents(agentId, [makeToolResult('s1', 'Read', 't2')], 1_050);
      wd.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't3')], 1_060);
      wd.recordEvents(agentId, [makeToolError('s1', 'Bash', 't3', 'exit 1')], 1_080);

      expect(metrics.snapshot()).toEqual({
        schemaVersion: 'tool-latency-metrics.v1',
        maxTools: 64,
        maxSamplesPerTool: 256,
        toolCount: 2,
        droppedToolCount: 0,
        tools: [
          {
            toolName: 'Bash',
            count: 2,
            sampleCount: 2,
            p50Ms: 20,
            p95Ms: 30,
            p99Ms: 30,
          },
          {
            toolName: 'Read',
            count: 1,
            sampleCount: 1,
            p50Ms: 10,
            p95Ms: 10,
            p99Ms: 10,
          },
        ],
      });
    });

    test('prefers PreToolUse tool name when PostToolUse name is unknown', () => {
      const metrics = new ToolLatencyMetrics();
      const wd = new Watchdog(FAST_CONFIG, { toolLatencyMetrics: metrics });
      wd.registerAgent(agentId, 0, 0);

      wd.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], 0);
      wd.recordEvents(agentId, [makeToolResult('s1', 'unknown', 't1')], 500);

      expect(metrics.snapshot().tools).toEqual([expect.objectContaining({
        toolName: 'Bash',
        count: 1,
        p50Ms: 500,
      })]);
    });

    // T8.4: PreToolUse without PostToolUse, but new tool starts
    test('T8.4: stale PreToolUse persists even when new tool starts', () => {
      watchdog.registerAgent(agentId, 0, 0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], 0);
      // New tool starts without t1 finishing
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Read', 't2')], 100);
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);
      // t2 finishes
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't2')], 200);
      // t1 still unmatched — tool still in progress
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      // Only after t1 finishes should hasToolInProgress be false
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], 300);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });

    // T8.5: maxToolExecutionTime override
    test('T8.5: very old unmatched PreToolUse overridden by maxToolExecutionTime', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);
      // Way past maxToolExecutionTime (100s in test config)
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 101_000);
      expect(verdict.status).toBe('stale_agent');
      if (verdict.status === 'stale_agent') {
        // Should indicate a long-running tool execution (humanized: 101s → "1 min")
        expect(verdict.anomaly.explanation).toMatch(/\d+ min/);
      }
    });

    // T8.7: Events without toolUseId — fallback tracking
    test('T8.7: tool_use without toolUseId still tracked as in-progress', () => {
      watchdog.registerAgent(agentId, 0, 0);
      const toolUseNoId: AgentEvent = { type: 'tool_use', sessionId: 's1', toolName: 'Read' };
      const toolResultNoId: AgentEvent = { type: 'tool_result', sessionId: 's1', toolName: 'Read' };

      watchdog.recordEvents(agentId, [toolUseNoId], 0);
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      watchdog.recordEvents(agentId, [toolResultNoId], 100);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });

    test('PostToolUseFailure without toolUseId clears fallback in-progress tracking', () => {
      watchdog.registerAgent(agentId, 0, 0);
      const toolUseNoId: AgentEvent = { type: 'tool_use', sessionId: 's1', toolName: 'Read' };
      const toolErrorNoId: AgentEvent = {
        type: 'tool_error',
        sessionId: 's1',
        toolName: 'Read',
        error: 'read failed',
        isInterrupt: false,
      };

      watchdog.recordEvents(agentId, [toolUseNoId], 0);
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      watchdog.recordEvents(agentId, [toolErrorNoId], 100);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });

    // Orphaned tool_result without prior tool_use doesn't break state
    test('orphaned tool_result without toolUseId does not create false in-progress', () => {
      watchdog.registerAgent(agentId, 0, 0);
      const toolResultNoId: AgentEvent = { type: 'tool_result', sessionId: 's1', toolName: 'Read' };
      watchdog.recordEvents(agentId, [toolResultNoId], 0);
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });
  });

  describe('pane snapshot edge cases', () => {
    // T7.1: Truly frozen pane
    test('frozen pane detected across multiple ticks', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'same content', [], t0 + 5_000);
      watchdog.tick(agentId, 'same content', [], t0 + 8_000);
      const verdict = watchdog.tick(agentId, 'same content', [], t0 + 11_000);
      expect(verdict.status).toBe('stale_agent');
    });

    // First tick can't detect pane change (no baseline)
    test('first tick establishes baseline, does not false-positive', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      // First tick: pane hash is '' → current hash is set but no "change" detected
      // This is within grace period anyway
      const verdict = watchdog.tick(agentId, 'any content', [], t0 + 5_000);
      expect(verdict.status).toBe('grace_period');
    });
  });

  describe('multiple agents', () => {
    // T9.1: One stuck, others healthy
    test('T9.1: anomalies are per-agent, no cross-contamination', () => {
      const t0 = 1000;
      watchdog.registerAgent('agent-a', t0, t0);
      watchdog.registerAgent('agent-b', t0, t0);
      watchdog.registerAgent('agent-c', t0, t0);

      // Agent A: events received, then goes silent
      watchdog.recordEvents('agent-a', [makeToolResult('s1', 'Read', 't1')], t0);
      // Agent B: events keep coming
      watchdog.recordEvents('agent-b', [makeToolResult('s1', 'Read', 't2')], t0 + 15_000);
      // Agent C: tool in progress
      watchdog.recordEvents('agent-c', [makeToolUse('s1', 'Bash', 't3')], t0);

      // Establish pane baselines
      watchdog.tick('agent-a', 'pane-a', [], t0 + 5_000);
      watchdog.tick('agent-b', 'pane-b', [], t0 + 5_000);
      watchdog.tick('agent-c', 'pane-c', [], t0 + 5_000);

      const now = t0 + 16_000;
      const vA = watchdog.tick('agent-a', 'pane-a', [], now); // stale: 16s, frozen
      const vB = watchdog.tick('agent-b', 'pane-b', [], now); // healthy: event at t0+15s
      const vC = watchdog.tick('agent-c', 'pane-c', [], now); // tool_running

      expect(vA.status).toBe('stale_agent');
      expect(vB.status).toBe('healthy');
      expect(vC.status).toBe('tool_running');
    });
  });

  describe('timing boundaries', () => {
    // T3.1: Event at exactly threshold
    test('T3.1: event at exactly 10s boundary — healthy', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'pane', [], t0 + 5_000);

      // Record event at exactly the 10s mark
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Read', 't2')], t0 + 10_000);
      const verdict = watchdog.tick(agentId, 'pane', [], t0 + 10_000);
      expect(verdict.status).toBe('healthy');
    });

    // T3.2: Event arrives 1ms after detection
    test('T3.2: stale_agent fires then clears on next tick', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);
      const v1 = watchdog.tick(agentId, 'frozen', [], t0 + 11_000);
      expect(v1.status).toBe('stale_agent');

      // Event arrives
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Read', 't2')], t0 + 11_001);
      const v2 = watchdog.tick(agentId, 'frozen', [], t0 + 12_000);
      expect(v2.status).toBe('healthy');
    });
  });

  describe('freeze/resume simulation', () => {
    // T12.1: Short freeze (30s)
    test('T12.1: detects stale agent after 30s freeze', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'pane', [], t0 + 5_000);

      // Simulate freeze: no ticks for 30s, then resume
      const verdict = watchdog.tick(agentId, 'pane', [], t0 + 35_000);
      expect(verdict.status).toBe('stale_agent');
    });

    // T12.2: Long freeze with tool in progress
    test('T12.2: tool guard still active after 10min freeze if under maxToolExecutionTime', () => {
      const t0 = 1000;
      // Use a longer maxToolExecutionTime for this test
      const longToolWatchdog = new Watchdog({
        ...FAST_CONFIG,
        maxToolExecutionTimeMs: 700_000,
      });
      longToolWatchdog.registerAgent(agentId, t0, t0);
      longToolWatchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      longToolWatchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // 10 minutes freeze — tool still under maxToolExecutionTime
      const verdict = longToolWatchdog.tick(agentId, 'frozen', [], t0 + 600_000);
      expect(verdict.status).toBe('tool_running');
    });

    // T12.4: Events written to hook file during freeze
    test('T12.4: recovers events from hook file after freeze', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // Freeze for 30s. During freeze, tool finished and stop event was written.
      // On resume, hook file probe returns accumulated events.
      const recoveredEvents: AgentEvent[] = [
        makeToolResult('s1', 'Bash', 't1'),
        makeStop('s1', 'Done'),
      ];
      const verdict = watchdog.tick(agentId, 'frozen', recoveredEvents, t0 + 35_000);

      // Recovered events update lastEventAt to now → healthy
      expect(verdict.status).toBe('healthy');
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });
  });

  describe('hook_disconnected vs stale_agent distinction', () => {
    test('pane changing + no events = hook_disconnected (not stale_agent) at 30s', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'pane v1', [], t0 + 5_000);
      // 31s, pane changed
      const verdict = watchdog.tick(agentId, 'pane v2 different content', [], t0 + 31_000);
      expect(verdict.status).toBe('hook_disconnected');
    });

    test('pane changing + no events under 30s = healthy (pane change suppresses stale)', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'pane v1', [], t0 + 5_000);
      // 15s, pane changed — under unconditional threshold
      const verdict = watchdog.tick(agentId, 'pane v2 changed', [], t0 + 15_000);
      expect(verdict.status).toBe('healthy');
    });

    test('pane frozen + no events = stale_agent (at 10s)', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'frozen pane', [], t0 + 5_000);
      const verdict = watchdog.tick(agentId, 'frozen pane', [], t0 + 11_000);
      expect(verdict.status).toBe('stale_agent');
    });

    test('Codex timer-only redraws do not count as visible activity', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(
        agentId,
        '• Working (16s • esc to interrupt)\n\n› Summarize recent commits\n\n  gpt-5.4 high · 64% left · ~/git/kookr',
        [],
        t0 + 5_000,
      );

      const verdict = watchdog.tick(
        agentId,
        '• Working (77s • esc to interrupt)\n\n› Summarize recent commits\n\n  gpt-5.4 high · 63% left · ~/git/kookr',
        [],
        t0 + 61_000,
      );
      expect(verdict.status).toBe('stale_agent');
    });
  });

  describe('E2E scenarios', () => {
    // T13.1: Normal agent lifecycle — no false positives
    test('T13.1: normal lifecycle produces zero false positives', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);

      // SessionStart
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);
      let v = watchdog.tick(agentId, 'starting...', [], t0 + 5_000);
      expect(v.status).toBe('grace_period');

      // Tool cycle 1
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Read', 't1'),
        makeToolResult('s1', 'Read', 't1'),
      ], t0 + 12_000);
      v = watchdog.tick(agentId, 'reading file...', [], t0 + 13_000);
      expect(v.status).toBe('healthy');

      // Tool cycle 2
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Bash', 't2'),
        makeToolResult('s1', 'Bash', 't2'),
      ], t0 + 15_000);
      v = watchdog.tick(agentId, 'running command...', [], t0 + 16_000);
      expect(v.status).toBe('healthy');

      // Stop → needs_input (detected by Monitor, not Watchdog — Watchdog would need more time)
      watchdog.recordEvents(agentId, [makeStop('s1', 'Done.')], t0 + 18_000);
      v = watchdog.tick(agentId, 'waiting for input', [], t0 + 19_000);
      expect(v.status).toBe('healthy'); // Only 1s since stop, under threshold
    });

    // T13.2: Agent runs pnpm build (90s, frozen pane)
    test('T13.2: 90s build never triggers false positive', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      // Check at 10s intervals through the build
      for (let elapsed = 5_000; elapsed <= 90_000; elapsed += 5_000) {
        const v = watchdog.tick(agentId, 'frozen pane', [], t0 + elapsed);
        expect(v.status).toBe(elapsed < 10_000 ? 'grace_period' : 'tool_running');
      }
    });

    // T13.3: Build finishes then agent gets stuck
    test('T13.3: stale_agent fires after build completes and agent goes silent', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);

      watchdog.tick(agentId, 'building...', [], t0 + 5_000);

      // Build finishes at 90s
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], t0 + 90_000);
      watchdog.tick(agentId, 'build done', [], t0 + 91_000);

      // 10s after build finished: stale
      const verdict = watchdog.tick(agentId, 'build done', [], t0 + 101_000);
      expect(verdict.status).toBe('stale_agent');
    });

    // T13.7 critical: blocked pipeline during tool execution
    test('T13.7: blocked pipeline recovered via hook file probe', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);

      // PreToolUse delivered normally
      watchdog.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0);
      watchdog.tick(agentId, 'running sleep', [], t0 + 5_000);

      // Pipeline breaks. sleep finishes at t0+10s. Stop at t0+10s.
      // At t0+15s, probe finds PostToolUse + Stop in hook file:
      const recovered = [
        makeToolResult('s1', 'Bash', 't1'),
        makeStop('s1', 'Sleep done'),
      ];
      const v = watchdog.tick(agentId, 'sleep done', recovered, t0 + 15_000);

      // Recovered events processed: lastEventAt = now, tool matched → healthy
      expect(v.status).toBe('healthy');
      expect(watchdog.hasToolInProgress(agentId)).toBe(false);
    });
  });

  describe('restart recovery (Phase 4)', () => {
    // T5.7: Persisted lastEventAt — server down for 10 minutes, agent stuck
    test('T5.7: persisted lastEventAt detects stale agent immediately after restart', () => {
      const restartTime = 700_000;
      const lastEventBefore = restartTime - 600_000; // 10 minutes before restart = 100_000

      const restartWatchdog = new Watchdog(FAST_CONFIG);
      restartWatchdog.registerAgent(agentId, lastEventBefore, restartTime);

      restartWatchdog.tick(agentId, 'frozen pane', [], restartTime + 5_000); // establish pane hash (grace period)
      const v2 = restartWatchdog.tick(agentId, 'frozen pane', [], restartTime + 11_000);
      expect(v2.status).toBe('stale_agent');
      if (v2.status === 'stale_agent') {
        // Should show a large staleness duration (from 10 min ago), not from
        // restart. (700000 + 11000 - 100000) / 1000 = 611s → humanized "10 min"
        expect(v2.anomaly.explanation).toMatch(/10 min/);
      }
    });

    // Issue #2045: silence-age max(hook, pane, token) must not reset to
    // restart time when lastEventAt is restored — otherwise hungSuspect TTL
    // reclaim always sees skipped_under_ttl after redeploy.
    test('restored lastEventAt also seeds lastPaneChangeAt (silence continuity)', () => {
      const restartTime = 700_000;
      const lastEventBefore = restartTime - 600_000;
      const restartWatchdog = new Watchdog(FAST_CONFIG);
      restartWatchdog.registerAgent(agentId, lastEventBefore, restartTime);
      const state = restartWatchdog.getState(agentId);
      expect(state?.lastEventAt).toBe(lastEventBefore);
      expect(state?.lastPaneChangeAt).toBe(lastEventBefore);
      expect(state?.registeredAt).toBe(restartTime);
    });

    test('fresh registration without lastEventAt still seeds pane at registration time', () => {
      const regAt = 500_000;
      const restartWatchdog = new Watchdog(FAST_CONFIG);
      restartWatchdog.registerAgent(agentId, undefined, regAt);
      const state = restartWatchdog.getState(agentId);
      expect(state?.lastEventAt).toBe(regAt);
      expect(state?.lastPaneChangeAt).toBe(regAt);
    });

    // T5.8: Restart recovery — persisted lastEventAt but agent is actually fine
    test('T5.8: recovered events from hook replay update lastEventAt', () => {
      const restartTime = 100_000;
      const lastEventBefore = restartTime - 60_000; // 1 minute before restart

      watchdog.registerAgent(agentId, lastEventBefore, restartTime);

      // Hook replay recovers events (agent was working during server downtime)
      const recovered = [
        makeToolUse('s1', 'Read', 't1'),
        makeToolResult('s1', 'Read', 't1'),
      ];

      watchdog.tick(agentId, 'active pane', [], restartTime + 5_000); // grace period
      // After grace period, feed recovered events
      const v = watchdog.tick(agentId, 'active pane', recovered, restartTime + 11_000);
      // Events recovered → lastEventAt updated → healthy
      expect(v.status).toBe('healthy');
    });
  });

  describe('token activity suppression', () => {
    test('quiet_working when stale but tokens recently consumed', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // Record token activity at t0 + 8s
      watchdog.recordTokenActivity(agentId, t0 + 8_000);

      // 11s since last event, frozen pane → would be stale, but token activity at 8s is within threshold
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 11_000);
      expect(verdict.status).toBe('quiet_working');
    });

    test('stale_agent when token activity is older than threshold', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // Record token activity long ago
      watchdog.recordTokenActivity(agentId, t0 + 2_000);

      // 41s since last event, 39s since token activity (past 30s threshold) → stale
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 41_000);
      expect(verdict.status).toBe('stale_agent');
    });

    test('stale_agent when no token activity ever recorded', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      watchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // No recordTokenActivity called → lastTokenActivityAt = 0 → stale
      const verdict = watchdog.tick(agentId, 'frozen', [], t0 + 11_000);
      expect(verdict.status).toBe('stale_agent');
    });

    test('token activity does not suppress hook_disconnected', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);

      watchdog.tick(agentId, 'pane v1', [], t0 + 5_000);
      watchdog.recordTokenActivity(agentId, t0 + 25_000);

      // Pane changes, but no events for 31s → hook_disconnected (token activity doesn't suppress this)
      const verdict = watchdog.tick(agentId, 'pane v2 different', [], t0 + 31_000);
      expect(verdict.status).toBe('hook_disconnected');
    });

    test('token activity suppresses Codex timer-only redraw noise', () => {
      const t0 = 0;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);

      watchdog.tick(
        agentId,
        '• Working (16s • esc to interrupt)\n\n› Summarize recent commits\n\n  gpt-5.4 high · 64% left · ~/git/kookr',
        [],
        t0 + 5_000,
      );
      watchdog.recordTokenActivity(agentId, t0 + 25_000);

      const verdict = watchdog.tick(
        agentId,
        '• Working (31s • esc to interrupt)\n\n› Summarize recent commits\n\n  gpt-5.4 high · 63% left · ~/git/kookr',
        [],
        t0 + 31_000,
      );
      expect(verdict.status).toBe('quiet_working');
    });

    test('recordTokenActivity on unknown agent is a no-op', () => {
      watchdog.recordTokenActivity('nonexistent');
      // Should not throw
    });

    test('E2E: LLM thinking produces quiet_working, then becomes stale', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.recordEvents(agentId, [
        makeToolUse('s1', 'Read', 't1'),
        makeToolResult('s1', 'Read', 't1'),
      ], t0);

      watchdog.tick(agentId, 'pane', [], t0 + 5_000);

      // LLM starts thinking at t0+10s — no events, frozen pane, but tokens consumed
      watchdog.recordTokenActivity(agentId, t0 + 10_000);
      const v1 = watchdog.tick(agentId, 'pane', [], t0 + 15_000);
      expect(v1.status).toBe('quiet_working');

      // Tokens still being consumed at t0+20s
      watchdog.recordTokenActivity(agentId, t0 + 20_000);
      const v2 = watchdog.tick(agentId, 'pane', [], t0 + 25_000);
      expect(v2.status).toBe('quiet_working');

      // Token activity stops — 35s since last token activity (past 30s threshold)
      const v3 = watchdog.tick(agentId, 'pane', [], t0 + 55_000);
      expect(v3.status).toBe('stale_agent');
    });
  });

  describe('increased default thresholds', () => {
    test('default staleThresholdMs is 30s', () => {
      const defaultWatchdog = new Watchdog();
      const t0 = 1000;
      defaultWatchdog.registerAgent(agentId, t0, t0);
      defaultWatchdog.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0);

      defaultWatchdog.tick(agentId, 'frozen', [], t0 + 5_000);

      // 15s since last event — under new 30s default threshold
      const v1 = defaultWatchdog.tick(agentId, 'frozen', [], t0 + 15_000);
      expect(v1.status).toBe('healthy');

      // 31s since last event — past 30s threshold, no token activity → stale
      const v2 = defaultWatchdog.tick(agentId, 'frozen', [], t0 + 31_000);
      expect(v2.status).toBe('stale_agent');
    });

    test('default unconditionalStaleThresholdMs is 60s', () => {
      const defaultWatchdog = new Watchdog();
      const t0 = 0;
      defaultWatchdog.registerAgent(agentId, t0, t0);
      defaultWatchdog.recordEvents(agentId, [makeSessionStart('s1')], t0);

      defaultWatchdog.tick(agentId, 'pane v1', [], t0 + 5_000);

      // 45s, pane changed — under new 60s unconditional threshold → healthy
      const v1 = defaultWatchdog.tick(agentId, 'pane v2', [], t0 + 45_000);
      expect(v1.status).toBe('healthy');

      // 61s, pane changed → hook_disconnected
      const v2 = defaultWatchdog.tick(agentId, 'pane v3', [], t0 + 61_000);
      expect(v2.status).toBe('hook_disconnected');
    });
  });

  // Issue #224: Codex emits `Notification(notification_type=mcp_startup_starting)` right
  // before spawning MCP servers. Server startup commonly takes 30–60s of silence before
  // any real tool event arrives, which would otherwise trip the stale_agent threshold.
  // These tests verify the Watchdog enters a transitional `mcp_starting` state on that
  // signal and exits it on the first subsequent tool/stop/session_end event.
  describe('MCP startup transitional state (issue #224)', () => {
    // Use a short mcpStartupGracePeriodMs so the suppression window can be exercised
    // within the FAST_CONFIG numeric range.
    const MCP_CONFIG: Partial<WatchdogConfig> = {
      ...FAST_CONFIG,
      mcpStartupGracePeriodMs: 60_000,
    };

    function makeMcpStartupNotification(sessionId: string): AgentEvent {
      return {
        type: 'notification',
        sessionId,
        notificationType: 'mcp_startup_starting',
        message: 'Starting MCP servers',
      };
    }

    test('mcp_startup_starting notification enters mcp_starting state and suppresses stale detection', () => {
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0; // start at 0 so we are past grace period
      wd.registerAgent(agentId, t0, t0);

      // Establish pane baseline past the grace period
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      // Agent receives the mcp_startup_starting notification at 12s
      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);
      expect(wd.getState(agentId)?.mcpStartupAt).toBe(t0 + 12_000);

      // 45s later (well past the 10s staleThreshold and 30s unconditional threshold)
      // with a frozen pane and no other events — this would normally fire stale_agent.
      // Because we're inside the MCP startup grace window it should report mcp_starting.
      const verdict = wd.tick(agentId, 'pane', [], t0 + 57_000);
      expect(verdict.status).toBe('mcp_starting');
    });

    test('mcp_starting state is cleared on first subsequent PreToolUse (tick no longer returns mcp_starting)', () => {
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);

      // Tool starts at 40s — MCP startup is done, first real work begins.
      wd.recordEvents(agentId, [makeToolUse('s1', 'Bash', 't1')], t0 + 40_000);

      // After clearing, a tick deep inside the original 60s window should no longer
      // return mcp_starting. A tool is in progress, so we expect tool_running.
      const verdict = wd.tick(agentId, 'pane', [], t0 + 55_000);
      expect(verdict.status).toBe('tool_running');
    });

    test('mcp_starting state is cleared on PostToolUse (tick no longer returns mcp_starting)', () => {
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);
      wd.recordEvents(agentId, [makeToolResult('s1', 'Read', 't1')], t0 + 40_000);

      // 5s after the PostToolUse, inside the original 60s window — healthy, not mcp_starting.
      const verdict = wd.tick(agentId, 'pane', [], t0 + 45_000);
      expect(verdict.status).toBe('healthy');
    });

    test('mcp_starting state is cleared on Stop (tick no longer returns mcp_starting)', () => {
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);
      wd.recordEvents(agentId, [makeStop('s1', 'done')], t0 + 40_000);

      const verdict = wd.tick(agentId, 'pane', [], t0 + 45_000);
      expect(verdict.status).toBe('healthy');
    });

    test('mcp_starting state is cleared on session_end (tick no longer returns mcp_starting)', () => {
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);
      const sessionEnd: AgentEvent = { type: 'session_end', sessionId: 's1', reason: 'other' };
      wd.recordEvents(agentId, [sessionEnd], t0 + 40_000);

      const verdict = wd.tick(agentId, 'pane', [], t0 + 45_000);
      expect(verdict.status).toBe('healthy');
    });

    test('after mcp_starting clears, normal stale detection resumes', () => {
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);
      // PostToolUse at 40s clears mcp_starting.
      wd.recordEvents(agentId, [makeToolResult('s1', 'Bash', 't1')], t0 + 40_000);

      // 51s (11s after the last real event) with a frozen pane and no tool in progress
      // should now fire stale_agent normally.
      const verdict = wd.tick(agentId, 'pane', [], t0 + 51_000);
      expect(verdict.status).toBe('stale_agent');
    });

    test('mcp_starting state expires after mcpStartupGracePeriodMs (boundary is strict <)', () => {
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);

      // 1ms before the 60s grace window expires → still mcp_starting
      const vInWindow = wd.tick(agentId, 'pane', [], t0 + 71_999);
      expect(vInWindow.status).toBe('mcp_starting');

      // Exactly at the 60s boundary — strict `<` in watchdog.ts means this falls through.
      const vAtBoundary = wd.tick(agentId, 'pane', [], t0 + 72_000);
      expect(vAtBoundary.status).toBe('stale_agent');

      // Just past the window — also falls through to regular stale detection.
      const vPastWindow = wd.tick(agentId, 'pane', [], t0 + 73_000);
      expect(vPastWindow.status).toBe('stale_agent');
    });

    test('mcp_starting wins over tool_running when notification arrives after tool_use', () => {
      // Documents the verdict ordering in tick(): the MCP grace check runs before the
      // toolInProgress check. If a batch delivers tool_use and then the notification
      // (reordered hook delivery), the startup grace takes precedence.
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [
        makeToolUse('s1', 'Bash', 't1'),
        makeMcpStartupNotification('s1'),
      ], t0 + 12_000);

      expect(wd.hasToolInProgress(agentId)).toBe(true);
      const verdict = wd.tick(agentId, 'pane', [], t0 + 45_000);
      expect(verdict.status).toBe('mcp_starting');
    });

    test('repeated mcp_startup_starting notifications refresh the grace window', () => {
      // Documents intentional refresh semantics: an unconditional overwrite of mcpStartupAt
      // means a second notification extends suppression from its own timestamp.
      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 12_000);
      // Second notification 50s later — extends the window.
      wd.recordEvents(agentId, [makeMcpStartupNotification('s1')], t0 + 62_000);

      // At t0 + 90_000: 78s since the first notification (past original 60s window),
      // but only 28s since the refresh — still mcp_starting.
      const verdict = wd.tick(agentId, 'pane', [], t0 + 90_000);
      expect(verdict.status).toBe('mcp_starting');
    });

    test('end-to-end with real Codex hook JSONL capture from fixture', () => {
      // Load the realistic Codex MCP-startup hook sequence from fixture.
      const lines = loadFixture('hook-codex-mcp-startup.jsonl').trim().split('\n');
      const events = lines
        .map((line) => parseHookEvent(line))
        .filter((e): e is AgentEvent => e !== null);

      // Sanity: fixture contains the expected 6-event sequence.
      expect(events.length).toBe(6);
      expect(events[0].type).toBe('notification');
      if (events[0].type === 'notification') {
        expect(events[0].notificationType).toBe('mcp_startup_starting');
      }

      const wd = new Watchdog(MCP_CONFIG);
      const t0 = 0;
      wd.registerAgent(agentId, t0, t0);
      wd.tick(agentId, 'pane', [], t0 + 11_000);

      // Feed the Notification first — this should enter mcp_starting state.
      wd.recordEvents(agentId, [events[0]], t0 + 12_000);
      expect(wd.getState(agentId)?.mcpStartupAt).toBe(t0 + 12_000);

      // 45s of simulated MCP startup silence with a frozen pane — still suppressed.
      const vDuringStartup = wd.tick(agentId, 'pane', [], t0 + 57_000);
      expect(vDuringStartup.status).toBe('mcp_starting');

      // Now MCP servers finish and Codex emits SessionStart + PreToolUse.
      // The SessionStart (event 1) does not clear the flag; only tool/stop/session_end do.
      wd.recordEvents(agentId, [events[1]], t0 + 58_000);
      expect(wd.getState(agentId)?.mcpStartupAt).toBe(t0 + 12_000);

      // PreToolUse (event 2) clears the mcp_starting flag — real work has begun.
      wd.recordEvents(agentId, [events[2]], t0 + 58_500);
      expect(wd.getState(agentId)?.mcpStartupAt).toBe(0);

      // Feed the rest of the sequence — no crashes, state stays cleared.
      wd.recordEvents(agentId, events.slice(3), t0 + 59_000);
      expect(wd.getState(agentId)?.mcpStartupAt).toBe(0);
    });
  });

  describe('lastPaneChangeAt tracking (issue #1526 Phase A)', () => {
    test('initializes to registeredAt', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      expect(watchdog.getState(agentId)?.lastPaneChangeAt).toBe(t0);
    });

    test('the first tick establishes a baseline without counting as a change', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.tick(agentId, 'initial pane', [], t0 + 5_000);
      // No prior hash to diff against — lastPaneChangeAt stays at registration.
      expect(watchdog.getState(agentId)?.lastPaneChangeAt).toBe(t0);
    });

    test('advances only on a genuine content change, not on every tick', () => {
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.tick(agentId, 'pane v1', [], t0 + 1_000); // baseline
      watchdog.tick(agentId, 'pane v1', [], t0 + 2_000); // unchanged
      expect(watchdog.getState(agentId)?.lastPaneChangeAt).toBe(t0);

      watchdog.tick(agentId, 'pane v2', [], t0 + 3_000); // changed
      expect(watchdog.getState(agentId)?.lastPaneChangeAt).toBe(t0 + 3_000);

      watchdog.tick(agentId, 'pane v2', [], t0 + 4_000); // unchanged again
      expect(watchdog.getState(agentId)?.lastPaneChangeAt).toBe(t0 + 3_000);
    });

    test('re-registration resets lastPaneChangeAt (and every other liveness field) to the new registration time', () => {
      // This is what makes "the hung-task reaper's silence clock restarts on
      // server reboot/reconciliation re-registration" true (issue #1526
      // Phase A): a task that was already hours silent before a restart does
      // not immediately become reap-eligible again the moment its agent is
      // re-registered — the clock starts over.
      const t0 = 1000;
      watchdog.registerAgent(agentId, t0, t0);
      watchdog.tick(agentId, 'pane v1', [], t0 + 1_000);
      watchdog.recordTokenActivity(agentId, t0 + 1_000);
      watchdog.tick(agentId, 'pane v2', [], t0 + 2_000); // pane change → lastPaneChangeAt = t0 + 2_000
      expect(watchdog.getState(agentId)).toMatchObject({
        lastEventAt: t0,
        lastPaneChangeAt: t0 + 2_000,
        lastTokenActivityAt: t0 + 1_000,
      });

      const t1 = t0 + 100_000; // e.g. a server restart, much later
      watchdog.registerAgent(agentId, t1, t1);

      expect(watchdog.getState(agentId)).toMatchObject({
        lastEventAt: t1,
        lastPaneChangeAt: t1,
        lastTokenActivityAt: 0,
      });
    });
  });

  describe('getConfig (issue #1526 Phase B)', () => {
    test('reflects the constructor config', () => {
      expect(watchdog.getConfig()).toMatchObject(FAST_CONFIG);
    });

    test('reflects a live reconfigure — capacity-ledger classification must never read a stale threshold', () => {
      watchdog.reconfigure({ unconditionalStaleThresholdMs: 999_000 });
      expect(watchdog.getConfig().unconditionalStaleThresholdMs).toBe(999_000);
    });
  });
});
