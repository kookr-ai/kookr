import React, { useEffect, useMemo, useState } from 'react';
import type {
  OutcomeLedgerByAgentRow,
  OutcomeLedgerComparison,
  OutcomeLedgerFinding,
  OutcomeLedgerFindingKind,
  OutcomeLedgerLaunchSource,
  OutcomeLedgerLaunchSourceMix,
  OutcomeLedgerMetricDelta,
  OutcomeLedgerProjectScope,
  OutcomeLedgerResponse,
  OutcomeLedgerTaskRow,
} from '../../shared/contracts/outcome-ledger.js';
import { OUTCOME_LEDGER_LAUNCH_SOURCES } from '../../shared/contracts/outcome-ledger.js';
import type { TimeWindow } from '../../shared/contracts/cost-comparison.js';
import { AVAILABLE_AGENT_TYPES } from '../../shared/contracts/agent-types.js';
import { getOutcomeLedger } from '../api/index.js';
import { formatCost, formatTokens } from '../presentation.js';

/**
 * Below this many terminal tasks, a per-agent completion rate is drawn from too
 * few samples to trust. We show the raw count instead of a headline percentage
 * so a 1-of-1 "100%" agent never masquerades as a proven winner — the same
 * "guard rates under a threshold" discipline the ledger applies elsewhere.
 */
const MIN_AGENT_SAMPLE = 5;

const AGENT_LABELS = new Map(AVAILABLE_AGENT_TYPES.map((entry) => [entry.type, entry.label]));

const WINDOWS: { value: TimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'all' },
];

/** A selectable tracked project: stable identity plus a friendly display label. */
export interface OutcomeLedgerProjectOption {
  id: string;
  label: string;
}

/** Sentinel select values for the two non-project scopes. */
const ALL_PROJECTS_CHOICE = 'all';
const UNASSIGNED_CHOICE = 'unassigned';
/**
 * A tracked-project option is encoded as `assigned:<id>` in the <select>. The
 * prefix is only a transport detail between the option value and
 * {@link parseProjectChoice}; the project ID itself is never interpreted, so an
 * ID that literally spells `all` or `unassigned` still round-trips as a project.
 */
const ASSIGNED_PREFIX = 'assigned:';

function projectChoiceValue(option: OutcomeLedgerProjectOption): string {
  return `${ASSIGNED_PREFIX}${option.id}`;
}

function parseProjectChoice(choice: string): OutcomeLedgerProjectScope {
  if (choice === UNASSIGNED_CHOICE) return { kind: 'unassigned' };
  if (choice.startsWith(ASSIGNED_PREFIX)) {
    return { kind: 'assigned', projectId: choice.slice(ASSIGNED_PREFIX.length) };
  }
  return { kind: 'all' };
}

interface OutcomeLedgerPanelProps {
  /**
   * Tracked projects offered in the scope selector (issue #2850). Defaults to
   * an empty list, so with no wiring the panel still offers `All projects` and
   * `Unassigned`. Identity (`id`) and display (`label`) are kept separate so a
   * historical project ID that no longer has a summary can never lose its
   * identity behind a missing label.
   */
  projects?: OutcomeLedgerProjectOption[];
  /**
   * Task IDs that have a live dashboard agent right now (issue #2783). A finding
   * whose `taskId` is in this set gets an active "Open task" affordance; every
   * other finding — historical rows, or a task with no live agent — stays a
   * plain, readable label. Defaults to empty, so with no wiring no finding is
   * openable. Membership is keyed on the finding `taskId`, never a display
   * label, so a matching name can never open the wrong task.
   */
  liveTaskIds?: ReadonlySet<string>;
  /**
   * Select the live task behind a finding, reusing the dashboard's existing
   * selection path. Only ever called with a `taskId` that is in
   * {@link liveTaskIds}, so it never has to guess a task from a display label.
   */
  onOpenTask?: (taskId: string) => void;
}

