import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import {
  FLEET_VITALS_HISTORY_POINTS,
  type FleetVitalsHistoryPoint,
  type FleetVitalsSample,
} from '../../shared/protocol.js';
import {
  FLEET_VITALS_STALE_AFTER_MS,
  VITALS_UNAVAILABLE,
  cachedReadShare,
  cpuLevel,
  fleetVitalsVerdict,
  formatVitalsBytesOfTotal,
  formatVitalsCount,
  formatVitalsLowerBound,
  formatVitalsPercent,
  gpuLoadLevel,
  historyWindowLabel,
  isFleetVitalsStale,
  lagLevel,
  ramLevel,
  seriesPeak,
  shortGpuName,
  sparklineEnd,
  sparklinePath,
  vitalsSeries,
  vramLevel,
  type VitalsLevel,
  type VitalsSeries,
} from '../fleet-vitals.js';
import { formatBytes } from '../resource-status.js';
import { setVitalsPinned, useVitalsPinned } from '../vitals-pin-preference.js';
import './FleetVitals.css';

/*
 * Machine + fleet vitals.
 *
 * Two forms of the same readings:
 * - `FleetVitalsBlock`, at the top of the System detail, for everyone: a
 *   one-line verdict, four machine meters, how much is running, and three
 *   five-minute trend lines.
 * - `FleetVitalsStrip`, a few numbers in the top bar, only when the operator
 *   pinned it. At rest it is neutral text; under pressure the cell that is in
 *   trouble names itself.
 *
 * Colour is used for state only (amber: watch, red: bad), always with a mark
 * shape and words. GPU load is shown and never coloured: a busy GPU is the
 * normal state of a training or inference run.
 */

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 18;

/** Where each meter starts to count as under pressure; drawn as a small tick on the track. */
const CPU_WATCH_PERCENT = 85;
const RAM_WATCH_PERCENT = 90;
const VRAM_WATCH_PERCENT = 90;

/**
 * Whether the latest vitals sample is out of date, re-evaluated as time passes:
 * one timeout fires when the sample crosses the threshold, so a frozen feed
 * flips to "old" without a new store update.
 */
export function useFleetVitalsStale(): boolean {
  const receivedAtMs = useKookrStore((s) => s.fleetVitalsReceivedAtMs);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const stale = isFleetVitalsStale(receivedAtMs, nowMs);

  useEffect(() => {
    if (receivedAtMs == null) return;
    const now = Date.now();
    if (isFleetVitalsStale(receivedAtMs, now) !== stale) {
      setNowMs(now);
      return;
    }
    if (stale) return;
    const delayMs = receivedAtMs + FLEET_VITALS_STALE_AFTER_MS - now + 1;
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(0, delayMs));
    return () => clearTimeout(timer);
  }, [receivedAtMs, stale]);

  return stale;
}

/** Whole seconds since the latest sample arrived, ticking once a second while `active`. */
function useSecondsSinceSample(active: boolean): number | null {
  const receivedAtMs = useKookrStore((s) => s.fleetVitalsReceivedAtMs);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active, receivedAtMs]);
  if (receivedAtMs == null) return null;
  return Math.max(0, Math.round((nowMs - receivedAtMs) / 1_000));
}

/** State mark: ring = fine, dot = watch, diamond = bad, dash = unknown. The shape repeats what the colour says. */
function Mark({ level }: { level: VitalsLevel | 'stale' }) {
  return <span className={`vitals-mark vitals-mark--${level}`} aria-hidden="true" />;
}

