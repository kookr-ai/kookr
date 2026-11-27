import { describe, expect, test } from 'vitest';
import type { FleetVitalsHistoryPoint, FleetVitalsSample } from '../shared/protocol.js';
import {
  cachedReadShare,
  cpuLevel,
  fleetVitalsIssues,
  fleetVitalsVerdict,
  formatVitalsBytesOfTotal,
  formatVitalsCount,
  formatVitalsLowerBound,
  formatVitalsPercent,
  gpuLoadLevel,
  historyWindowLabel,
  isFleetVitalsHistoryPoint,
  isFleetVitalsSample,
  isFleetVitalsStale,
  lagLevel,
  ramLevel,
  sanitizeFleetVitalsHistory,
  seriesPeak,
  shortGpuName,
  sparklineEnd,
  sparklinePath,
  vitalsSeries,
  vramLevel,
} from './fleet-vitals.js';

const GIB = 1_073_741_824;

interface SampleOverrides {
  cpu?: number | null;
  ramPercent?: number | null;
  ramUsedBytes?: number | null;
  ramTotalBytes?: number | null;
  gpu?: FleetVitalsSample['machine']['gpu'];
  gpuLoad?: number | null;
  vramPercent?: number | null;
  lag?: number | null;
  tokens?: FleetVitalsSample['fleet']['tokens'];
}

/** The machine this feature was designed on: 16 cores, 31 GB, one RTX 3090, 15 running. */
function sample(overrides: SampleOverrides = {}): FleetVitalsSample {
  const pick = <K extends keyof SampleOverrides>(key: K, fallback: SampleOverrides[K]): SampleOverrides[K] =>
    (key in overrides ? overrides[key] : fallback);
  const vramPercent = pick('vramPercent', 10) ?? null;
  const defaultGpu: FleetVitalsSample['machine']['gpu'] = {
    name: 'NVIDIA GeForce RTX 3090',
    deviceCount: 1,
    utilizationPercent: pick('gpuLoad', 22) ?? null,
    memoryUsedBytes: vramPercent === null ? null : (vramPercent / 100) * 24 * GIB,
    memoryTotalBytes: 24 * GIB,
    memoryUsedPercent: vramPercent,
    temperatureC: 48,
    powerWatts: 32,
  };
  const gpu = 'gpu' in overrides ? overrides.gpu ?? null : defaultGpu;
  return {
    sampledAtMs: 1_790_000_000_000,
    machine: {
      cpuUsagePercent: pick('cpu', 66) ?? null,
      loadAverage1m: 18.2,
      logicalCpuCount: 16,
      memoryUsedPercent: pick('ramPercent', 32) ?? null,
      memoryUsedBytes: pick('ramUsedBytes', 10 * GIB) ?? null,
      memoryTotalBytes: pick('ramTotalBytes', 31 * GIB) ?? null,
      gpu,
      gpuUnavailable: gpu ? null : 'not_installed',
      serverLoopDelayP95Ms: pick('lag', 123) ?? null,
    },
    fleet: {
      agents: 9,
      subagents: 6,
      tokens: 'tokens' in overrides
        ? overrides.tokens ?? null
        : { generatedPerSec: 110, readPerSec: 13_860, cacheReadPerSec: 13_525 },
      toolCallsPerMin: 26,
      topTools: [{ tool: 'Bash', calls: 18 }, { tool: 'Read', calls: 4 }],
    },
  };
}

function point(overrides: Partial<FleetVitalsHistoryPoint> = {}): FleetVitalsHistoryPoint {
  return { t: 1, gen: 100, read: 9_000, tools: 20, ...overrides };
}

describe('isFleetVitalsSample', () => {
  test('accepts a full sample and one from a machine without a GPU', () => {
    expect(isFleetVitalsSample(sample())).toBe(true);
    expect(isFleetVitalsSample(sample({ gpu: null }))).toBe(true);
  });

  test('accepts unmeasured readings (null) and rates that are still warming up', () => {
    expect(isFleetVitalsSample(sample({ cpu: null, ramPercent: null, lag: null, tokens: null }))).toBe(true);
  });

  test('rejects anything that could reach a meter or a chart as a non-number', () => {
    const cases: unknown[] = [
      null,
      'fleetVitals',
      { ...sample(), sampledAtMs: 'now' },
      { ...sample(), machine: { ...sample().machine, cpuUsagePercent: '66' } },
      { ...sample(), machine: { ...sample().machine, cpuUsagePercent: Number.NaN } },
      { ...sample(), machine: { ...sample().machine, gpu: { name: 'x', deviceCount: 1 } } },
      { ...sample(), fleet: { ...sample().fleet, agents: -1 } },
      { ...sample(), fleet: { ...sample().fleet, agents: undefined } },
      { ...sample(), fleet: { ...sample().fleet, tokens: { generatedPerSec: 'fast' } } },
      { ...sample(), fleet: { ...sample().fleet, topTools: [{ tool: 7, calls: 1 }] } },
      { ...sample(), fleet: { ...sample().fleet, topTools: 'Bash' } },
    ];
    for (const value of cases) expect(isFleetVitalsSample(value)).toBe(false);
  });
});

