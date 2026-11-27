// @vitest-environment happy-dom

/**
 * The vitals block (System detail) and the opt-in vitals strip (top bar).
 * What each state shows, in words a user would read, and the rules the design
 * settled on: neutral at rest, a problem names itself, unmeasured is "--".
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FleetVitalsBlock,
  FleetVitalsStrip,
  fleetVitalsStripCells,
  visibleStripCells,
  type VitalsStripDensity,
} from './FleetVitals.js';
import { systemAttentionReasons, SystemStatusDetails } from './SystemStatusDetails.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import {
  VITALS_PINNED_STORAGE_KEY,
  __resetVitalsPinnedForTests,
  setVitalsPinned,
} from '../vitals-pin-preference.js';
import { __resetAudioAlertLogForTests } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';
import type { FleetVitalsHistoryPoint, FleetVitalsSample, SystemResourceStatus } from '../../shared/protocol.js';

const GIB = 1_073_741_824;

interface Overrides {
  cpu?: number | null;
  ramPercent?: number;
  gpu?: boolean;
  gpuLoad?: number;
  vramPercent?: number;
  lag?: number | null;
  agents?: number;
  subagents?: number;
  tokens?: FleetVitalsSample['fleet']['tokens'];
  toolCallsPerMin?: number;
}

function sample(overrides: Overrides = {}): FleetVitalsSample {
  const vramPercent = overrides.vramPercent ?? 10;
  const ramPercent = overrides.ramPercent ?? 32;
  return {
    sampledAtMs: 1_790_000_000_000,
    machine: {
      cpuUsagePercent: 'cpu' in overrides ? overrides.cpu ?? null : 66,
      loadAverage1m: 18.2,
      logicalCpuCount: 24,
      memoryUsedPercent: ramPercent,
      memoryUsedBytes: (ramPercent / 100) * 31 * GIB,
      memoryTotalBytes: 31 * GIB,
      gpu: overrides.gpu === false
        ? null
        : {
            name: 'NVIDIA GeForce RTX 3090',
            deviceCount: 1,
            utilizationPercent: overrides.gpuLoad ?? 24,
            memoryUsedBytes: (vramPercent / 100) * 24 * GIB,
            memoryTotalBytes: 24 * GIB,
            memoryUsedPercent: vramPercent,
            temperatureC: 48,
            powerWatts: 32,
          },
      gpuUnavailable: overrides.gpu === false ? 'not_installed' : null,
      serverLoopDelayP95Ms: 'lag' in overrides ? overrides.lag ?? null : 123,
    },
    fleet: {
      agents: overrides.agents ?? 9,
      subagents: overrides.subagents ?? 6,
      tokens: 'tokens' in overrides
        ? overrides.tokens ?? null
        : { generatedPerSec: 110, readPerSec: 13_860, cacheReadPerSec: 13_525 },
      toolCallsPerMin: overrides.toolCallsPerMin ?? 26,
      topTools: [{ tool: 'Bash', calls: 19 }, { tool: 'Read', calls: 4 }],
    },
  };
}

/** Five minutes of history whose peaks are 240 tok/s generated, 31k read, 71 tool calls. */
function history(): FleetVitalsHistoryPoint[] {
  return Array.from({ length: 150 }, (_, index) => ({
    t: 1_790_000_000_000 - (149 - index) * 2_000,
    gen: index === 40 ? 240 : 110,
    read: index === 40 ? 31_000 : 13_860,
    tools: index === 40 ? 71 : 26,
  }));
}

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  useKookrStore.setState(Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  ));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response));
  __resetVitalsPinnedForTests();
  __resetSoundPreferenceForTests();
  __resetAudioAlertLogForTests();
  syncGlobalStore();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function feed(next: FleetVitalsSample, points: FleetVitalsHistoryPoint[] = history()): void {
  act(() => useKookrStore.getState().handleFleetVitals(next, points, Date.now()));
}