function Meter({
  label,
  detail,
  percent,
  level,
  tickPercent,
  problem,
}: {
  label: string;
  detail: string;
  percent: number | null;
  level: VitalsLevel;
  /** Where "under pressure" starts; omitted for a reading that is never judged. */
  tickPercent?: number;
  /** Word spoken when the reading is under pressure: "busy", "nearly full". On screen the verdict line says it. */
  problem?: string;
}) {
  const value = formatVitalsPercent(percent);
  const pressured = level === 'watch' || level === 'bad';
  // What a screen reader says after the name: the value, the state word, the amount.
  const spoken = [percent === null ? 'not measured yet' : value, pressured ? problem : null, detail]
    .filter(Boolean)
    .join(', ');
  return (
    <div className={`vitals-meter vitals-meter--${level}`}>
      <div className="vitals-meter-head">
        {pressured && <Mark level={level} />}
        <span className="vitals-meter-label">{label}</span>
        {/* The amount stays under pressure: how many GB are left matters most when memory is nearly full. */}
        <span className="vitals-meter-detail">{detail}</span>
        <span className="vitals-meter-value">{value}</span>
      </div>
      {percent === null ? (
        // A meter must have a current value. With nothing measured this is a
        // picture of an empty track, named in words.
        <div className="vitals-meter-track" role="img" aria-label={`${label}: ${spoken}`}>
          {tickPercent !== undefined && <span className="vitals-meter-tick" style={{ left: `${tickPercent}%` }} />}
        </div>
      ) : (
        <div
          className="vitals-meter-track"
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={spoken}
        >
          <span className="vitals-meter-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          {tickPercent !== undefined && <span className="vitals-meter-tick" style={{ left: `${tickPercent}%` }} />}
        </div>
      )}
    </div>
  );
}

function RateRow({
  label,
  series,
  history,
  value,
  unit,
  lowerBound,
  tone,
  spokenUnit,
}: {
  label: string;
  series: VitalsSeries;
  history: readonly FleetVitalsHistoryPoint[];
  /** Current rate, `null` while it is still being measured. */
  value: number | null;
  unit: string;
  /** The real figure can only be higher: shown as "≥" on the number. */
  lowerBound: boolean;
  tone: 'fleet' | 'quiet';
  spokenUnit: string;
}) {
  const values = vitalsSeries(history, series);
  const peak = seriesPeak(values);
  const path = sparklinePath(values, SPARK_WIDTH, SPARK_HEIGHT, FLEET_VITALS_HISTORY_POINTS);
  const end = value === null ? null : sparklineEnd(values, SPARK_HEIGHT, FLEET_VITALS_HISTORY_POINTS);
  const allZero = peak !== null && peak <= 0;
  const shown = lowerBound ? formatVitalsLowerBound(value) : formatVitalsCount(value);
  const spoken = value === null
    ? `${label}: warming up`
    : `${label}: ${lowerBound && shown.startsWith('≥') ? 'at least ' : ''}${formatVitalsCount(value)} ${spokenUnit}${peak !== null && peak > 0 ? `, peak ${formatVitalsCount(peak)}` : ''}`;
  return (
    <div className="vitals-rate" role="group" aria-label={spoken}>
      <span className="vitals-rate-label" aria-hidden="true">{label}</span>
      {/* An idle series is drawn quiet: teal is kept for a fleet that is working. */}
      <span className={`vitals-spark vitals-spark--${allZero ? 'quiet' : tone}`} aria-hidden="true">
        <svg viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" focusable="false">
          <line className="vitals-spark-floor" x1="0" x2={SPARK_WIDTH} y1={SPARK_HEIGHT - 0.5} y2={SPARK_HEIGHT - 0.5} />
          {path && <path className="vitals-spark-line" d={path} />}
        </svg>
        {/* The newest point, as a dot: it ties the line to the number beside it. */}
        {end && <span className="vitals-spark-end" style={{ left: `${end.xPercent}%`, top: `${end.y}px` }} />}
      </span>
      <span className="vitals-rate-value" aria-hidden="true">{shown}</span>
      <span className="vitals-rate-unit" aria-hidden="true">{unit}</span>
      <span className="vitals-rate-scale" aria-hidden="true">
        {value === null ? (
          'warming up'
        ) : peak === null ? null : allZero ? (
          'all zero'
        ) : (
          <>
            peak <span className="vitals-rate-peak">{formatVitalsCount(peak)}</span>
          </>
        )}
      </span>
    </div>
  );
}

