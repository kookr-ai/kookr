/**
 * Fixture vitals for the dashboard E2E specs.
 *
 * The real server measures the machine the suite runs on, which is different on
 * every host (GPU or not, loaded or idle) and would make the vitals panel
 * untestable. `routeFleetVitals` therefore sits between the page and the
 * server: every other message passes through untouched, the server's own
 * `fleetVitals` and `resourceStatus` messages are dropped, and the spec sends
 * the sample it wants. A matching `resourceStatus` goes with each sample, as
 * on a real server where both come from one measurement, so the System
 * indicator (which reads CPU, memory and lag from `resourceStatus`) agrees
 * with the vitals.
 */
import type { Page, WebSocketRoute } from '@playwright/test';
import type {
  FleetVitalsHistoryPoint,
  FleetVitalsSample,
} from '../src/shared/contracts/fleet-vitals.js';

const GIB = 1_073_741_824;

export interface VitalsFixtureOptions {
  cpu?: number | null;
  loadAverage?: number;
  ramPercent?: number;
  gpu?: boolean;
  gpuLoad?: number;
  gpuTemperature?: number;
  vramPercent?: number;
  lagMs?: number | null;
  agents?: number;
  subagents?: number;
  /** `null`: rates are still warming up. */
  generatedPerSec?: number | null;
  readPerSec?: number;
  toolCallsPerMin?: number;
}

/** A sample of the machine the panel was designed on: 24 cores, 31 GB, one RTX 3090, 15 running. */
export function vitalsSample(options: VitalsFixtureOptions = {}): FleetVitalsSample {
  const pick = <K extends keyof VitalsFixtureOptions>(key: K, fallback: NonNullable<VitalsFixtureOptions[K]>) =>
    (key in options ? options[key] : fallback) as VitalsFixtureOptions[K];
  const ramPercent = options.ramPercent ?? 32;
  const vramPercent = options.vramPercent ?? 10;
  const generated = pick('generatedPerSec', 110) ?? null;
  const read = options.readPerSec ?? 13_860;
  const tools = options.toolCallsPerMin ?? 26;
  return {
    sampledAtMs: Date.now(),
    machine: {
      cpuUsagePercent: pick('cpu', 66) ?? null,
      loadAverage1m: options.loadAverage ?? 18.2,
      logicalCpuCount: 24,
      memoryUsedPercent: ramPercent,
      memoryUsedBytes: (ramPercent / 100) * 31 * GIB,
      memoryTotalBytes: 31 * GIB,
      gpu: options.gpu === false
        ? null
        : {
            name: 'NVIDIA GeForce RTX 3090',
            deviceCount: 1,
            utilizationPercent: options.gpuLoad ?? 24,
            memoryUsedBytes: (vramPercent / 100) * 24 * GIB,
            memoryTotalBytes: 24 * GIB,
            memoryUsedPercent: vramPercent,
            temperatureC: options.gpuTemperature ?? 48,
            powerWatts: 32,
          },
      gpuUnavailable: options.gpu === false ? 'not_installed' : null,
      serverLoopDelayP95Ms: pick('lagMs', 123) ?? null,
    },
    fleet: {
      agents: options.agents ?? 9,
      subagents: options.subagents ?? 6,
      tokens: generated === null
        ? null
        : { generatedPerSec: generated, readPerSec: read, cacheReadPerSec: Math.round(read * 0.976) },
      toolCallsPerMin: tools,
      topTools: tools === 0
        ? []
        : [
            { tool: 'Bash', calls: Math.round(tools * 0.72) },
            { tool: 'Read', calls: Math.round(tools * 0.14) },
            { tool: 'Write', calls: Math.max(1, Math.round(tools * 0.04)) },
          ],
    },
  };
}

/** Deterministic pseudo-random numbers in [0, 1), so screenshots do not change between runs. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/**
 * Five minutes of history ending at `sample`: a calm baseline with a few bursts,
 * shaped like a real fleet (a burst of tool calls comes with a burst of tokens).
 */
