import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import {
  FLEET_VITALS_HISTORY_POINTS,
  fleetVitalsHistoryPoint,
  type FleetVitalsGpu,
  type FleetVitalsHistoryPoint,
  type FleetVitalsSample,
  type FleetVitalsToolShare,
} from '../shared/contracts/fleet-vitals.js';
import {
  SlidingEventCounter,
  TokenRateMeter,
  TOOL_CALL_WINDOW_MS,
  type TokenTotals,
} from '../core/fleet-activity-meter.js';
import { summarizeGpuDevices } from '../core/gpu-metrics.js';
import type { GpuProbeSnapshot } from './gpu-probe.js';

/** How often `nvidia-smi` is run. Slower than the vitals tick: one call costs about 0.1 s of wall time. */
export const FLEET_VITALS_GPU_REFRESH_MS = 4_000;
/** Tools listed in `topTools`. */
const TOP_TOOL_COUNT = 3;
/**
 * Distinct tool names counted at once. Tool names come from agents (MCP tools
 * can have any name), so the map is capped; calls to further tools still count
 * in the total, only their name is left out of the mix.
 */
const MAX_TRACKED_TOOLS = 200;

/** A live task as the vitals service needs it. */
export interface FleetVitalsLiveTask {
  id: string;
  /** Cumulative token counts, absent until the first usage report. */
  tokens: TokenTotals | null;
}

export interface FleetVitalsGpuSource {
  /** Starts a probe; never rejects and never overlaps a running probe. */
  refresh(): Promise<void>;
  snapshot(): GpuProbeSnapshot;
}

export interface FleetVitalsServiceDeps {
  broadcastToAll: (msg: ServerMessage) => void;
  gpu: FleetVitalsGpuSource;
  /** Tasks whose agent session is live right now. */
  listLiveTasks: () => Iterable<FleetVitalsLiveTask>;
  /** Subagents started and not yet finished, across all agents. */
  countSubagents: () => number;
  /**
   * Whether anyone is looking (a dashboard is connected). The GPU command is
   * run only then; the rest of the sample is read from memory and always built.
   * Defaults to always.
   */
  isWatched?: () => boolean;
  readLoadAverage1m?: () => number | null;
  readLogicalCpuCount?: () => number | null;
  nowMs?: () => number;
  gpuRefreshMs?: number;
  historyPoints?: number;
  logger?: Pick<typeof console, 'warn'>;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Builds the fleet vitals sample and keeps the last few minutes in memory.
 *
 * The service has no timer of its own. `observeResourceStatus` is called by the
 * resource-status service on each of its ticks (every two seconds), so CPU,
 * memory and server-loop readings come from that one existing sampler, and a
 * vitals sample lines up with a resource sample.
 *
 * Every dependency call is guarded: a failing source turns its reading into
 * `null` (or zero for a count) and the sample still goes out. The caller's tick
 * must never fail because of vitals.
 */
export class FleetVitalsService {
  private readonly broadcastToAll: (msg: ServerMessage) => void;
  private readonly gpu: FleetVitalsGpuSource;
  private readonly listLiveTasks: () => Iterable<FleetVitalsLiveTask>;
  private readonly countSubagents: () => number;
  private readonly isWatched: () => boolean;
  private readonly readLoadAverage1m: () => number | null;
  private readonly readLogicalCpuCount: () => number | null;
  private readonly nowMs: () => number;
  private readonly gpuRefreshMs: number;
  private readonly historyPoints: number;
  private readonly logger: Pick<typeof console, 'warn'>;

  private readonly tokenMeter = new TokenRateMeter();
  private readonly toolCalls = new SlidingEventCounter(TOOL_CALL_WINDOW_MS);
  private readonly toolCallsByName = new Map<string, SlidingEventCounter>();
  private history: FleetVitalsHistoryPoint[] = [];
  private latest: FleetVitalsSample | null = null;
  private lastGpuRefreshAtMs: number | null = null;
  private sourceErrorLogged = false;

  constructor(deps: FleetVitalsServiceDeps) {
    this.broadcastToAll = deps.broadcastToAll;
    this.gpu = deps.gpu;
    this.listLiveTasks = deps.listLiveTasks;
    this.countSubagents = deps.countSubagents;
    this.isWatched = deps.isWatched ?? (() => true);
    this.readLoadAverage1m = deps.readLoadAverage1m ?? (() => null);
    this.readLogicalCpuCount = deps.readLogicalCpuCount ?? (() => null);
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.gpuRefreshMs = deps.gpuRefreshMs ?? FLEET_VITALS_GPU_REFRESH_MS;
    this.historyPoints = deps.historyPoints ?? FLEET_VITALS_HISTORY_POINTS;
    this.logger = deps.logger ?? console;
  }

  /** Count one tool call an agent has just started. Called from the hook event pipeline. */
  noteToolCall(toolName: string): void {
    const now = this.nowMs();
    this.toolCalls.record(now);
    let counter = this.toolCallsByName.get(toolName);
    if (!counter) {
      if (this.toolCallsByName.size >= MAX_TRACKED_TOOLS) return;
      counter = new SlidingEventCounter(TOOL_CALL_WINDOW_MS);
      this.toolCallsByName.set(toolName, counter);
    }
    counter.record(now);
  }