describe('history points', () => {
  test('a point needs a time and a tool-call count; the token rates may be null', () => {
    expect(isFleetVitalsHistoryPoint(point())).toBe(true);
    expect(isFleetVitalsHistoryPoint(point({ gen: null, read: null }))).toBe(true);
    expect(isFleetVitalsHistoryPoint({ ...point(), tools: null })).toBe(false);
    expect(isFleetVitalsHistoryPoint({ ...point(), t: 'now' })).toBe(false);
    expect(isFleetVitalsHistoryPoint({ ...point(), gen: 'x' })).toBe(false);
  });

  test('sanitizing keeps the valid points and survives a non-array', () => {
    expect(sanitizeFleetVitalsHistory([point({ t: 1 }), { t: 'bad' }, point({ t: 3 })]).map((p) => p.t)).toEqual([1, 3]);
    expect(sanitizeFleetVitalsHistory({ nope: true })).toEqual([]);
  });
});

describe('staleness', () => {
  test('readings are out of date after ten seconds without a sample, or before the first', () => {
    expect(isFleetVitalsStale(null, 1_000)).toBe(true);
    expect(isFleetVitalsStale(1_000, 11_000)).toBe(false);
    expect(isFleetVitalsStale(1_000, 11_001)).toBe(true);
  });
});

describe('pressure levels', () => {
  test('CPU is busy from 85 % and saturated from 95 %', () => {
    expect(cpuLevel(sample({ cpu: 84.9 }))).toBe('ok');
    expect(cpuLevel(sample({ cpu: 85 }))).toBe('watch');
    expect(cpuLevel(sample({ cpu: 95 }))).toBe('bad');
    expect(cpuLevel(sample({ cpu: null }))).toBe('unknown');
  });

  test('memory is tight from 90 %, and full only with under 1 GB really free', () => {
    expect(ramLevel(sample({ ramPercent: 89 }))).toBe('ok');
    expect(ramLevel(sample({ ramPercent: 91 }))).toBe('watch');
    // 96 % "used" but 1.2 GB free: the estimate counts cache as used, so stay at tight.
    expect(ramLevel(sample({ ramPercent: 96, ramUsedBytes: 29.8 * GIB, ramTotalBytes: 31 * GIB }))).toBe('watch');
    expect(ramLevel(sample({ ramPercent: 98, ramUsedBytes: 30.4 * GIB, ramTotalBytes: 31 * GIB }))).toBe('bad');
    // Unknown byte counts cannot confirm "full".
    expect(ramLevel(sample({ ramPercent: 98, ramUsedBytes: null }))).toBe('watch');
  });

  test('video memory is tight from 90 % and nearly full from 97 %', () => {
    expect(vramLevel(sample({ vramPercent: 89 }))).toBe('ok');
    expect(vramLevel(sample({ vramPercent: 90 }))).toBe('watch');
    expect(vramLevel(sample({ vramPercent: 97 }))).toBe('bad');
    expect(vramLevel(sample({ gpu: null }))).toBe('unknown');
  });

  test('dashboard lag is slow from 150 ms and very slow from 500 ms', () => {
    expect(lagLevel(sample({ lag: 149 }))).toBe('ok');
    expect(lagLevel(sample({ lag: 150 }))).toBe('watch');
    expect(lagLevel(sample({ lag: 640 }))).toBe('bad');
  });

  test('GPU load is never a problem, even at 100 %', () => {
    expect(gpuLoadLevel(sample({ gpuLoad: 100 }))).toBe('ok');
    expect(gpuLoadLevel(sample({ gpu: null }))).toBe('unknown');
    expect(fleetVitalsIssues(sample({ gpuLoad: 100 }))).toEqual([]);
  });
});