function renderBlock(props: { needYouCount?: number } = {}): void {
  act(() => root.render(React.createElement(FleetVitalsBlock, props)));
}

function renderStrip(density: VitalsStripDensity = 'full', onOpen: () => void = () => undefined): void {
  act(() => root.render(React.createElement(FleetVitalsStrip, { onOpen, density })));
}

const text = (selector: string): string => container.querySelector(selector)?.textContent ?? '';
const meters = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('.vitals-meter-track'));
/** What a screen reader says for a meter: its name, then its value text. */
const spokenMeters = (): string[] =>
  meters().map((meter) => `${meter.getAttribute('aria-label')}: ${meter.getAttribute('aria-valuetext')}`);
const rateLabels = (): string[] =>
  Array.from(container.querySelectorAll('.vitals-rate')).map((row) => row.getAttribute('aria-label') ?? '');

describe('FleetVitalsBlock', () => {
  test('shows nothing until the first sample arrives', () => {
    renderBlock();
    expect(container.querySelector('[data-testid="fleet-vitals"]')).toBeNull();
  });

  test('a calm machine: verdict, four meters in fixed order, one running count, three rates', () => {
    feed(sample());
    renderBlock();

    expect(text('.vitals-verdict-headline')).toBe('Machine comfortable');
    expect(text('.vitals-verdict-detail')).toBe('Tightest: CPU 66%');
    expect(container.querySelector('.vitals-verdict')?.className).toContain('vitals-verdict--ok');

    expect(spokenMeters()).toEqual([
      'CPU: 66%, load 18.2',
      'RAM: 32%, 9.9 / 31 GB',
      'GPU: 24%, 48 °C',
      'VRAM: 10%, 2.4 / 24 GB',
    ]);
    expect(meters().map((meter) => meter.getAttribute('role'))).toEqual(['meter', 'meter', 'meter', 'meter']);
    expect(meters().map((meter) => meter.getAttribute('aria-valuenow'))).toEqual(['66', '32', '24', '10']);
    // Only the state is a live region: the figures beside it change with every sample.
    expect(container.querySelector('.vitals-verdict-headline')?.getAttribute('role')).toBe('status');
    expect(container.querySelector('.vitals-verdict')?.hasAttribute('role')).toBe(false);
    expect(container.querySelector('.vitals-verdict-detail')?.closest('[role="status"]')).toBeNull();
    // Neutral at rest: no meter carries a state class.
    expect(container.querySelectorAll('.vitals-meter--watch, .vitals-meter--bad')).toHaveLength(0);

    expect(text('.vitals-running-count')).toBe('15');
    expect(text('.vitals-split')).toBe('9 agents~6 subagents');

    expect(rateLabels()).toEqual([
      'Generated: at least 110 tokens per second, peak 240',
      'Read: at least 13.9k tokens per second, peak 31.0k',
      'Tool calls: 26 per minute, peak 71',
    ]);
    expect(Array.from(container.querySelectorAll('.vitals-rate-value')).map((el) => el.textContent)).toEqual([
      '≥110',
      '≥13.9k',
      '26',
    ]);
    expect(Array.from(container.querySelectorAll('.vitals-rate-unit')).map((el) => el.textContent)).toEqual([
      'tok/s',
      'tok/s',
      '/min',
    ]);
    expect(Array.from(container.querySelectorAll('.vitals-rate-scale')).map((el) => el.textContent)).toEqual([
      'peak 240',
      'peak 31.0k',
      'peak 71',
    ]);
    // Each line ends in a dot at the current value; tokens read is the quiet one.
    expect(container.querySelectorAll('.vitals-spark-end')).toHaveLength(3);
    expect(Array.from(container.querySelectorAll('.vitals-spark')).map((el) => el.className)).toEqual([
      'vitals-spark vitals-spark--fleet',
      'vitals-spark vitals-spark--quiet',
      'vitals-spark vitals-spark--fleet',
    ]);
    expect(text('.vitals-caption')).toBe('Last 5 min, each line 0 to its peak · 98% read from cache');
    expect(text('[data-testid="fleet-vitals-lag"]')).toBe('Dashboard lag123 ms');
  });

  test('the fill of each meter is its percentage, and judged meters carry a threshold tick', () => {
    feed(sample());
    renderBlock();
    const fills = Array.from(container.querySelectorAll<HTMLElement>('.vitals-meter-fill')).map((el) => el.style.width);
    expect(fills).toEqual(['66%', '32%', '24%', '10%']);
    const ticks = Array.from(container.querySelectorAll<HTMLElement>('.vitals-meter-tick')).map((el) => el.style.left);
    // CPU busy from 85 %, RAM and VRAM tight from 90 %. GPU load has no tick: it is never judged.
    expect(ticks).toEqual(['85%', '90%', '90%']);
  });

  test('findings waiting on the operator are shown beside the running count', () => {
    feed(sample());
    renderBlock({ needYouCount: 2 });
    expect(text('.vitals-split-item--need')).toBe('2 need you');
  });

  test('pressure: the verdict names it, the meters say the word, and lag is called slow', () => {
    feed(sample({ cpu: 96, vramPercent: 97.1, gpuLoad: 100, lag: 640 }));
    renderBlock();

    expect(container.querySelector('.vitals-verdict')?.className).toContain('vitals-verdict--bad');
    expect(text('.vitals-verdict-headline')).toBe('CPU saturated, VRAM nearly full');
    expect(text('.vitals-verdict-detail')).toBe('+ dashboard very slow');

    expect(spokenMeters()[0]).toBe('CPU: 96%, saturated, load 18.2');
    expect(spokenMeters()[3]).toBe('VRAM: 97%, nearly full, 23.3 / 24 GB');
    const classes = Array.from(container.querySelectorAll('.vitals-meter')).map((el) => el.className);
    expect(classes[0]).toContain('vitals-meter--bad');
    expect(classes[3]).toContain('vitals-meter--bad');
    // GPU at 100 % is a busy GPU, not a problem.
    expect(classes[2]).toContain('vitals-meter--ok');
    // The amounts stay on screen under pressure: how much is left is the point.
    expect(Array.from(container.querySelectorAll('.vitals-meter-detail')).map((el) => el.textContent)).toEqual([
      'load 18.2',
      '9.9 / 31 GB',
      '48 °C',
      '23.3 / 24 GB',
    ]);
    // A state colour never stands alone: each problem meter also has a mark.
    expect(container.querySelectorAll('.vitals-meter--bad .vitals-mark--bad')).toHaveLength(2);

    expect(text('[data-testid="fleet-vitals-lag"]')).toBe('Dashboard very slow640 ms');
  });

  test('a machine without a GPU has two meters and no GPU wording', () => {
    feed(sample({ gpu: false }));
    renderBlock();
    expect(spokenMeters()).toEqual(['CPU: 66%, load 18.2', 'RAM: 32%, 9.9 / 31 GB']);
    expect(container.textContent).not.toContain('VRAM');

    // Details says why, so an absent GPU is not mistaken for a broken panel.
    const toggle = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Details')!;
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(text('[data-testid="fleet-vitals-details"] dl')).toContain('GPUNo NVIDIA GPU found');
  });

  test('just started: unmeasured readings are "--" and rates say they are warming up', () => {
    feed(sample({ cpu: null, tokens: null, toolCallsPerMin: 0, lag: null }), []);
    renderBlock();
    expect(text('.vitals-verdict-headline')).toBe('Measuring');
    // A meter must have a current value: an unmeasured reading is a named picture instead.
    expect(meters()[0].getAttribute('role')).toBe('img');
    expect(meters()[0].getAttribute('aria-label')).toBe('CPU: not measured yet, load 18.2');
    expect(meters()[0].hasAttribute('aria-valuenow')).toBe(false);
    expect(container.querySelector('.vitals-meter-fill')?.closest('.vitals-meter')?.querySelector('.vitals-meter-label')?.textContent)
      .toBe('RAM');
    expect(container.querySelector('.vitals-meter-value')?.textContent).toBe('--');
    expect(rateLabels().slice(0, 2)).toEqual(['Generated: warming up', 'Read: warming up']);
    expect(text('.vitals-rate-scale')).toBe('warming up');
    expect(text('.vitals-caption')).toBe('Just started, each line 0 to its peak');
    expect(text('[data-testid="fleet-vitals-lag"]')).toBe('Dashboard lag--');
  });

  test('an idle fleet reads zero, without a lower-bound sign', () => {
    const idle = sample({ agents: 0, subagents: 0, tokens: { generatedPerSec: 0, readPerSec: 0, cacheReadPerSec: 0 }, toolCallsPerMin: 0 });
    feed(idle, history().map((point) => ({ ...point, gen: 0, read: 0, tools: 0 })));
    renderBlock();
    expect(text('[data-testid="fleet-vitals-running"]')).toBe('0running');
    expect(Array.from(container.querySelectorAll('.vitals-rate-value')).map((el) => el.textContent)).toEqual(['0', '0', '0']);
    // An idle fleet is drawn quiet: no teal line for work that is not happening.
    expect(container.querySelectorAll('.vitals-spark--fleet')).toHaveLength(0);
    expect(rateLabels()[0]).toBe('Generated: 0 tokens per second');
    expect(Array.from(container.querySelectorAll('.vitals-rate-scale')).map((el) => el.textContent)).toEqual([
      'all zero',
      'all zero',
      'all zero',
    ]);
    // Nothing was read, so no cache share is claimed.
    expect(text('.vitals-caption')).toBe('Last 5 min, each line 0 to its peak');
  });

  test('without a fresh sample for ten seconds the block says how old the readings are', () => {
    vi.useFakeTimers();
    feed(sample());
    renderBlock();
    expect(container.querySelector('.vitals')?.className).not.toContain('vitals--stale');

    act(() => { vi.advanceTimersByTime(12_000); });

    expect(container.querySelector('.vitals')?.className).toContain('vitals--stale');
    // The live region says the state once; the ticking age sits outside it.
    expect(text('.vitals-verdict-headline')).toBe('Readings are old');
    expect(text('.vitals-verdict-detail')).toMatch(/^1[0-3] s, last values shown$/);

    // A new sample makes it current again.
    feed(sample());
    expect(container.querySelector('.vitals')?.className).not.toContain('vitals--stale');
    expect(text('.vitals-verdict-headline')).toBe('Machine comfortable');
  });

  test('Details opens the secondary readings and the explanation of the signs', () => {
    feed(sample());
    act(() => useKookrStore.getState().handleResourceStatus({
      source: { kind: 'server-host' },
      sampledAt: new Date().toISOString(),
      sampleGapMs: 2_000,
      timerDriftMs: 0,
      host: {
        cpuUsagePercent: 66,
        memoryUsedPercent: 32,
        memoryFreeBytes: 21 * GIB,
        memoryTotalBytes: 31 * GIB,
        dataDirectory: { path: '/data', diskFreeBytes: 54 * GIB, diskTotalBytes: 503 * GIB, diskFreePercent: 11 },
      },
      server: { eventLoopDelayP95Ms: 123, processRssBytes: 964 * 1_048_576, processHeapUsedBytes: 1, processHeapTotalBytes: 2 },
      unavailable: [],
    } as SystemResourceStatus, Date.now()));
    renderBlock();

    const toggle = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Details')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="fleet-vitals-details"]')).toBeNull();

    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = container.querySelector('[data-testid="fleet-vitals-details"]')!;
    expect(toggle.getAttribute('aria-controls')).toBe(details.id);
    const rows = Array.from(details.querySelectorAll('dt')).map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`);
    expect(rows).toEqual([
      'Load average: 18.2 over 24 cores',
      'GPU: RTX 3090 · 48 °C · 32 W',
      'Disk free: 54 GB of 503 GB',
      'Kookr memory: 964 MB',
      'Tokens read: 13.5k/s from cache · 335/s new',
      'Tools, last min: Bash 19 · Read 4',
    ]);
    expect(text('.vitals-note')).toContain('≥ marks a lower bound');
  });

  test('the pin switch is off by default, and turning it on is remembered', () => {
    feed(sample());
    renderBlock();
    const pin = container.querySelector<HTMLButtonElement>('[data-testid="fleet-vitals-pin"]')!;
    expect(pin.getAttribute('role')).toBe('switch');
    expect(pin.getAttribute('aria-checked')).toBe('false');

    act(() => pin.click());
    expect(pin.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(VITALS_PINNED_STORAGE_KEY)).toBe('true');

    act(() => pin.click());
    expect(pin.getAttribute('aria-checked')).toBe('false');
    expect(localStorage.getItem(VITALS_PINNED_STORAGE_KEY)).toBeNull();
  });
});

describe('FleetVitalsStrip', () => {
  const cellText = (): string[] =>
    Array.from(container.querySelectorAll('.vitals-cell')).map((cell) => cell.textContent ?? '');

  test('is not shown unless the operator pinned it', () => {
    feed(sample());
    renderStrip();
    expect(container.querySelector('[data-testid="fleet-vitals-strip"]')).toBeNull();

    act(() => setVitalsPinned(true));
    expect(container.querySelector('[data-testid="fleet-vitals-strip"]')).not.toBeNull();
  });

  test('at rest: five neutral cells, video memory always its own cell', () => {
    act(() => setVitalsPinned(true));
    feed(sample());
    renderStrip();
    expect(cellText()).toEqual(['CPU66%', 'GPU24%', 'VRAM10%', 'Running15', 'tok/s≥110']);
    expect(container.querySelectorAll('.vitals-cell--watch, .vitals-cell--bad')).toHaveLength(0);
    expect(container.querySelector('[data-testid="fleet-vitals-strip"]')?.getAttribute('aria-label')).toBe(
      'Vitals: CPU 66%, GPU load 24%, video memory 10%, 15 running, at least 110 tokens generated per second. Open System detail',
    );
  });

  test('opens the System detail when clicked', () => {
    act(() => setVitalsPinned(true));
    feed(sample());
    const onOpen = vi.fn();
    renderStrip('full', onOpen);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="fleet-vitals-strip"]')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('under pressure the cell in trouble names itself, and memory and lag get a cell', () => {
    act(() => setVitalsPinned(true));
    feed(sample({ cpu: 96, ramPercent: 92, vramPercent: 97.1, gpuLoad: 100, lag: 640 }));
    renderStrip();
    expect(cellText()).toEqual(['RAM92%', 'Lag640 ms', 'CPU96%', 'GPU100%', 'VRAM97%', 'Running15', 'tok/s≥110']);
    const state = (key: string) => container.querySelector(`[data-vitals-cell="${key}"]`)?.className ?? '';
    expect(state('cpu')).toContain('vitals-cell--bad');
    expect(state('vram')).toContain('vitals-cell--bad');
    expect(state('ram')).toContain('vitals-cell--watch');
    expect(state('lag')).toContain('vitals-cell--bad');
    // A busy GPU is not a problem.
    expect(state('gpu')).toContain('vitals-cell--ok');
    // Each problem cell has a mark as well as a tint.
    expect(container.querySelectorAll('.vitals-cell--bad .vitals-mark--bad')).toHaveLength(3);
    expect(container.querySelectorAll('.vitals-cell--watch .vitals-mark--watch')).toHaveLength(1);
  });

  test('a machine without a GPU has no GPU or VRAM cell', () => {
    act(() => setVitalsPinned(true));
    feed(sample({ gpu: false }));
    renderStrip();
    expect(cellText()).toEqual(['CPU66%', 'Running15', 'tok/s≥110']);
  });

  test('a narrower top bar drops the fleet cells first', () => {
    act(() => setVitalsPinned(true));
    feed(sample());
    renderStrip('machine');
    expect(cellText()).toEqual(['CPU66%', 'GPU24%', 'VRAM10%']);
    expect(container.querySelector('.vitals-strip-sep')).toBeNull();
  });

  test('a cramped top bar shows only what needs a look, and nothing at rest', () => {
    act(() => setVitalsPinned(true));
    feed(sample());
    renderStrip('alerts');
    expect(container.querySelector('[data-testid="fleet-vitals-strip"]')).toBeNull();

    feed(sample({ vramPercent: 93 }));
    expect(cellText()).toEqual(['VRAM93%']);
    // The spoken label still gives every reading.
    expect(container.querySelector('[data-testid="fleet-vitals-strip"]')?.getAttribute('aria-label')).toContain('CPU 66%');
  });

  test('out-of-date readings are flagged with their age', () => {
    vi.useFakeTimers();
    act(() => setVitalsPinned(true));
    feed(sample());
    renderStrip();
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(cellText()[0]).toMatch(/^Old1[0-3]s$/);
    expect(container.querySelector('[data-testid="fleet-vitals-strip"]')?.className).toContain('vitals-strip--stale');
  });

  test('cell rules as plain data', () => {
    const cells = fleetVitalsStripCells(sample({ vramPercent: 93 }), null);
    expect(cells.map((cell) => `${cell.key}:${cell.level}:${cell.group}`)).toEqual([
      'cpu:ok:machine',
      'gpu:ok:machine',
      'vram:watch:machine',
      'running:ok:fleet',
      'tokens:ok:fleet',
    ]);
    expect(visibleStripCells(cells, 'alerts').map((cell) => cell.key)).toEqual(['vram']);
    // When only one cell fits: red before amber, and video memory before CPU at the same level.
    const many = fleetVitalsStripCells(sample({ cpu: 96, ramPercent: 92, vramPercent: 98, lag: 200 }), null);
    expect(visibleStripCells(many, 'alerts').map((cell) => cell.key)).toEqual(['ram', 'lag', 'cpu', 'vram']);
    expect(visibleStripCells(many, 'worst').map((cell) => cell.key)).toEqual(['vram']);
    const amberOnly = fleetVitalsStripCells(sample({ cpu: 88, ramPercent: 92 }), 12);
    expect(visibleStripCells(amberOnly, 'worst').map((cell) => cell.key)).toEqual(['cpu']);
    expect(visibleStripCells(fleetVitalsStripCells(sample(), null), 'worst')).toEqual([]);
    expect(visibleStripCells(cells, 'machine').map((cell) => cell.key)).toEqual(['cpu', 'gpu', 'vram']);
    // Rates still warming up: the token cell is "--", not zero.
    const warming = fleetVitalsStripCells(sample({ tokens: null }), 12);
    expect(warming[0]).toMatchObject({ key: 'stale', value: '12s', level: 'stale' });
    expect(warming[warming.length - 1]).toMatchObject({ key: 'tokens', value: '--', level: 'unknown' });
  });
});

describe('vitals in the store', () => {
  const state = () => useKookrStore.getState();
  const at = (sampledAtMs: number, generatedPerSec: number): FleetVitalsSample => {
    const next = sample({ tokens: { generatedPerSec, readPerSec: 1_000, cacheReadPerSec: 900 } });
    return { ...next, sampledAtMs };
  };

  test('the connection burst replaces the history; each later sample appends one point', () => {
    const burst = history();
    act(() => state().handleFleetVitals(at(burst[149].t, 110), burst, 5_000));
    expect(state().fleetVitalsHistory).toHaveLength(150);
    expect(state().fleetVitalsReceivedAtMs).toBe(5_000);

    // A tick carries no history: its point is appended and the oldest one drops off.
    const tick = at(burst[149].t + 2_000, 321);
    act(() => state().handleFleetVitals(tick, undefined, 7_000));
    const points = state().fleetVitalsHistory;
    expect(points).toHaveLength(150);
    expect(points[149]).toEqual({ t: burst[149].t + 2_000, gen: 321, read: 1_000, tools: 26 });
    expect(points[0].t).toBe(burst[1].t);
    expect(state().fleetVitals).toBe(tick);
    expect(state().fleetVitalsReceivedAtMs).toBe(7_000);
  });

  test('a repeated or out-of-order sample updates the readings without charting a second point', () => {
    act(() => state().handleFleetVitals(at(10_000, 100), [], 1));
    act(() => state().handleFleetVitals(at(12_000, 200), undefined, 2));
    expect(state().fleetVitalsHistory.map((point) => point.gen)).toEqual([200]);

    // The same instant again (a reconnect can replay it), then an older one.
    act(() => state().handleFleetVitals(at(12_000, 300), undefined, 3));
    act(() => state().handleFleetVitals(at(11_000, 400), undefined, 4));
    expect(state().fleetVitalsHistory.map((point) => point.gen)).toEqual([200]);
    expect(state().fleetVitals?.fleet.tokens?.generatedPerSec).toBe(400);
    expect(state().fleetVitalsReceivedAtMs).toBe(4);
  });

  test('a burst longer than five minutes is cut to its newest 150 points', () => {
    const long = Array.from({ length: 180 }, (_, index) => ({ t: index * 2_000, gen: index, read: 0, tools: 0 }));
    act(() => state().handleFleetVitals(at(long[179].t, 179), long, 1));
    const points = state().fleetVitalsHistory;
    expect(points).toHaveLength(150);
    expect(points[0].gen).toBe(30);
    expect(points[149].gen).toBe(179);
  });
});

describe('System indicator and detail', () => {
  test('a full video memory is a reason for the System indicator to ask for a look', () => {
    expect(systemAttentionReasons({ vramLevel: 'bad' })).toEqual(['GPU memory nearly full']);
    expect(systemAttentionReasons({ vramLevel: 'watch' })).toEqual(['GPU memory tight']);
    expect(systemAttentionReasons({ vramLevel: 'ok' })).toEqual([]);
    expect(systemAttentionReasons({ vramLevel: 'unknown' })).toEqual([]);
    expect(systemAttentionReasons({})).toEqual([]);
  });

  test('the old CPU and RAM pills give way once vitals have arrived', () => {
    const status = {
      source: { kind: 'server-host' },
      sampledAt: new Date().toISOString(),
      sampleGapMs: 2_000,
      timerDriftMs: 0,
      host: {
        cpuUsagePercent: 42,
        memoryUsedPercent: 68,
        memoryFreeBytes: 4 * GIB,
        memoryTotalBytes: 12 * GIB,
        dataDirectory: { path: '/data', diskFreeBytes: 50 * GIB, diskTotalBytes: 100 * GIB, diskFreePercent: 50 },
      },
      server: { eventLoopDelayP95Ms: 21, processRssBytes: 1, processHeapUsedBytes: 1, processHeapTotalBytes: 2 },
      unavailable: [],
    } as SystemResourceStatus;
    act(() => useKookrStore.getState().handleResourceStatus(status, Date.now()));
    act(() => root.render(React.createElement(SystemStatusDetails, {})));
    expect(container.querySelector('.resource-status')).not.toBeNull();

    feed(sample());
    expect(container.querySelector('.resource-status')).toBeNull();

    // The resource sampler starts failing: the pills come back, because their
    // detail is what says the values are the last good sample.
    act(() => useKookrStore.getState().handleResourceStatus({
      ...status,
      stale: { reason: 'sampler_error', lastGoodAt: status.sampledAt, ageMs: 30_000 },
    } as SystemResourceStatus, Date.now()));
    expect(container.querySelector('.resource-status')).not.toBeNull();

    // It recovers: the vitals block is enough again.
    act(() => useKookrStore.getState().handleResourceStatus(status, Date.now()));
    expect(container.querySelector('.resource-status')).toBeNull();
  });
});