function machineDetails(sample: FleetVitalsSample): {
  cpu: string;
  ram: string;
  gpu: string;
  vram: string;
} {
  const { machine } = sample;
  return {
    cpu: machine.loadAverage1m === null ? '' : `load ${machine.loadAverage1m.toFixed(1)}`,
    ram: formatVitalsBytesOfTotal(machine.memoryUsedBytes, machine.memoryTotalBytes),
    gpu: machine.gpu?.temperatureC == null ? '' : `${Math.round(machine.gpu.temperatureC)} °C`,
    vram: formatVitalsBytesOfTotal(machine.gpu?.memoryUsedBytes, machine.gpu?.memoryTotalBytes),
  };
}

const PROBLEM_WORDS = {
  cpu: { watch: 'busy', bad: 'saturated' },
  ram: { watch: 'tight', bad: 'full' },
  vram: { watch: 'tight', bad: 'nearly full' },
} as const;

function problemWord(resource: keyof typeof PROBLEM_WORDS, level: VitalsLevel): string | undefined {
  return level === 'watch' || level === 'bad' ? PROBLEM_WORDS[resource][level] : undefined;
}

export interface FleetVitalsBlockProps {
  /** Findings waiting on the operator, shown beside the running count. */
  needYouCount?: number;
}

/** The vitals block at the top of the System detail. Renders nothing until the first sample arrives. */
export function FleetVitalsBlock({ needYouCount = 0 }: FleetVitalsBlockProps) {
  const sample = useKookrStore((s) => s.fleetVitals);
  const history = useKookrStore((s) => s.fleetVitalsHistory);
  const resourceStatus = useKookrStore((s) => s.resourceStatus);
  const stale = useFleetVitalsStale();
  const secondsOld = useSecondsSinceSample(stale);
  const pinned = useVitalsPinned();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();

  if (!sample) return null;

  const verdict = fleetVitalsVerdict(sample);
  const details = machineDetails(sample);
  const { machine, fleet } = sample;
  const cpu = cpuLevel(sample);
  const ram = ramLevel(sample);
  const vram = vramLevel(sample);
  const lag = lagLevel(sample);
  const lagSlow = lag === 'watch' || lag === 'bad';
  const running = fleet.agents + fleet.subagents;
  const cached = cachedReadShare(sample);
  const windowLabel = historyWindowLabel(history);
  const verdictTone = stale ? 'stale' : verdict.level;
  // The headline is a live region, so it holds only the state, which changes
  // rarely. The figures beside it change with every sample (and the age every
  // second) and stay outside, or a screen reader would repeat them all day.
  const headline = stale ? 'Readings are old' : verdict.headline;
  const verdictDetail = stale ? `${secondsOld ?? 0} s, last values shown` : verdict.detail;
  const lagText = machine.serverLoopDelayP95Ms === null
    ? VITALS_UNAVAILABLE
    : `${Math.round(machine.serverLoopDelayP95Ms)} ms`;
  const disk = resourceStatus?.host.dataDirectory;
  const newReadPerSec = fleet.tokens ? Math.max(0, fleet.tokens.readPerSec - fleet.tokens.cacheReadPerSec) : null;

  return (
    <section
      className={`vitals${stale ? ' vitals--stale' : ''}`}
      aria-label="Machine and fleet vitals"
      data-testid="fleet-vitals"
    >
      <div className={`vitals-verdict vitals-verdict--${verdictTone}`} data-testid="fleet-vitals-verdict">
        <Mark level={verdictTone} />
        <span className="vitals-verdict-headline" role="status">{headline}</span>
        {verdictDetail && <span className="vitals-verdict-detail">{verdictDetail}</span>}
      </div>

      <div className="vitals-machine">
        <Meter
          label="CPU"
          detail={details.cpu}
          percent={machine.cpuUsagePercent}
          level={cpu}
          tickPercent={CPU_WATCH_PERCENT}
          problem={problemWord('cpu', cpu)}
        />
        <Meter
          label="RAM"
          detail={details.ram}
          percent={machine.memoryUsedPercent}
          level={ram}
          tickPercent={RAM_WATCH_PERCENT}
          problem={problemWord('ram', ram)}
        />
        {machine.gpu && (
          <>
            <Meter
              label="GPU"
              detail={details.gpu}
              percent={machine.gpu.utilizationPercent}
              level={gpuLoadLevel(sample)}
            />
            <Meter
              label="VRAM"
              detail={details.vram}
              percent={machine.gpu.memoryUsedPercent}
              level={vram}
              tickPercent={VRAM_WATCH_PERCENT}
              problem={problemWord('vram', vram)}
            />
          </>
        )}
      </div>

      <div className="vitals-fleet" data-testid="fleet-vitals-running">
        <span className="vitals-running">
          <span className="vitals-running-count">{running}</span>
          <span className="vitals-running-label">running</span>
        </span>
        {/* "0 running" already says an idle fleet; a split of zeros adds nothing. */}
        {running === 0 && needYouCount === 0 ? null : (
          <span className="vitals-split">
            <span className="vitals-split-item">
              <Mark level="ok" />
              {fleet.agents} {fleet.agents === 1 ? 'agent' : 'agents'}
            </span>
            <span className="vitals-split-item">
              <Mark level="unknown" />
              ~{fleet.subagents} {fleet.subagents === 1 ? 'subagent' : 'subagents'}
            </span>
            {needYouCount > 0 && (
              <span className="vitals-split-item vitals-split-item--need">
                <Mark level="watch" />
                {needYouCount} need you
              </span>
            )}
          </span>
        )}
      </div>

      <div className="vitals-rates">
        <RateRow
          label="Generated"
          series="gen"
          history={history}
          value={fleet.tokens ? fleet.tokens.generatedPerSec : null}
          unit="tok/s"
          spokenUnit="tokens per second"
          lowerBound
          tone="fleet"
        />
        <RateRow
          label="Read"
          series="read"
          history={history}
          value={fleet.tokens ? fleet.tokens.readPerSec : null}
          unit="tok/s"
          spokenUnit="tokens per second"
          lowerBound
          tone="quiet"
        />
        <RateRow
          label="Tool calls"
          series="tools"
          history={history}
          value={fleet.toolCallsPerMin}
          unit="/min"
          spokenUnit="per minute"
          lowerBound={false}
          tone="fleet"
        />
        <p className="vitals-caption">
          {windowLabel}, each line 0 to its peak
          {cached !== null && ` · ${Math.round(cached)}% read from cache`}
        </p>
      </div>

      <div className="vitals-footer">
        <span className={`vitals-lag vitals-lag--${lag}`} data-testid="fleet-vitals-lag">
          {lagSlow && <Mark level={lag} />}
          {lag === 'bad' ? 'Dashboard very slow' : lag === 'watch' ? 'Dashboard slow' : 'Dashboard lag'}
          <span className="vitals-lag-value">{lagText}</span>
        </span>
        <button
          type="button"
          className="vitals-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          Details
        </button>
        <button
          type="button"
          role="switch"
          className="vitals-pin"
          aria-checked={pinned}
          onClick={() => setVitalsPinned(!pinned)}
          data-testid="fleet-vitals-pin"
        >
          <span className="vitals-pin-track" aria-hidden="true"><span className="vitals-pin-thumb" /></span>
          Pin to top bar
        </button>
      </div>

      {detailsOpen && (
        <div className="vitals-details" id={detailsId} data-testid="fleet-vitals-details">
          <dl>
            {machine.loadAverage1m !== null && (
              <>
                <dt>Load average</dt>
                <dd>
                  {machine.loadAverage1m.toFixed(1)}
                  {machine.logicalCpuCount !== null && ` over ${machine.logicalCpuCount} cores`}
                </dd>
              </>
            )}
            {machine.gpu && (
              <>
                <dt>GPU</dt>
                <dd>
                  {[
                    machine.gpu.deviceCount > 1 ? `${machine.gpu.deviceCount} × ${shortGpuName(machine.gpu.name) ?? 'GPU'}` : shortGpuName(machine.gpu.name),
                    machine.gpu.temperatureC === null ? null : `${Math.round(machine.gpu.temperatureC)} °C`,
                    machine.gpu.powerWatts === null ? null : `${Math.round(machine.gpu.powerWatts)} W`,
                  ].filter(Boolean).join(' · ')}
                </dd>
              </>
            )}
            {!machine.gpu && (machine.gpuUnavailable === 'not_installed' || machine.gpuUnavailable === 'no_devices') && (
              <>
                <dt>GPU</dt>
                <dd>No NVIDIA GPU found</dd>
              </>
            )}
            {disk && disk.diskFreeBytes !== null && (
              <>
                <dt>Disk free</dt>
                <dd>{formatBytes(disk.diskFreeBytes)}{disk.diskTotalBytes !== null && ` of ${formatBytes(disk.diskTotalBytes)}`}</dd>
              </>
            )}
            {resourceStatus && resourceStatus.server.processRssBytes !== null && (
              <>
                <dt>Kookr memory</dt>
                <dd>{formatBytes(resourceStatus.server.processRssBytes)}</dd>
              </>
            )}
            {fleet.tokens && (
              <>
                <dt>Tokens read</dt>
                <dd>
                  {formatVitalsCount(fleet.tokens.cacheReadPerSec)}/s from cache · {formatVitalsCount(newReadPerSec)}/s new
                </dd>
              </>
            )}
            {fleet.topTools.length > 0 && (
              <>
                <dt>Tools, last min</dt>
                <dd>{fleet.topTools.map((entry) => `${entry.tool} ${entry.calls}`).join(' · ')}</dd>
              </>
            )}
          </dl>
          <p className="vitals-note">
            ≥ marks a lower bound: Grok Build and OpenCode agents report their tokens only when they stop.
            {' '}~ marks an approximate count.
            {machine.gpu && ' GPU load is shown, not judged: a busy GPU is normal during a run.'}
            {' '}RAM is an estimate that counts reclaimable cache as used.
          </p>
        </div>
      )}
    </section>
  );
}