describe('fleetVitalsVerdict', () => {
  test('a calm machine is "comfortable" and names its tightest resource', () => {
    expect(fleetVitalsVerdict(sample())).toEqual({
      level: 'ok',
      headline: 'Machine comfortable',
      detail: 'Tightest: CPU 66%',
      issues: [],
    });
  });

  test('the tightest resource is the highest share among CPU, RAM and VRAM, never GPU load', () => {
    expect(fleetVitalsVerdict(sample({ cpu: 20, ramPercent: 32, vramPercent: 71, gpuLoad: 99 })).detail)
      .toBe('Tightest: VRAM 71%');
    expect(fleetVitalsVerdict(sample({ cpu: 20, ramPercent: 32, gpu: null })).detail).toBe('Tightest: RAM 32%');
  });

  test('names what is under pressure, worst first', () => {
    const verdict = fleetVitalsVerdict(sample({ cpu: 88, vramPercent: 97 }));
    expect(verdict.level).toBe('bad');
    expect(verdict.headline).toBe('VRAM nearly full, CPU busy');
    // The headline names the problem; "tightest" would only repeat it.
    expect(verdict.detail).toBeNull();
    expect(verdict.issues.map((issue) => `${issue.resource}:${issue.level}`)).toEqual(['vram:bad', 'cpu:watch']);
  });

  test('a single amber reading gives an amber verdict', () => {
    const verdict = fleetVitalsVerdict(sample({ cpu: 90 }));
    expect(verdict.level).toBe('watch');
    expect(verdict.headline).toBe('CPU busy');
  });

  test('the pressure sheet case: CPU 96 %, VRAM 23.3 of 24 GB, lag 640 ms', () => {
    const verdict = fleetVitalsVerdict(sample({ cpu: 96, vramPercent: 97.1, lag: 640 }));
    expect(verdict.level).toBe('bad');
    expect(verdict.headline).toBe('CPU saturated, VRAM nearly full');
    // The one issue that did not fit is named, not counted.
    expect(verdict.detail).toBe('+ dashboard very slow');
    expect(verdict.issues).toHaveLength(3);
    const four = fleetVitalsVerdict(sample({ cpu: 96, ramPercent: 92, vramPercent: 97.1, lag: 640 }));
    expect(four.headline).toBe('CPU saturated, VRAM nearly full');
    expect(four.detail).toBe('+2 more');
  });

  test('lowercases a second phrase but keeps acronyms', () => {
    const verdict = fleetVitalsVerdict(sample({ cpu: 96, ramPercent: 92 }));
    expect(verdict.headline).toBe('CPU saturated, memory tight');
  });

  test('says "measuring" when nothing has been measured yet', () => {
    expect(fleetVitalsVerdict(sample({ cpu: null, ramPercent: null, gpu: null, lag: null }))).toEqual({
      level: 'unknown',
      headline: 'Measuring',
      detail: null,
      issues: [],
    });
  });

  test('a machine whose CPU is not measured yet is not called comfortable', () => {
    const verdict = fleetVitalsVerdict(sample({ cpu: null }));
    expect(verdict.level).toBe('unknown');
    expect(verdict.headline).toBe('Measuring');
  });

  test('a slow dashboard is reported even when the machine readings are unknown', () => {
    const verdict = fleetVitalsVerdict(sample({ cpu: null, ramPercent: null, gpu: null, lag: 800 }));
    expect(verdict.level).toBe('bad');
    expect(verdict.headline).toBe('Dashboard very slow');
    expect(verdict.detail).toBeNull();
  });
});

