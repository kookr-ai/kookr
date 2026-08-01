/**
 * Integration invariant (#1783): with WS load-shed enabled, forced snapshot
 * storms must keep event-loop delay p95 under a host-safe budget.
 *
 * Complements the unit tests for the load-shed gate itself (#1725) and the
 * external `scripts/load-harness.ts` — this is the in-suite regression guard
 * for the death-spiral class without waiting for a prod OOM.
 *
 * Named `event-loop-storm.test.ts` (not `*.integration.test.ts`) so the default
 * vitest suite runs it; `vitest.config.ts` excludes `*.integration.test.ts`.
 *
 * Host-dependent: the absolute budget is intentionally high so ordinary CI
 * noise never flakes, while multi-second loop saturation still fails the build.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

import { AdapterRegistry, type AgentAdapter } from '../../adapters/agent-adapter.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { LedgerAnalytics } from '../../core/ledger-analytics.js';
import { Monitor } from '../../core/monitor.js';
import { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { PrLessonsDiscovery, PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import { ProjectConfigStore } from '../../core/project-config-store.js';
import { ProjectSidebarStore } from '../../core/project-sidebar-store.js';
import { SkillDiscoveryStateHolder, SkillTrackedRepoDiscovery } from '../../core/skill-tracked-repo-discovery.js';
import { TaskStore } from '../../core/tasks.js';
import type { AgentEvent } from '../../core/types.js';
import { createRealtimeServices } from '../bootstrap/create-realtime-services.js';
import { createSnapshotMessage } from '../use-cases/get-snapshot.js';
import {
  DEFAULT_LOAD_SHED_EVENT_LOOP_DELAY_MS,
  DEFAULT_LOAD_SHED_RECOVER_TICKS,
  DEFAULT_LOAD_SHED_SUSTAIN_TICKS,
} from '../websocket-load-shed.js';

/** Multi-second stalls are the #1725 death-spiral signature; keep well above CI noise. */
const EVENT_LOOP_P95_BUDGET_MS = 5_000;

/** Fleet large enough that naive full-fanout is expensive without OOMing the test process. */
const AGENT_COUNT = 60;
const EVENTS_PER_AGENT = 8;
/** Many dashboard sockets amplify serialize-and-fan-out (the #1725 saturating work). */
const SOCKET_COUNT = 40;
/** Forced dirty rebuild + broadcast rounds during the storm window. */
const STORM_ROUNDS = 24;
/** Sample real loop delay (and feed the shed gate) every N rounds. */
const SAMPLE_EVERY = 4;
/** Pad size per tool input — keeps each agent snapshot non-trivial. */
const TOOL_INPUT_PAD = 1_500;

const NS_PER_MS = 1_000_000;

function fakeAdapter(agentType: AgentAdapter['agentType']): AgentAdapter {
  return {
    agentType,
    async launch() { return 'session'; },
    async sendInput() {},
    async sendKeystroke() {},
    async stop() {},
    async captureDisplay() { return ''; },
    onEvent() {},
    onRefreshNeeded() {},
    injectHookEvent() {},
    getEffectiveHookSettings() { return undefined; },
  };
}

function openSocket(send: (data: string) => void = vi.fn()): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send,
    close: vi.fn(),
  } as unknown as WebSocket;
}

