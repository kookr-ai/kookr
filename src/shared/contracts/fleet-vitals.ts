/**
 * Fleet vitals: one small sample, sent to the dashboard every two seconds, that
 * answers three questions at a glance.
 *
 * 1. Is this computer coping? (CPU, memory, GPU load, video memory)
 * 2. How much is running? (agents and their subagents)
 * 3. How hard is the fleet working? (tokens read and generated, tool calls)
 *
 * It is display-only. Nothing alerts, throttles or admits on it, and no sample
 * is written to disk: the server keeps the last few minutes in memory so a
 * freshly opened dashboard can draw its trend lines at once.
 *
 * A reading that cannot be measured is `null`, never `0`, so the dashboard can
 * tell "idle" from "unknown".
 */

/** How often the server samples and broadcasts. */
export const FLEET_VITALS_INTERVAL_MS = 2_000;
/** Samples kept in memory for trend lines: five minutes at one sample every two seconds. */
export const FLEET_VITALS_HISTORY_POINTS = 150;

/** Why there is no GPU reading. `not_installed` and `no_devices` mean this host has no usable NVIDIA GPU. */
export type FleetVitalsGpuUnavailable = 'warming_up' | 'not_installed' | 'no_devices' | 'probe_failed';

/** All NVIDIA GPUs of the host, summarised as one. */
export interface FleetVitalsGpu {
  /** Model name of the first device, for example "NVIDIA GeForce RTX 3090". */
  name: string | null;
  deviceCount: number;
  /** Busiest device's compute load, 0-100. */
  utilizationPercent: number | null;
  /** Video memory in use across devices. Per-process figures are not available. */
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  memoryUsedPercent: number | null;
  /** Hottest device, degrees Celsius. */
  temperatureC: number | null;
  /** Power draw summed across devices, watts. */
  powerWatts: number | null;
}

export interface FleetVitalsMachine {
  /** Share of all logical cores in use, 0-100. `null` on the first sample. */
  cpuUsagePercent: number | null;
  /** Runnable processes averaged over one minute. Compare with `logicalCpuCount`. */
  loadAverage1m: number | null;
  logicalCpuCount: number | null;
  /** Estimate from the operating system's free-memory figure, not "memory pressure". */
  memoryUsedPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  /** `null` when `gpuUnavailable` is set. */
  gpu: FleetVitalsGpu | null;
  gpuUnavailable: FleetVitalsGpuUnavailable | null;
  /** How late the server's own timers run (95th percentile, milliseconds): the dashboard's responsiveness. */
  serverLoopDelayP95Ms: number | null;
}

/** Tokens per second across the fleet, averaged over about thirty seconds. */
export interface FleetVitalsTokenRates {
  /** Output tokens: what the models wrote. */
  generatedPerSec: number;
  /** Everything the models were sent: fresh input, cache writes and cache reads. */
  readPerSec: number;
  /** The part of `readPerSec` that came from the prompt cache (usually almost all of it). */
  cacheReadPerSec: number;
}

/** One tool's share of recent tool calls. */
export interface FleetVitalsToolShare {
  tool: string;
  calls: number;
}

export interface FleetVitalsFleet {
  /** Tasks whose agent session is live. */
  agents: number;
  /**
   * Subagents those agents have started and not yet finished. Approximate: when
   * a "finished" signal is lost, the entry is only dropped after 30 minutes.
   */
  subagents: number;
  /**
   * `null` until the server has watched for a few seconds. A lower bound: agents
   * that report tokens only when they stop (Grok Build, OpenCode) are missing.
   */
  tokens: FleetVitalsTokenRates | null;
  /** Tool calls started in the last minute. */
  toolCallsPerMin: number;
  /** The most used tools in the last minute, busiest first (at most three). */
  topTools: FleetVitalsToolShare[];
}

export interface FleetVitalsSample {
  /** Server wall-clock time of the sample, epoch milliseconds. */
  sampledAtMs: number;
  machine: FleetVitalsMachine;
  fleet: FleetVitalsFleet;
}

/**
 * One past sample reduced to the series the dashboard draws. Kept flat and
 * short-keyed because 150 of them are sent when a dashboard connects.
 */
export interface FleetVitalsHistoryPoint {
  /** Epoch milliseconds. */
  t: number;
  /** CPU in use, percent. */
  cpu: number | null;
  /** Memory in use, percent. */
  mem: number | null;
  /** GPU compute load, percent. */
  gpu: number | null;
  /** Video memory in use, percent. */
  vram: number | null;
  /** Agents plus subagents. */
  run: number;
  /** Tokens generated per second. */
  gen: number | null;
  /** Tokens read per second. */
  read: number | null;
  /** Tool calls per minute. */
  tools: number;
}

/** Reduce a sample to its history point. Used by the server buffer and by the dashboard as samples arrive. */
export function fleetVitalsHistoryPoint(sample: FleetVitalsSample): FleetVitalsHistoryPoint {
  return {
    t: sample.sampledAtMs,
    cpu: sample.machine.cpuUsagePercent,
    mem: sample.machine.memoryUsedPercent,
    gpu: sample.machine.gpu?.utilizationPercent ?? null,
    vram: sample.machine.gpu?.memoryUsedPercent ?? null,
    run: sample.fleet.agents + sample.fleet.subagents,
    gen: sample.fleet.tokens?.generatedPerSec ?? null,
    read: sample.fleet.tokens?.readPerSec ?? null,
    tools: sample.fleet.toolCallsPerMin,
  };
}