export interface StripCell {
  key: string;
  label: string;
  value: string;
  level: VitalsLevel | 'stale';
  spoken: string;
  group: 'alert' | 'machine' | 'fleet';
}

/** The cells of the strip, in display order. Exported so the rules can be tested without rendering. */
export function fleetVitalsStripCells(sample: FleetVitalsSample, staleSeconds: number | null): StripCell[] {
  const { machine, fleet } = sample;
  const cells: StripCell[] = [];
  if (staleSeconds !== null) {
    cells.push({
      key: 'stale',
      label: 'Old',
      value: `${staleSeconds}s`,
      level: 'stale',
      spoken: `readings are ${staleSeconds} seconds old`,
      group: 'alert',
    });
  }
  // Memory and dashboard lag have no cell at rest; they appear only when they need a look.
  const ram = ramLevel(sample);
  if (ram === 'watch' || ram === 'bad') {
    cells.push({
      key: 'ram',
      label: 'RAM',
      value: formatVitalsPercent(machine.memoryUsedPercent),
      level: ram,
      spoken: `memory ${ram === 'bad' ? 'full' : 'tight'}, ${formatVitalsPercent(machine.memoryUsedPercent)}`,
      group: 'alert',
    });
  }
  const lag = lagLevel(sample);
  if (lag === 'watch' || lag === 'bad') {
    const ms = `${Math.round(machine.serverLoopDelayP95Ms ?? 0)} ms`;
    cells.push({
      key: 'lag',
      label: 'Lag',
      value: ms,
      level: lag,
      spoken: `dashboard ${lag === 'bad' ? 'very slow' : 'slow'}, ${ms}`,
      group: 'alert',
    });
  }
  const cpu = cpuLevel(sample);
  cells.push({
    key: 'cpu',
    label: 'CPU',
    value: formatVitalsPercent(machine.cpuUsagePercent),
    level: cpu,
    spoken: `CPU ${machine.cpuUsagePercent === null ? 'not measured yet' : formatVitalsPercent(machine.cpuUsagePercent)}${problemWord('cpu', cpu) ? `, ${problemWord('cpu', cpu)}` : ''}`,
    group: 'machine',
  });
  if (machine.gpu) {
    const vram = vramLevel(sample);
    cells.push({
      key: 'gpu',
      label: 'GPU',
      value: formatVitalsPercent(machine.gpu.utilizationPercent),
      level: gpuLoadLevel(sample),
      spoken: `GPU load ${formatVitalsPercent(machine.gpu.utilizationPercent)}`,
      group: 'machine',
    });
    cells.push({
      key: 'vram',
      label: 'VRAM',
      value: formatVitalsPercent(machine.gpu.memoryUsedPercent),
      level: vram,
      spoken: `video memory ${formatVitalsPercent(machine.gpu.memoryUsedPercent)}${problemWord('vram', vram) ? `, ${problemWord('vram', vram)}` : ''}`,
      group: 'machine',
    });
  }
  const running = fleet.agents + fleet.subagents;
  cells.push({
    key: 'running',
    label: 'Running',
    value: String(running),
    level: 'ok',
    spoken: `${running} running`,
    group: 'fleet',
  });
  cells.push({
    key: 'tokens',
    label: 'tok/s',
    value: formatVitalsLowerBound(fleet.tokens?.generatedPerSec),
    level: fleet.tokens ? 'ok' : 'unknown',
    spoken: fleet.tokens
      ? `at least ${formatVitalsCount(fleet.tokens.generatedPerSec)} tokens generated per second`
      : 'token rate warming up',
    group: 'fleet',
  });
  return cells;
}