export function vitalsHistory(
  sample: FleetVitalsSample,
  points = 150,
  options: { idle?: boolean } = {},
): FleetVitalsHistoryPoint[] {
  const random = seeded(7);
  const { machine, fleet } = sample;
  const generated = fleet.tokens?.generatedPerSec ?? null;
  const read = fleet.tokens?.readPerSec ?? null;
  const history: FleetVitalsHistoryPoint[] = [];
  let burst = 0;
  for (let index = 0; index < points; index++) {
    if (random() < 0.04) burst = 1;
    burst *= 0.82;
    const wobble = 0.75 + random() * 0.5;
    const level = options.idle ? 0 : wobble * (1 + burst * 1.4);
    const last = index === points - 1;
    history.push({
      t: sample.sampledAtMs - (points - 1 - index) * 2_000,
      cpu: machine.cpuUsagePercent === null ? null : Math.min(100, machine.cpuUsagePercent * (0.85 + random() * 0.3)),
      mem: machine.memoryUsedPercent,
      gpu: machine.gpu?.utilizationPercent ?? null,
      vram: machine.gpu?.memoryUsedPercent ?? null,
      run: fleet.agents + fleet.subagents,
      gen: generated === null ? null : last ? generated : Math.round(generated * level),
      read: read === null ? null : last ? read : Math.round(read * level),
      tools: last ? fleet.toolCallsPerMin : Math.round(fleet.toolCallsPerMin * level),
    });
  }
  return history;
}

/** The `resourceStatus` a server would send alongside `sample`. */
function matchingResourceStatus(sample: FleetVitalsSample) {
  const { machine } = sample;
  return {
    source: { kind: 'server-host' },
    sampledAt: new Date(sample.sampledAtMs).toISOString(),
    sampleGapMs: 2_000,
    timerDriftMs: 0,
    host: {
      cpuUsagePercent: machine.cpuUsagePercent,
      memoryUsedPercent: machine.memoryUsedPercent,
      memoryFreeBytes: machine.memoryTotalBytes === null || machine.memoryUsedBytes === null
        ? null
        : machine.memoryTotalBytes - machine.memoryUsedBytes,
      memoryTotalBytes: machine.memoryTotalBytes,
      dataDirectory: { path: '/data', diskFreeBytes: 54 * GIB, diskTotalBytes: 503 * GIB, diskFreePercent: 10.7 },
    },
    server: {
      eventLoopDelayP95Ms: machine.serverLoopDelayP95Ms,
      processRssBytes: 215 * 1_048_576,
      processHeapUsedBytes: 90 * 1_048_576,
      processHeapTotalBytes: 120 * 1_048_576,
    },
    unavailable: machine.cpuUsagePercent === null ? ['cpu_warming_up'] : [],
  };
}

export interface FleetVitalsRoute {
  /** Send a sample to every open dashboard socket, as the connection burst (`history`) or as a tick. */
  send(sample: FleetVitalsSample, history?: FleetVitalsHistoryPoint[]): void;
}

/**
 * Take over the page's `fleetVitals` messages. Call before `page.goto`.
 */
export async function routeFleetVitals(page: Page): Promise<FleetVitalsRoute> {
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/ws(\?.*)?$/, (socket) => {
    const server = socket.connectToServer();
    sockets.add(socket);
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      // The real machine's readings are replaced by the spec's fixture.
      if (
        typeof message === 'string'
        && (message.startsWith('{"type":"fleetVitals"') || message.startsWith('{"type":"resourceStatus"'))
      ) return;
      socket.send(message);
    });
    socket.onClose(() => {
      sockets.delete(socket);
      server.close();
    });
  });
  return {
    send(sample, history) {
      const resource = JSON.stringify({ type: 'resourceStatus', status: matchingResourceStatus(sample) });
      const message = JSON.stringify({ type: 'fleetVitals', sample, ...(history ? { history } : {}) });
      for (const socket of sockets) {
        socket.send(resource);
        socket.send(message);
      }
    },
  };
}