  /** Take one sample from the resource status that was just measured, store it and broadcast it. */
  observeResourceStatus(status: SystemResourceStatus): void {
    const now = this.nowMs();
    this.refreshGpuIfDue(now);
    const sample = this.buildSample(status, now);
    this.latest = sample;
    this.history.push(fleetVitalsHistoryPoint(sample));
    if (this.history.length > this.historyPoints) {
      this.history.splice(0, this.history.length - this.historyPoints);
    }
    this.broadcastToAll({ type: 'fleetVitals', sample });
  }

  getLatest(): FleetVitalsSample | null {
    return this.latest;
  }

  /** Oldest first. A copy: callers may serialise it at any time. */
  getHistory(): FleetVitalsHistoryPoint[] {
    return this.history.slice();
  }

  private refreshGpuIfDue(now: number): void {
    // Checked before the timing, so a skipped probe does not count as a
    // refresh: the first tick after a dashboard connects probes at once.
    if (!this.guard(this.isWatched, false)) return;
    if (this.lastGpuRefreshAtMs !== null && now - this.lastGpuRefreshAtMs < this.gpuRefreshMs) return;
    this.lastGpuRefreshAtMs = now;
    // Fire and forget: the probe is asynchronous and time-boxed, and this tick
    // reads whatever the previous probe left in `snapshot()`.
    void this.guard(() => this.gpu.refresh(), Promise.resolve()).catch(() => undefined);
  }

  private buildSample(status: SystemResourceStatus, now: number): FleetVitalsSample {
    // When the resource sampler fails, the resource status carries its last good
    // values, marked `stale` (issue #2771). They are not this tick's readings:
    // sent under a fresh timestamp they would read "Machine comfortable" for as
    // long as the sampler stays broken. Report them as unmeasured instead.
    const held = status.stale !== undefined;
    const memoryTotalBytes = held ? null : finiteOrNull(status.host.memoryTotalBytes);
    const memoryFreeBytes = held ? null : finiteOrNull(status.host.memoryFreeBytes);
    const gpuSnapshot = this.guard<GpuProbeSnapshot>(
      () => this.gpu.snapshot(),
      { devices: [], ageMs: null, unavailable: 'probe_failed' },
    );

    const liveTasks = this.guard<FleetVitalsLiveTask[]>(() => Array.from(this.listLiveTasks()), []);
    const totals = new Map<string, TokenTotals>();
    for (const task of liveTasks) {
      if (task.tokens) totals.set(task.id, task.tokens);
    }
    this.tokenMeter.observe(totals, now);

    return {
      sampledAtMs: now,
      machine: {
        cpuUsagePercent: held ? null : finiteOrNull(status.host.cpuUsagePercent),
        loadAverage1m: finiteOrNull(this.guard(this.readLoadAverage1m, null)),
        logicalCpuCount: finiteOrNull(this.guard(this.readLogicalCpuCount, null)),
        memoryUsedPercent: held ? null : finiteOrNull(status.host.memoryUsedPercent),
        memoryUsedBytes: memoryTotalBytes === null || memoryFreeBytes === null
          ? null
          : Math.max(0, memoryTotalBytes - memoryFreeBytes),
        memoryTotalBytes,
        gpu: toGpu(gpuSnapshot),
        gpuUnavailable: gpuSnapshot.unavailable,
        serverLoopDelayP95Ms: held ? null : finiteOrNull(status.server.eventLoopDelayP95Ms),
      },
      fleet: {
        agents: liveTasks.length,
        subagents: Math.max(0, finiteOrNull(this.guard(this.countSubagents, 0)) ?? 0),
        tokens: this.tokenMeter.rates(now),
        toolCallsPerMin: this.toolCalls.count(now),
        topTools: this.topTools(now),
      },
    };
  }

  private topTools(now: number): FleetVitalsToolShare[] {
    const shares: FleetVitalsToolShare[] = [];
    for (const [tool, counter] of this.toolCallsByName) {
      const calls = counter.count(now);
      if (calls === 0) {
        // Nothing in the window any more: drop the entry so the map tracks only recent tools.
        this.toolCallsByName.delete(tool);
        continue;
      }
      shares.push({ tool, calls });
    }
    shares.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
    return shares.slice(0, TOP_TOOL_COUNT);
  }

  private guard<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch (err) {
      if (!this.sourceErrorLogged) {
        this.sourceErrorLogged = true;
        this.logger.warn('[fleet-vitals] a source threw; reporting it as unavailable', err);
      }
      return fallback;
    }
  }
}

function toGpu(snapshot: GpuProbeSnapshot): FleetVitalsGpu | null {
  if (snapshot.unavailable !== null || snapshot.devices.length === 0) return null;
  const summary = summarizeGpuDevices(snapshot.devices);
  return {
    name: snapshot.devices[0].name || null,
    deviceCount: summary.deviceCount,
    utilizationPercent: summary.utilizationPercent,
    memoryUsedBytes: summary.memoryUsedBytes,
    memoryTotalBytes: summary.memoryTotalBytes,
    memoryUsedPercent: summary.memoryUsedPercent,
    temperatureC: summary.temperatureC,
    powerWatts: summary.powerWatts,
  };
}