/**
 * How much of the strip is shown:
 * - `full`: machine cells and fleet cells;
 * - `machine`: the fleet cells go first;
 * - `alerts`: only the cells that need a look, so a cramped top bar still
 *   names a problem and shows nothing at rest;
 * - `worst`: the single most serious of those, when even they do not all fit.
 */
export type VitalsStripDensity = 'full' | 'machine' | 'alerts' | 'worst';

/** Widest first. One step past the end means "does not fit at all": the strip is not shown. */
const DENSITY_STEPS: readonly VitalsStripDensity[] = ['full', 'machine', 'alerts', 'worst'];
/**
 * Which problem to keep when only one cell fits: a red one before an amber one,
 * and among equals video memory first (a full GPU fails the next model load
 * outright), then CPU, memory, dashboard lag, and last "readings are old".
 */
const WORST_FIRST: readonly string[] = ['vram', 'cpu', 'ram', 'lag', 'stale'];
/** Clear space kept between the strip and the controls on the left of the top bar. */
const STRIP_CLEARANCE_PX = 16;

export function visibleStripCells(cells: readonly StripCell[], density: VitalsStripDensity): StripCell[] {
  if (density === 'full') return [...cells];
  if (density === 'machine') return cells.filter((cell) => cell.group !== 'fleet');
  const alerts = cells.filter((cell) => cell.level === 'watch' || cell.level === 'bad' || cell.level === 'stale');
  if (density === 'alerts') return alerts;
  const rank = (cell: StripCell): number =>
    (cell.level === 'bad' ? 0 : cell.level === 'watch' ? 10 : 20) + WORST_FIRST.indexOf(cell.key);
  return [...alerts].sort((a, b) => rank(a) - rank(b)).slice(0, 1);
}