function seedFleet(taskStore: TaskStore, monitor: Monitor, agentCount: number): void {
  const pad = 'x'.repeat(TOOL_INPUT_PAD);
  for (let i = 0; i < agentCount; i++) {
    const agentId = `kookr-storm-${i}`;
    const task = taskStore.createTask({
      prompt: `storm agent ${i} ${pad.slice(0, 200)}`,
      cwd: `/repo/agent-${i}`,
      name: `Storm ${i}`,
      projectId: `github.com/storm/org-${i % 8}`,
    });
    taskStore.addSession(task.id, {
      tmuxSession: agentId,
      agentType: 'claude-code',
      cwd: `/repo/agent-${i}`,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    monitor.registerAgent(agentId);
    const events: AgentEvent[] = [];
    for (let e = 0; e < EVENTS_PER_AGENT; e++) {
      events.push({
        type: 'tool_use',
        sessionId: agentId,
        toolName: e % 2 === 0 ? 'Bash' : 'Read',
        toolInput: { command: `work-${e}`, pad, path: `/tmp/storm/${i}/${e}` },
        toolUseId: `tu-${i}-${e}`,
      });
    }
    monitor.processEvents(agentId, events);
  }
}

/** Dirty one agent so the next snapshot rebuild is not a pure no-op. */
function dirtyOneAgent(monitor: Monitor, round: number): void {
  const agentId = `kookr-storm-${round % AGENT_COUNT}`;
  monitor.processEvents(agentId, [{
    type: 'tool_use',
    sessionId: agentId,
    toolName: 'Bash',
    toolInput: { command: `dirty-round-${round}`, note: `r${round}` },
    toolUseId: `dirty-${round}`,
  }]);
}

function sampleP95Ms(histogram: ReturnType<typeof monitorEventLoopDelay>): number | null {
  const count = Number(histogram.count ?? 0);
  if (count <= 0) return null;
  const p95Ns = histogram.percentile(95);
  histogram.reset();
  if (!Number.isFinite(p95Ns)) return null;
  return p95Ns / NS_PER_MS;
}

describe('event-loop storm invariant (#1783)', { timeout: 60_000 }, () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    vi.restoreAllMocks();
  });

  test('eventLoopDelayP95 stays under budget during forced snapshot storms with load-shed enabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-event-loop-storm-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    seedFleet(taskStore, monitor, AGENT_COUNT);

    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(fakeAdapter('claude-code'));
    const ossAttemptStore = new OssAttemptStore(tempDir);

    // Sheds enabled at production defaults — the invariant is "with sheds on,
    // forced storms do not death-spiral the loop", not that a custom low
    // threshold trips. Production default (1500ms / 3 ticks) still engages if
    // the host is under real pressure from the fan-out work.
    const realtime = await createRealtimeServices({
      kookrDir: tempDir,
      taskStore,
      queue,
      monitor,
      adapterRegistry,
      serverCwd: '/repo',
      ledgerAnalytics: new LedgerAnalytics(ossAttemptStore),
      projectConfigStore: new ProjectConfigStore(tempDir),
      projectSidebarStore: new ProjectSidebarStore(tempDir),
      skillDiscoveryState: new SkillDiscoveryStateHolder(
        new SkillTrackedRepoDiscovery(join(tempDir, 'claude')),
      ),
      prLessonsState: new PrLessonsStateHolder(new PrLessonsDiscovery(join(tempDir, 'claude'))),
      getRegistryActiveProjects: () => [],
      getRegistryActiveRepos: () => [],
      ossAttemptStore,
      getDefaultAgentType: () => 'claude-code',
      // Raise hard payload cap so the storm exercises fan-out rather than the
      // payload-size drop path (#832) — that path is unit-tested elsewhere.
      snapshotPayloadMaxBytes: 32 * 1024 * 1024,
      loadShedConfig: {
        eventLoopDelayThresholdMs: DEFAULT_LOAD_SHED_EVENT_LOOP_DELAY_MS,
        sustainTicks: DEFAULT_LOAD_SHED_SUSTAIN_TICKS,
        recoverTicks: DEFAULT_LOAD_SHED_RECOVER_TICKS,
      },
    });

    for (let s = 0; s < SOCKET_COUNT; s++) {
      realtime.registry.register(openSocket(), { kind: 'owner' }, 'dashboard');
    }
    expect(realtime.registry.dashboardCount()).toBe(SOCKET_COUNT);

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();

    const p95Samples: number[] = [];

    // Warm the histogram so the first sample is non-null.
    await delay(40);

    for (let round = 0; round < STORM_ROUNDS; round++) {
      // Dirty + full rebuild (the production event-pipeline flush path) then
      // fan out through the real broadcaster, which consults the load-shed gate.
      dirtyOneAgent(monitor, round);
      const snapshot = createSnapshotMessage({
        monitor,
        serverCwd: '/repo',
        relationTaskStore: taskStore,
      });
      expect(snapshot.agents.length).toBeGreaterThan(0);
      realtime.broadcastToAll(snapshot);

      if (round % SAMPLE_EVERY === SAMPLE_EVERY - 1 || round === STORM_ROUNDS - 1) {
        // Yield so the delay histogram can observe the storm work.
        await delay(30);
        const p95 = sampleP95Ms(histogram);
        if (p95 != null) {
          p95Samples.push(p95);
          // Same feed path production uses (ResourceStatusService → noteSample).
          realtime.noteEventLoopDelaySample(p95);
        }
      }
    }

    // Final quiet sample after the storm — catches any residual hang.
    await delay(40);
    const trailing = sampleP95Ms(histogram);
    if (trailing != null) {
      p95Samples.push(trailing);
      realtime.noteEventLoopDelaySample(trailing);
    }

    histogram.disable();

    expect(p95Samples.length).toBeGreaterThan(0);
    const maxP95 = Math.max(...p95Samples);
    // Surface the observed max in assertion messages when a host does blow past
    // the budget so the failure is diagnosable without re-running with logs.
    expect(
      maxP95,
      `eventLoopDelayP95 max=${maxP95.toFixed(1)}ms over ${p95Samples.length} samples ` +
        `(budget ${EVENT_LOOP_P95_BUDGET_MS}ms; samples=[${p95Samples.map((s) => s.toFixed(1)).join(', ')}])`,
    ).toBeLessThan(EVENT_LOOP_P95_BUDGET_MS);
  });
});