export function OutcomeLedgerPanel({
  projects = [],
  liveTaskIds,
  onOpenTask,
}: OutcomeLedgerPanelProps = {}): React.ReactElement {
  const [windowChoice, setWindowChoice] = useState<TimeWindow>('7d');
  const [projectChoice, setProjectChoice] = useState<string>(ALL_PROJECTS_CHOICE);
  const [data, setData] = useState<OutcomeLedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  // If the selected project disappears from the tracked list (e.g. it stops
  // being tracked), fall back to All projects rather than keep querying a scope
  // the operator can no longer see in the selector.
  useEffect(() => {
    if (projectChoice === ALL_PROJECTS_CHOICE || projectChoice === UNASSIGNED_CHOICE) return;
    const stillPresent = projects.some((option) => projectChoiceValue(option) === projectChoice);
    if (!stillPresent) setProjectChoice(ALL_PROJECTS_CHOICE);
  }, [projects, projectChoice]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getOutcomeLedger(windowChoice, parseProjectChoice(projectChoice), controller.signal)
      .then((body) => {
        if (!isOutcomeLedgerResponse(body)) throw new Error('invalid outcome ledger response');
        return body;
      })
      .then((body) => {
        setData(body);
        setLoading(false);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [windowChoice, projectChoice]);

  const findings = Array.isArray(data?.findings) ? data.findings : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const byAgent = Array.isArray(data?.byAgent) ? data.byAgent : [];
  const visibleFindings = useMemo(() => findings.slice(0, 5), [findings]);
  const visibleTasks = useMemo(() => tasks.filter((task) => task.flags.length > 0).slice(0, 5), [tasks]);

  // Client-side CSV export of the scoreboard's headline summary, per-agent
  // rows, and flagged task-audit rows (#3000) — no new server route, mirroring
  // the Cost Comparison panel's export plumbing. The file is labelled from the
  // response's own `window`/`scope`/`generatedAt`, so an export triggered while
  // a window/project change is still in flight (when `data` still holds the
  // previous payload) always describes the rows it actually contains.
  function handleExportCsv(): void {
    if (!data) return;
    const csv = buildOutcomeLedgerCsv(data);
    downloadCsv(csv, outcomeCsvFilename(data.window.value, data.scope));
  }

  return (
    <section className="outcome-ledger-section" aria-labelledby="outcome-ledger-title">
      <div className="section-header">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={expanded}
          aria-controls="outcome-ledger-body"
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="section-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
          <span id="outcome-ledger-title">Outcome Scoreboard</span>
        </button>
        <div className="outcome-ledger-controls">
          <select
            className="outcome-project-select"
            value={projectChoice}
            onChange={(event) => setProjectChoice(event.target.value)}
            aria-label="Outcome scoreboard project"
          >
            <option value={ALL_PROJECTS_CHOICE}>All projects</option>
            <option value={UNASSIGNED_CHOICE}>Unassigned</option>
            {projects.map((option) => (
              <option key={option.id} value={projectChoiceValue(option)}>{option.label}</option>
            ))}
          </select>
          <select
            className="outcome-window-select"
            value={windowChoice}
            onChange={(event) => setWindowChoice(event.target.value as TimeWindow)}
            aria-label="Outcome scoreboard window"
          >
            {WINDOWS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="outcome-export-btn"
            onClick={handleExportCsv}
            disabled={!data}
            aria-label="Export CSV of outcome scoreboard"
          >
            Export CSV
          </button>
        </div>
      </div>
      {expanded && (
        <div id="outcome-ledger-body" className="outcome-ledger-body">
          {loading && <div className="diagnostic-empty">Scanning task outcomes...</div>}
          {error && <div className="diagnostic-error">Failed to load outcome ledger: {error}</div>}
          {data && (
            <>
              <div className={`outcome-readiness ${data.readiness}`}>
                <span className="outcome-readiness-label">{readinessLabel(data.readiness)}</span>
                <span>{data.notes[0]}</span>
              </div>
              <div className="outcome-metrics-grid">
                <Metric label="tasks" value={String(data.summary.taskCount)} />
                <Metric label="completed" value={formatRate(data.summary.completionRate)} detail={`${data.summary.completedTaskCount}/${data.summary.terminalTaskCount}`} delta={comparisonDelta(data.comparison, 'completionRate')} timeWindow={data.window.value} />
                <Metric label="PRs" value={String(data.summary.prTaskCount)} detail={`${data.summary.prTaskCount}/${data.summary.taskCount}`} />
                <Metric label="known cost" value={formatMoney(data.summary.totalKnownCostUsd)} detail={`${pct(data.quality.costCoverage)} coverage`} delta={comparisonDelta(data.comparison, 'costCoverage')} timeWindow={data.window.value} />
                <Metric label="tokens" value={formatTokens(data.summary.totalInputTokens + data.summary.totalOutputTokens)} detail={`${formatTokens(data.summary.totalInputTokens)} in / ${formatTokens(data.summary.totalOutputTokens)} out`} />
                <Metric label="feedback" value={formatRate(data.summary.thumbsUpRate)} detail={`${pct(data.summary.feedbackCoverage)} coverage`} delta={comparisonDelta(data.comparison, 'thumbsUpRate')} timeWindow={data.window.value} />
                <Metric label="verified" value={pct(data.quality.verificationCoverage)} detail={`${data.quality.verificationKnownCompletedTasks}/${data.summary.completedTaskCount}`} delta={comparisonDelta(data.comparison, 'verificationCoverage')} timeWindow={data.window.value} />
                <Metric label="review flags" value={String(data.findings.length)} />
              </div>
              <ComparisonNote comparison={data.comparison} timeWindow={data.window.value} />
              <div className="outcome-quality-strip outcome-disposition-strip" role="group" aria-label="Task disposition split">
                <span>{data.summary.cancelledTaskCount} cancelled</span>
                <span>{data.summary.terminatedTaskCount} terminated</span>
                <span>{data.summary.activeTaskCount} active</span>
              </div>
              <LaunchSourceStrip mix={data.launchSourceMix} />
              <div className="outcome-quality-strip">
                <span>{data.quality.missingCostTasks} missing cost</span>
                <span>{data.quality.zeroCostTasks} zero-cost</span>
                <span>{data.quality.invalidTimestampTasks} invalid time</span>
                <span>{pct(data.quality.interventionCoverage)} interventions known</span>
              </div>
              <AgentScoreboard rows={byAgent} />
              {findings.length > 0 && <FindingBreakdown findings={findings} />}
              {visibleFindings.length > 0 ? (
                <ul className="outcome-findings-list" aria-label="Outcome data quality findings">
                  {visibleFindings.map((finding) => (
                    <FindingRow
                      key={`${finding.taskId}:${finding.kind}:${finding.metric}`}
                      finding={finding}
                      canOpen={Boolean(onOpenTask) && (liveTaskIds?.has(finding.taskId) ?? false)}
                      onOpen={onOpenTask}
                    />
                  ))}
                </ul>
              ) : (
                <div className="diagnostic-empty">No data-quality findings in this window.</div>
              )}
              {visibleTasks.length > 0 && (
                <div className="outcome-task-audit">
                  <div className="outcome-task-audit-title">Rows to inspect first</div>
                  {visibleTasks.map((task) => <TaskAuditRow key={task.taskId} task={task} />)}
                </div>
              )}
              <div className="outcome-ledger-meta">
                generated {new Date(data.generatedAt).toLocaleTimeString()}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, detail, delta, timeWindow }: {
  label: string;
  value: string;
  detail?: string;
  /** Optional current-vs-previous-window comparison for this metric (issue #2784). */
  delta?: OutcomeLedgerMetricDelta | null;
  /** The response's own window, used for the delta's label text. */
  timeWindow?: TimeWindow;
}): React.ReactElement {
  return (
    <div className="outcome-metric">
      <span className="outcome-metric-label">{label}</span>
      <strong>{value}</strong>
      {delta && timeWindow && <DeltaBadge delta={delta} timeWindow={timeWindow} />}
      {detail && <span className="outcome-metric-detail">{detail}</span>}
    </div>
  );
}

// A metric's delta is only meaningful once the comparison is available; an
// unavailable comparison (all-time, or an empty previous window) yields no
// per-metric badge, and the standalone ComparisonNote explains why instead.
function comparisonDelta(
  comparison: OutcomeLedgerComparison,
  metric: 'completionRate' | 'verificationCoverage' | 'thumbsUpRate' | 'costCoverage',
): OutcomeLedgerMetricDelta | null {
  return comparison.available ? comparison[metric] : null;
}

// Whole-word window nouns for the accessible delta/comparison text; 'all' never
// reaches here because the all-time comparison is always unavailable.
const WINDOW_NOUN: Record<TimeWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'all-time',
};

/**
 * Compact directional delta versus the previous equal-duration window (issue
 * #2784). All four compared metrics are rates, so the change is shown in
 * percentage points (pp). A delta of null — the metric is unknown on one side —
 * renders as an explicit "unavailable" dash rather than as a zero change, and
 * the accessible label states direction and magnitude without implying a cause.
 */
function DeltaBadge({ delta, timeWindow }: { delta: OutcomeLedgerMetricDelta; timeWindow: TimeWindow }): React.ReactElement {
  // role="img" is required for the aria-label to be exposed: a bare <span> has
  // the generic role, which prohibits an author name, so the label would be
  // dropped and the aria-hidden glyph would leave the badge silent to a screen
  // reader. role="img" collapses the glyph+text into one labeled graphic.
  if (delta.delta == null) {
    return (
      <span
        className="outcome-delta unavailable"
        role="img"
        aria-label={`no comparable value in the previous ${WINDOW_NOUN[timeWindow]}`}
        title={`No comparable value in the previous ${WINDOW_NOUN[timeWindow]}`}
      >
        <span aria-hidden>—</span>
      </span>
    );
  }
  const points = Math.round(delta.delta * 100);
  const direction = points > 0 ? 'up' : points < 0 ? 'down' : 'flat';
  const arrow = points > 0 ? '▲' : points < 0 ? '▼' : '→';
  const magnitude = Math.abs(points);
  const label = points === 0
    ? `no change vs previous ${WINDOW_NOUN[timeWindow]}`
    : `${direction === 'up' ? 'up' : 'down'} ${magnitude} percentage point${magnitude === 1 ? '' : 's'} vs previous ${WINDOW_NOUN[timeWindow]}`;
  return (
    <span className={`outcome-delta ${direction}`} role="img" aria-label={label} title={label}>
      <span aria-hidden>{arrow} {magnitude}pp</span>
    </span>
  );
}

/**
 * Explains what the metric deltas are measured against, or why they are absent
 * (issue #2784). Deliberately neutral: it reports that a window moved, never
 * that Kookr caused the movement.
 */
function ComparisonNote({ comparison, timeWindow }: { comparison: OutcomeLedgerComparison; timeWindow: TimeWindow }): React.ReactElement {
  if (!comparison.available) {
    const text = comparison.reason === 'all_time_window'
      ? 'All-time has no preceding window, so change deltas are unavailable.'
      : `No tasks in the previous ${WINDOW_NOUN[timeWindow]}, so change deltas are unavailable.`;
    return <div className="outcome-comparison-note unavailable">{text}</div>;
  }
  const count = comparison.previousTaskCount;
  return (
    <div className="outcome-comparison-note">
      Δ vs previous {WINDOW_NOUN[timeWindow]} · {count} prior task{count === 1 ? '' : 's'}
    </div>
  );
}

// Descriptive origin labels for each normalized launch source (issue #2801).
// These name where work came from and imply no quality ranking between sources.
const LAUNCH_SOURCE_LABELS: Record<OutcomeLedgerLaunchSource, string> = {
  manual: 'manual',
  scheduled: 'scheduled',
  parent: 'child',
  unknown: 'unknown',
};

/**
 * One compact strip breaking the window's tasks down by launch origin so an
 * operator can see at a glance whether scheduled automation is a meaningful
 * share of the work (issue #2801). Each bucket shows its task count and, once
 * there is at least one task, its share of the window; the `unknown` bucket is
 * always present so legacy tasks without provenance are visible rather than
 * silently dropped.
 */
export function LaunchSourceStrip({ mix }: { mix: OutcomeLedgerLaunchSourceMix }): React.ReactElement {
  return (
    <div className="outcome-quality-strip outcome-launch-source-strip" role="group" aria-label="Task launch-source mix">
      {OUTCOME_LEDGER_LAUNCH_SOURCES.map((source) => {
        const count = mix.counts[source];
        const share = mix.shares?.[source] ?? null;
        return (
          <span key={source}>
            {count} {LAUNCH_SOURCE_LABELS[source]}
            {share != null && <span className="outcome-launch-source-share"> {pct(share)}</span>}
          </span>
        );
      })}
    </div>
  );
}

function AgentScoreboard({ rows }: { rows: OutcomeLedgerByAgentRow[] }): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div className="outcome-agent-scoreboard">
      <div className="outcome-agent-title">By agent</div>
      <div className="outcome-agent-table-scroll">
        <table className="outcome-agent-table">
          <thead>
            <tr>
              <th scope="col">agent</th>
              <th scope="col">completed</th>
              <th scope="col">median</th>
              <th scope="col">p95</th>
              <th scope="col">known cost</th>
              <th scope="col">👍</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => <AgentScoreboardRow key={row.agentType} row={row} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentScoreboardRow({ row }: { row: OutcomeLedgerByAgentRow }): React.ReactElement {
  const lowSample = row.terminalTaskCount < MIN_AGENT_SAMPLE;
  const completedFraction = `${row.completedTaskCount}/${row.terminalTaskCount}`;
  return (
    <tr>
      <th scope="row" className="outcome-agent-name">{agentLabel(row.agentType)}</th>
      <td>
        {lowSample ? (
          <span className="outcome-agent-lowsample" title={`Only ${row.terminalTaskCount} terminal task(s); rate withheld until ${MIN_AGENT_SAMPLE}.`}>
            {completedFraction} <span className="outcome-agent-lowsample-tag">low sample</span>
          </span>
        ) : (
          <span>{formatRate(row.completionRate)} <span className="outcome-agent-detail">{completedFraction}</span></span>
        )}
      </td>
      <td>{formatMs(row.medianDurationMs)}</td>
      <td>{formatMs(row.p95DurationMs)}</td>
      <td>
        {formatMoney(row.totalKnownCostUsd)} <span className="outcome-agent-detail">{pct(row.costCoverage)} cov</span>
      </td>
      {/*
        Feedback votes can never exceed terminal tasks, so a low-sample agent
        also has a low-sample thumbs-up rate — withhold it too, or a 1-of-1
        "100%" would leak through the very guard the completion column applies.
        (The row contract carries no feedback-vote count, so this is the
        tightest guard available without a contract change.)
      */}
      <td>{lowSample ? <span className="outcome-agent-detail">—</span> : formatRate(row.thumbsUpRate)}</td>
    </tr>
  );
}

// Display order and lowercase labels for each typed finding kind emitted by the
// backend (`OutcomeLedgerFindingKind`). A new kind added to the contract must
// gain an entry here or it renders under its raw slug via findingKindLabel and
// sorts after every known kind (see findingCountsByKind).
const FINDING_KIND_ORDER: OutcomeLedgerFindingKind[] = [
  'data_quality',
  'duration_extreme',
  'cost_extreme',
  'intervention_extreme',
  'token_extreme',
];

const FINDING_KIND_LABELS: Record<OutcomeLedgerFindingKind, string> = {
  data_quality: 'data quality',
  duration_extreme: 'duration',
  cost_extreme: 'cost',
  intervention_extreme: 'intervention',
  token_extreme: 'token',
};

function findingKindLabel(kind: string): string {
  return (FINDING_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/**
 * Group findings by their typed `kind` into a stable, ordered breakdown. Known
 * kinds render in FINDING_KIND_ORDER; any unrecognized kind is appended after
 * them (sorted by label) so a future backend kind still shows rather than
 * silently vanishing. Counts are per finding, not per unique task.
 */
function findingCountsByKind(
  findings: OutcomeLedgerFinding[],
): { kind: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  const rank = new Map(FINDING_KIND_ORDER.map((kind, index) => [kind as string, index]));
  return Array.from(counts.entries())
    .map(([kind, count]) => ({ kind, label: findingKindLabel(kind), count }))
    .sort((a, b) => {
      const rankA = rank.get(a.kind) ?? Number.POSITIVE_INFINITY;
      const rankB = rank.get(b.kind) ?? Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      return a.label.localeCompare(b.label);
    });
}

function FindingBreakdown({ findings }: { findings: OutcomeLedgerFinding[] }): React.ReactElement {
  const groups = useMemo(() => findingCountsByKind(findings), [findings]);
  return (
    <div className="outcome-finding-breakdown">
      <div className="outcome-finding-breakdown-title">Review flags by category</div>
      <ul
        className="outcome-finding-breakdown-list"
        aria-label="Review flags by category (counts are findings, not tasks)"
      >
        {groups.map((group) => (
          <li key={group.kind} className="outcome-finding-breakdown-item">
            <span className="outcome-finding-breakdown-label">{group.label}</span>
            <span className="outcome-finding-breakdown-count">{group.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FindingRow({
  finding,
  canOpen,
  onOpen,
}: {
  finding: OutcomeLedgerFinding;
  canOpen: boolean;
  onOpen?: (taskId: string) => void;
}): React.ReactElement {
  const measure = finding.value == null ? null : formatFindingMeasure(finding.metric, finding.value);
  return (
    <li className={`outcome-finding ${finding.severity}`}>
      <span className="outcome-finding-severity">{finding.severity}</span>
      <span className="outcome-finding-text">
        {finding.message}
        {/* The leading space is a real text node so screen readers don't run the
            message straight into the chip (e.g. "$0 cost.cost: $0.0000"). */}
        {measure && <>{' '}<span className="outcome-finding-measure">{measure}</span></>}
      </span>
      {canOpen && onOpen ? (
        // Live task: a real button so the same action is reachable by click,
        // keyboard, and screen reader. It selects by finding.taskId, never the
        // display label, so a shared name can't open the wrong task.
        <button
          type="button"
          className="outcome-finding-task outcome-finding-open"
          onClick={() => onOpen(finding.taskId)}
          aria-label={`Open task ${finding.label}`}
        >
          {finding.label}
        </button>
      ) : (
        // Historical or unmatched finding: still readable, but plainly not
        // actionable — no button, so nothing to activate and nothing to select.
        <span className="outcome-finding-task">{finding.label}</span>
      )}
    </li>
  );
}

function TaskAuditRow({ task }: { task: OutcomeLedgerTaskRow }): React.ReactElement {
  return (
    <div className="outcome-task-row">
      <span className="outcome-task-label">{task.label}</span>
      <span>{task.flags.join(', ')}</span>
    </div>
  );
}

function readinessLabel(readiness: OutcomeLedgerResponse['readiness']): string {
  if (readiness === 'ready') return 'ready';
  if (readiness === 'caution') return 'caution';
  return 'blocked';
}

function formatRate(value: number | null): string {
  return value == null ? 'unknown' : `${Math.round(value * 100)}%`;
}

function pct(value: number | null): string {
  return value == null ? 'unknown' : `${Math.round(value * 100)}%`;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

// Lowercase chip labels for each finding metric slug emitted by the backend
// (`extremeFindings` + the data_quality builders in src/core/outcome-ledger.ts).
// Kept separate from core's Title-Case `humanMetric` (which serves prose
// messages); a new metric added there must gain an entry here or it falls back
// to the raw slug via humanFindingMetric.
const FINDING_METRIC_LABELS: Record<string, string> = {
  durationMs: 'duration',
  duration: 'duration',
  knownCostUsd: 'cost',
  cost: 'cost',
  interventionCount: 'interventions',
  totalTokens: 'tokens',
  sessions: 'sessions',
  digest: 'digest',
  verification: 'verification',
};

function humanFindingMetric(metric: string): string {
  return FINDING_METRIC_LABELS[metric] ?? metric;
}

function formatFindingValue(metric: string, value: number | string): string {
  if (typeof value === 'string') return value;
  switch (metric) {
    case 'durationMs':
    case 'duration':
      return formatMs(value);
    case 'knownCostUsd':
    case 'cost':
      return formatCost(value);
    case 'totalTokens':
      return formatTokens(value);
    default:
      return value.toLocaleString();
  }
}

/** Render a per-finding quantitative payload as `metric: value` for the row. */
function formatFindingMeasure(metric: string, value: number | string): string {
  return `${humanFindingMetric(metric)}: ${formatFindingValue(metric, value)}`;
}

function formatMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remMinutes}m`;
}

function agentLabel(agentType: OutcomeLedgerByAgentRow['agentType']): string {
  return AGENT_LABELS.get(agentType) ?? agentType;
}

// ---------- CSV export (#3000) --------------------------------------------------

/**
 * Serialise the scoreboard's currently displayed numbers to a single CSV
 * document (#3000) — no new server route. Three labelled sections separated by
 * blank lines:
 *
 *   1. "Summary" — the headline metric grid plus the disposition/coverage
 *      strips, as `Metric,Value` pairs.
 *   2. "By agent" — one row per agent, mirroring the per-agent scoreboard table.
 *   3. "Task audit" — every flagged task (the "Rows to inspect first" list). The
 *      on-screen list caps at 5 for scannability; the export includes all
 *      flagged rows so an operator can triage the full set offline.
 *
 * Counts, cost, and token totals are emitted as bare numbers, rates as their
 * raw 0..1 fraction, durations in milliseconds, and timestamps as ISO 8601, so
 * a spreadsheet can aggregate every column rather than parse a display string.
 * A short preamble records the window, project scope, and generation time from
 * the response itself, so the file is self-describing.
 */
export function buildOutcomeLedgerCsv(data: OutcomeLedgerResponse): string {
  const rows: string[][] = [];

  rows.push(['Outcome Scoreboard export']);
  rows.push(['Window', data.window.value]);
  rows.push(['Project scope', describeScope(data.scope)]);
  rows.push(['Generated', csvIsoDate(data.generatedAt)]);
  rows.push(['Readiness', data.readiness]);
  rows.push([]);

  rows.push(['Summary']);
  rows.push(['Metric', 'Value']);
  rows.push(['Tasks', String(data.summary.taskCount)]);
  rows.push(['Terminal tasks', String(data.summary.terminalTaskCount)]);
  rows.push(['Completed tasks', String(data.summary.completedTaskCount)]);
  rows.push(['Completion rate', csvRate(data.summary.completionRate)]);
  rows.push(['Cancelled tasks', String(data.summary.cancelledTaskCount)]);
  rows.push(['Terminated tasks', String(data.summary.terminatedTaskCount)]);
  rows.push(['Active tasks', String(data.summary.activeTaskCount)]);
  rows.push(['PR tasks', String(data.summary.prTaskCount)]);
  rows.push(['Known cost (USD)', csvUsd(data.summary.totalKnownCostUsd)]);
  rows.push(['Cost coverage', csvRate(data.quality.costCoverage)]);
  rows.push(['Input tokens', String(data.summary.totalInputTokens)]);
  rows.push(['Output tokens', String(data.summary.totalOutputTokens)]);
  rows.push(['Thumbs-up rate', csvRate(data.summary.thumbsUpRate)]);
  rows.push(['Feedback coverage', csvRate(data.summary.feedbackCoverage)]);
  rows.push(['Verification coverage', csvRate(data.quality.verificationCoverage)]);
  rows.push(['Review flags', String(data.findings.length)]);
  rows.push([]);

  rows.push(['By agent']);
  rows.push([
    'Agent', 'Tasks', 'Completed', 'Terminal', 'Completion rate',
    'Known cost (USD)', 'Cost coverage', 'Median duration (ms)', 'p95 duration (ms)', 'Thumbs-up rate',
  ]);
  for (const row of data.byAgent) {
    rows.push([
      agentLabel(row.agentType),
      String(row.taskCount),
      String(row.completedTaskCount),
      String(row.terminalTaskCount),
      csvRate(row.completionRate),
      csvUsd(row.totalKnownCostUsd),
      csvRate(row.costCoverage),
      csvMs(row.medianDurationMs),
      csvMs(row.p95DurationMs),
      csvRate(row.thumbsUpRate),
    ]);
  }
  rows.push([]);

  rows.push(['Task audit']);
  rows.push(['Task', 'Agent', 'Status', 'Started', 'Duration (ms)', 'Known cost (USD)', 'Feedback', 'Flags']);
  for (const task of data.tasks) {
    if (task.flags.length === 0) continue;
    rows.push([
      task.label,
      agentLabel(task.agentType),
      task.status,
      csvIsoDate(task.startedAt),
      csvMs(task.durationMs),
      csvUsd(task.knownCostUsd),
      task.feedback ?? '',
      task.flags.join(' '),
    ]);
  }

  return `${rows.map((cells) => cells.map(escapeCsvField).join(',')).join('\r\n')}\r\n`;
}

function describeScope(scope: OutcomeLedgerProjectScope): string {
  switch (scope.kind) {
    case 'all': return 'all projects';
    case 'unassigned': return 'unassigned';
    case 'assigned': return scope.projectId;
  }
}

// Rates are carried as a 0..1 fraction; a null (unknown) rate stays an empty
// cell so a spreadsheet reads it as blank, never as a misleading zero.
function csvRate(value: number | null): string {
  return value == null ? '' : value.toFixed(4);
}

// Kept separate from csvRate despite the identical 4-dp body: a rate and a USD
// amount are distinct quantities, and only one is likely to change format later.
function csvUsd(value: number | null): string {
  return value == null ? '' : value.toFixed(4);
}

function csvMs(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '' : String(Math.round(value));
}

function csvIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

/**
 * RFC-4180 field escaping plus leading-formula neutralisation, mirroring the
 * Cost Comparison panel's escaper. Kept local to the frontend so the bundle
 * stays free of server modules; the two paths are covered by their own tests.
 */
function escapeCsvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (!/[",\n\r]/.test(safe)) return safe;
  return `"${safe.replaceAll('"', '""')}"`;
}

function outcomeCsvFilename(window: TimeWindow, scope: OutcomeLedgerProjectScope): string {
  const scopeSlug = scope.kind === 'assigned'
    ? scope.projectId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
    : scope.kind;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `kookr-outcome-scoreboard-${window}-${scopeSlug}-${stamp}.csv`;
}

function downloadCsv(csv: string, filename: string): void {
  // Lead with a UTF-8 BOM so Excel decodes any non-ASCII glyphs in task labels
  // instead of mojibake.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick: some WebKit builds cancel the download when the
  // object URL is revoked synchronously in the same tick as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// A well-formed scope discriminant. `assigned` must additionally carry a string
// `projectId`, because the CSV export dereferences it (describeScope /
// outcomeCsvFilename); validating the full shape here keeps describeScope's
// exhaustive switch total and stops a malformed scope from throwing on Export.
function isOutcomeLedgerScope(value: unknown): value is OutcomeLedgerProjectScope {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'all' || kind === 'unassigned') return true;
  if (kind === 'assigned') return typeof (value as { projectId?: unknown }).projectId === 'string';
  return false;
}

function isOutcomeLedgerResponse(value: unknown): value is OutcomeLedgerResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OutcomeLedgerResponse>;
  return candidate.schemaVersion === 'outcome-ledger.v1'
    && Boolean(candidate.summary)
    && Boolean(candidate.quality)
    && Boolean(candidate.launchSourceMix?.counts)
    && typeof candidate.comparison?.available === 'boolean'
    // byAgent and scope are read only by the CSV export (#3000), never by the
    // render path — so the guard must vouch for them here or a validated-but-
    // malformed payload would render fine and then throw on Export click.
    && Array.isArray(candidate.byAgent)
    && isOutcomeLedgerScope(candidate.scope)
    && Array.isArray(candidate.findings)
    && Array.isArray(candidate.tasks)
    && Array.isArray(candidate.notes);
}