/**
 * Picks the widest form of the strip that fits between the controls on the left
 * of the top bar and the System button, by measuring the rendered strip.
 *
 * It starts from the widest form whenever the room or the set of cells may have
 * changed, and steps down while the strip is wider than its room. The steps run
 * in layout effects, so only the form that fits is ever painted. The room
 * cannot be a fixed breakpoint: the left of the bar grows with the findings
 * text and the whole bar shrinks when Lucy's column is open.
 *
 * Returns an index into `DENSITY_STEPS`; `DENSITY_STEPS.length` means hidden.
 */
function useFittingStep(slotRef: React.RefObject<HTMLElement | null>, contentKey: string, enabled: boolean): number {
  const [step, setStep] = useState(0);
  const [resizeCount, setResizeCount] = useState(0);
  const settledFor = useRef('');

  useEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return;
    const bar = slotRef.current?.closest('.topbar');
    const left = bar?.querySelector('.topbar-left');
    if (!bar) return;
    const observer = new ResizeObserver(() => setResizeCount((count) => count + 1));
    observer.observe(bar);
    if (left) observer.observe(left);
    return () => observer.disconnect();
  }, [slotRef, enabled]);

  // No dependency list on purpose: it measures what was just rendered.
  useLayoutEffect(() => {
    if (!enabled) return;
    const key = `${resizeCount}|${contentKey}`;
    if (settledFor.current !== key) {
      // The room or the cells changed: try the widest form again.
      settledFor.current = key;
      if (step !== 0) {
        setStep(0);
        return;
      }
    }
    const slot = slotRef.current;
    const strip = slot?.firstElementChild;
    const bar = slot?.closest('.topbar');
    const left = bar?.querySelector('.topbar-left');
    if (!slot || !strip || !bar || !left) return;
    // No layout (a test DOM): leave the widest form in place.
    if (bar.getBoundingClientRect().width === 0) return;
    const room = slot.getBoundingClientRect().right - left.getBoundingClientRect().right - STRIP_CLEARANCE_PX;
    if (strip.getBoundingClientRect().width > room && step < DENSITY_STEPS.length) setStep(step + 1);
  });

  return step;
}

