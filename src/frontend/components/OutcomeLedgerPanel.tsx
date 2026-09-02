import React, { useEffect, useMemo, useState } from 'react';
import type {
  OutcomeLedgerByAgentRow,
  OutcomeLedgerFinding,
  OutcomeLedgerFindingKind,
  OutcomeLedgerLaunchSource,
  OutcomeLedgerLaunchSourceMix,
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
}

export function OutcomeLedgerPanel({ projects = [] }: OutcomeLedgerPanelProps = {}): React.ReactElement {
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
                <Metric label="completed" value={formatRate(data.summary.completionRate)} detail={`${data.summary.completedTaskCount}/${data.summary.terminalTaskCount}`} />
                <Metric label="PRs" value={String(data.summary.prTaskCount)} detail={`${data.summary.prTaskCount}/${data.summary.taskCount}`} />
                <Metric label="known cost" value={formatMoney(data.summary.totalKnownCostUsd)} detail={`${pct(data.quality.costCoverage)} coverage`} />
                <Metric label="tokens" value={formatTokens(data.summary.totalInputTokens + data.summary.totalOutputTokens)} detail={`${formatTokens(data.summary.totalInputTokens)} in / ${formatTokens(data.summary.totalOutputTokens)} out`} />
                <Metric label="feedback" value={formatRate(data.summary.thumbsUpRate)} detail={`${pct(data.summary.feedbackCoverage)} coverage`} />
                <Metric label="verified" value={pct(data.quality.verificationCoverage)} detail={`${data.quality.verificationKnownCompletedTasks}/${data.summary.completedTaskCount}`} />
                <Metric label="review flags" value={String(data.findings.length)} />
              </div>
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
                  {visibleFindings.map((finding) => <FindingRow key={`${finding.taskId}:${finding.kind}:${finding.metric}`} finding={finding} />)}
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

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }): React.ReactElement {
  return (
    <div className="outcome-metric">
      <span className="outcome-metric-label">{label}</span>
      <strong>{value}</strong>
      {detail && <span className="outcome-metric-detail">{detail}</span>}
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

function FindingRow({ finding }: { finding: OutcomeLedgerFinding }): React.ReactElement {
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
      <span className="outcome-finding-task">{finding.label}</span>
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

function isOutcomeLedgerResponse(value: unknown): value is OutcomeLedgerResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OutcomeLedgerResponse>;
  return candidate.schemaVersion === 'outcome-ledger.v1'
    && Boolean(candidate.summary)
    && Boolean(candidate.quality)
    && Boolean(candidate.launchSourceMix?.counts)
    && Array.isArray(candidate.findings)
    && Array.isArray(candidate.tasks)
    && Array.isArray(candidate.notes);
}