describe('formatting', () => {
  test('percentages round, and an unmeasured value is "--", never 0', () => {
    expect(formatVitalsPercent(65.6)).toBe('66%');
    expect(formatVitalsPercent(0)).toBe('0%');
    expect(formatVitalsPercent(null)).toBe('--');
    expect(formatVitalsPercent(undefined)).toBe('--');
  });

  test('counts stay short at every magnitude', () => {
    expect(formatVitalsCount(0)).toBe('0');
    expect(formatVitalsCount(110.4)).toBe('110');
    expect(formatVitalsCount(999.6)).toBe('1.0k');
    expect(formatVitalsCount(1_840)).toBe('1.8k');
    expect(formatVitalsCount(13_860)).toBe('13.9k');
    expect(formatVitalsCount(240_000)).toBe('240k');
    expect(formatVitalsCount(1_250_000)).toBe('1.3M');
    expect(formatVitalsCount(null)).toBe('--');
  });

  test('a lower bound carries its sign on the number, except at zero', () => {
    expect(formatVitalsLowerBound(110)).toBe('≥110');
    expect(formatVitalsLowerBound(13_860)).toBe('≥13.9k');
    expect(formatVitalsLowerBound(0)).toBe('0');
    expect(formatVitalsLowerBound(0.3)).toBe('0');
    expect(formatVitalsLowerBound(null)).toBe('--');
  });

  test('an amount against its limit', () => {
    expect(formatVitalsBytesOfTotal(2.5 * GIB, 24 * GIB)).toBe('2.5 / 24 GB');
    expect(formatVitalsBytesOfTotal(10 * GIB, 31 * GIB)).toBe('10 / 31 GB');
    // Close to the limit, the decimal is what matters.
    expect(formatVitalsBytesOfTotal(23.3 * GIB, 24 * GIB)).toBe('23.3 / 24 GB');
    expect(formatVitalsBytesOfTotal(54 * GIB, 503 * GIB)).toBe('54 / 503 GB');
    expect(formatVitalsBytesOfTotal(120.4 * GIB, 503 * GIB)).toBe('120 / 503 GB');
    expect(formatVitalsBytesOfTotal(310 * 1_048_576, 512 * 1_048_576)).toBe('310 / 512 MB');
    expect(formatVitalsBytesOfTotal(null, 24 * GIB)).toBe('--');
  });

  test('cached share of the tokens read', () => {
    expect(Math.round(cachedReadShare(sample()) ?? -1)).toBe(98);
    expect(cachedReadShare(sample({ tokens: null }))).toBeNull();
    expect(cachedReadShare(sample({ tokens: { generatedPerSec: 0, readPerSec: 0, cacheReadPerSec: 0 } }))).toBeNull();
  });

  test('GPU names lose the vendor prefix', () => {
    expect(shortGpuName('NVIDIA GeForce RTX 3090')).toBe('RTX 3090');
    expect(shortGpuName('NVIDIA RTX A6000')).toBe('RTX A6000');
    expect(shortGpuName('Tesla T4')).toBe('Tesla T4');
    expect(shortGpuName(null)).toBeNull();
  });
});

describe('trend lines', () => {
  test('a series is read out of the history in order, nulls kept', () => {
    const history = [point({ gen: 10 }), point({ gen: null }), point({ gen: 30 })];
    expect(vitalsSeries(history, 'gen')).toEqual([10, null, 30]);
    expect(seriesPeak([10, null, 30])).toBe(30);
    expect(seriesPeak([null, null])).toBeNull();
    expect(seriesPeak([])).toBeNull();
  });

  test('the line starts from a zero baseline and its top is the peak', () => {
    // 20 px tall box: y = 19 is zero, y = 1 is the peak.
    expect(sparklinePath([0, 50, 100], 100, 20)).toBe('M0.0 19.0L50.0 10.0L100.0 1.0');
  });

  test('an idle fleet draws a flat line on the floor, not magnified noise', () => {
    expect(sparklinePath([0, 0, 0], 100, 20)).toBe('M0.0 19.0L50.0 19.0L100.0 19.0');
  });

  test('an unmeasured point breaks the line', () => {
    expect(sparklinePath([10, null, 10], 100, 20)).toBe('M0.0 1.0M100.0 1.0');
  });

  test('a buffer that is still filling is right-aligned: the newest point is at the right edge', () => {
    // Two points in a five-slot window occupy the last two slots.
    expect(sparklinePath([100, 100], 100, 20, 5)).toBe('M75.0 1.0L100.0 1.0');
  });

  test('the window label says how much time the lines really cover', () => {
    expect(historyWindowLabel([])).toBe('Just started');
    expect(historyWindowLabel([point({ t: 0 })])).toBe('Just started');
    expect(historyWindowLabel([point({ t: 0 }), point({ t: 40_000 })])).toBe('Last 40 s');
    expect(historyWindowLabel([point({ t: 0 }), point({ t: 130_000 })])).toBe('Last 2 min');
    // A full buffer: 150 samples two seconds apart.
    expect(historyWindowLabel([point({ t: 0 }), point({ t: 298_000 })])).toBe('Last 5 min');
  });

  test('the end of the line is where the current value sits on the same scale', () => {
    // Current value 50 with a peak of 100 in a 20 px box: halfway between y = 19 and y = 1.
    expect(sparklineEnd([0, 100, 50], 20)).toEqual({ xPercent: 100, y: 10 });
    expect(sparklineEnd([0, 0, 0], 20)).toEqual({ xPercent: 100, y: 19 });
    expect(sparklineEnd([10, null], 20)).toBeNull();
    expect(sparklineEnd([], 20)).toBeNull();
  });

  test('nothing to draw gives an empty path', () => {
    expect(sparklinePath([], 100, 20)).toBe('');
    expect(sparklinePath([null, null], 100, 20)).toBe('');
  });
});