export interface FleetVitalsStripProps {
  /** Opens the System detail, where the full block lives. */
  onOpen: () => void;
  /** Whether the System detail is open (the strip is its second trigger). */
  expanded?: boolean;
  /** Forces one form instead of measuring what fits (used by tests). */
  density?: VitalsStripDensity;
}

/** The opt-in vitals strip in the top bar. Shows nothing unless pinned and a sample exists. */
export function FleetVitalsStrip({ onOpen, expanded = false, density }: FleetVitalsStripProps) {
  const pinned = useVitalsPinned();
  const sample = useKookrStore((s) => s.fleetVitals);
  const stale = useFleetVitalsStale();
  const secondsOld = useSecondsSinceSample(pinned && stale);
  const slotRef = useRef<HTMLSpanElement>(null);

  const active = pinned && sample !== null;
  const allCells = active ? fleetVitalsStripCells(sample, stale ? secondsOld ?? 0 : null) : [];
  // Which cells exist and how wide their values are: when this changes, the fit is measured again.
  const contentKey = allCells.map((cell) => `${cell.key}${cell.level}${cell.value.length}`).join(',');
  const fittingStep = useFittingStep(slotRef, contentKey, active && density === undefined);
  const shownDensity = density ?? DENSITY_STEPS[fittingStep];
  const cells = shownDensity ? visibleStripCells(allCells, shownDensity) : [];
  // The spoken label always gives every reading, whatever fits on screen.
  const label = `Vitals: ${allCells.map((cell) => cell.spoken).join(', ')}. Open System detail`;
  const firstFleet = cells.findIndex((cell) => cell.group === 'fleet');

  // The slot is always in the top bar, so there is something to measure from
  // even while no form of the strip fits.
  return (
    <span className="vitals-strip-slot" ref={slotRef}>
      {/* Nothing fits, or nothing needs a look in a cramped top bar: the System
          indicator beside the slot still carries the state. */}
      {active && cells.length > 0 && (
        <button
          type="button"
          className={`vitals-strip${stale ? ' vitals-strip--stale' : ''}`}
          onClick={onOpen}
          aria-label={label}
          aria-expanded={expanded}
          aria-controls="system-popover"
          title="Machine and fleet vitals. Click for the detail."
          data-testid="fleet-vitals-strip"
          data-density={shownDensity}
        >
          {cells.map((cell, index) => {
            const pressured = cell.level === 'watch' || cell.level === 'bad';
            return (
              <React.Fragment key={cell.key}>
                {index === firstFleet && index > 0 && <span className="vitals-strip-sep" aria-hidden="true" />}
                <span
                  className={`vitals-cell vitals-cell--${cell.level} vitals-cell--${cell.group}`}
                  data-vitals-cell={cell.key}
                  aria-hidden="true"
                >
                  <span className="vitals-cell-label">
                    {(pressured || cell.level === 'stale') && <Mark level={cell.level} />}
                    {cell.label}
                  </span>
                  <span className="vitals-cell-value">{cell.value}</span>
                </span>
              </React.Fragment>
            );
          })}
        </button>
      )}
    </span>
  );
}
