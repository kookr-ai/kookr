import React, { useEffect, useMemo, useState } from 'react';
import type {
  OutcomeLedgerFinding,
  OutcomeLedgerResponse,
  OutcomeLedgerTaskRow,
} from '../../shared/contracts/outcome-ledger.js';
import type { TimeWindow } from '../../shared/contracts/cost-comparison.js';

const WINDOWS: { value: TimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'all' },
];

export function OutcomeLedgerPanel(): React.ReactElement {
  const [windowChoice, setWindowChoice] = useState<TimeWindow>('7d');
  const [data, setData] = useState<OutcomeLedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/outcome-ledger?window=${windowChoice}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
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
  }, [windowChoice]);

  const findings = Array.isArray(data?.findings) ? data.findings : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
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
                <Metric label="known cost" value={formatMoney(data.summary.totalKnownCostUsd)} detail={`${pct(data.quality.costCoverage)} coverage`} />
                <Metric label="feedback" value={formatRate(data.summary.thumbsUpRate)} detail={`${pct(data.summary.feedbackCoverage)} coverage`} />
                <Metric label="verified" value={pct(data.quality.verificationCoverage)} detail={`${data.quality.verificationKnownCompletedTasks}/${data.summary.completedTaskCount}`} />
                <Metric label="review flags" value={String(data.findings.length)} />
              </div>
              <div className="outcome-quality-strip">
                <span>{data.quality.missingCostTasks} missing cost</span>
                <span>{data.quality.zeroCostTasks} zero-cost</span>
                <span>{data.quality.invalidTimestampTasks} invalid time</span>
                <span>{pct(data.quality.interventionCoverage)} interventions known</span>
              </div>
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

function FindingRow({ finding }: { finding: OutcomeLedgerFinding }): React.ReactElement {
  return (
    <li className={`outcome-finding ${finding.severity}`}>
      <span className="outcome-finding-severity">{finding.severity}</span>
      <span className="outcome-finding-text">{finding.message}</span>
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

function isOutcomeLedgerResponse(value: unknown): value is OutcomeLedgerResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OutcomeLedgerResponse>;
  return candidate.schemaVersion === 'outcome-ledger.v1'
    && Boolean(candidate.summary)
    && Boolean(candidate.quality)
    && Array.isArray(candidate.findings)
    && Array.isArray(candidate.tasks)
    && Array.isArray(candidate.notes);
}
