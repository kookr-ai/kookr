import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AggregateMetrics,
  CostAgent,
  CostComparisonResponse,
  PerPlaybookRow,
  PerTaskRow,
  TimeWindow,
  CostDataQuality,
  UnboundCodexAggregate,
} from '../../shared/contracts/cost-comparison.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { getCostComparison } from '../api/index.js';

/**
 * Cost Comparison panel (rfc-cost-comparison-panel.md). Renders three sections:
 *
 *   1. Per-playbook table (the headline — supports the qualitative decision rule)
 *   2. Aggregate cards across mixed task classes (labelled "weak signal")
 *   3. Per-task table — one row per Kookr task, virtualization deferred for v1
 *
 * Top of the panel: the time-window selector (24h / 7d / 30d / all), agent
 * filter chips, free-text search, and the R17-priority notes stack (top 3
 * inline, rest collapsed).
 *
 * The panel is read-only telemetry. It does not write back to the server.
 */

interface Props {
  onClose: () => void;
}

const WINDOW_OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d',  label: '7d'  },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'all' },
];

export function CostComparisonPanel({ onClose }: Props): React.ReactElement {
  const [windowChoice, setWindowChoice] = useState<TimeWindow>('7d');
  const [agentFilter, setAgentFilter] = useState<CostAgent | 'all'>('all');
  const [search, setSearch] = useState('');
  // Debounced query string actually sent to the server. Keystrokes update `search` instantly
  // (no input lag); the fetch effect waits 300 ms of quiet before re-firing.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [data, setData] = useState<CostComparisonResponse | null>(null);
  // The window/agent/search that actually produced `data`, captured alongside it.
  // Export reads this (not the live filter state) so an export triggered during
  // an in-flight refetch — or after a refetch error, when `data` still holds the
  // last good payload — labels the file with the query the rows came from (#2422).
  const [dataContext, setDataContext] = useState<CsvExportContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllNotes, setShowAllNotes] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEscapeToClose(onClose);
  // Focus the close button on open and trap Tab inside the aria-modal dialog.
  useDialogFocus({ dialogRef, initialFocusRef: closeBtnRef });

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getCostComparison(
      { window: windowChoice, agent: agentFilter, q: debouncedSearch },
      controller.signal,
    )
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setDataContext({ window: windowChoice, agent: agentFilter, search: debouncedSearch });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [windowChoice, agentFilter, debouncedSearch]);

  const visibleNotes = useMemo(() => {
    if (!data) return { primary: [], rest: [] };
    return { primary: data.notes.slice(0, 3), rest: data.notes.slice(3) };
  }, [data]);

  // Client-side CSV export of the currently displayed per-playbook and per-task
  // rows (#2422) — no new server route. Serialises the same `data` the tables
  // render from and labels it with `dataContext` (the query that produced that
  // data), so window/agent/search in the file always match the rows even when an
  // export races an in-flight refetch.
  function handleExportCsv(): void {
    if (!data || !dataContext) return;
    const csv = buildCostComparisonCsv(data, dataContext);
    downloadCsv(csv, csvFilename(dataContext.window, dataContext.agent));
  }

  return (
    <div
      ref={dialogRef}
      className="cost-comparison-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cost-cmp-title"
      tabIndex={-1}
    >
      <div className="cost-comparison-panel">
        <header className="cost-comparison-header">
          <h2 id="cost-cmp-title">Cost Comparison <span className="cost-est-badge">(est.)</span></h2>
          <div className="cost-comparison-controls">
            <select
              className="cost-window-select"
              value={windowChoice}
              onChange={(e) => setWindowChoice(e.target.value as TimeWindow)}
              aria-label="Time window"
            >
              {WINDOW_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <div className="cost-agent-chips" role="group" aria-label="Filter by agent">
              <AgentChip label="All"    value="all"          current={agentFilter} onClick={setAgentFilter} />
              <AgentChip label="Claude" value="claude-code"  current={agentFilter} onClick={setAgentFilter} />
              <AgentChip label="Codex"  value="codex-cli"    current={agentFilter} onClick={setAgentFilter} />
            </div>
            <input
              className="cost-search"
              type="text"
              placeholder="Search task names…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search task names"
            />
            <button
              type="button"
              className="cost-export-btn"
              onClick={handleExportCsv}
              disabled={!data}
              aria-label="Export cost comparison as CSV"
            >
              Export CSV
            </button>
          </div>
          <button
            ref={closeBtnRef}
            className="btn-icon"
            onClick={onClose}
            aria-label="Close cost comparison"
          >×</button>
        </header>

        {data && (
          <div className="cost-comparison-meta">
            data as of {new Date(data.scannedAt).toLocaleTimeString()} ({data.scanDurationMs} ms)
          </div>
        )}

        {data?.coverage && <CoverageSummary coverage={data.coverage} />}

        {error && (
          <div className="cost-comparison-error">
            Failed to load: {error}
          </div>
        )}

        {data?.unboundCodex && <UnboundCoverageCaveat u={data.unboundCodex} />}

        {data && data.notes.length > 0 && (
          <div className="cost-notes-stack">
            {visibleNotes.primary.map((n, i) => (
              <div key={i} className="cost-note">{n.message}</div>
            ))}
            {visibleNotes.rest.length > 0 && (
              <button
                className="cost-notes-expander"
                aria-expanded={showAllNotes}
                onClick={() => setShowAllNotes(s => !s)}
              >
                {showAllNotes ? 'Hide' : `${visibleNotes.rest.length} more notes`}
              </button>
            )}
            {showAllNotes && visibleNotes.rest.map((n, i) => (
              <div key={`r${i}`} className="cost-note">{n.message}</div>
            ))}
          </div>
        )}

        {loading && <div className="cost-loading">Scanning…</div>}

        {data && (
          <>
            <PerPlaybookSection rows={data.perPlaybook} />
            <AggregateSection aggregate={data.aggregate} />
            <PerTaskSection rows={data.perTask} />
          </>
        )}
      </div>
    </div>
  );
}

function CoverageSummary({ coverage }: { coverage: NonNullable<CostComparisonResponse['coverage']> }): React.ReactElement {
  return (
    <div className="cost-coverage-summary" aria-label="Cost data coverage">
      <span>{coverage.taskCount} tasks</span>
      <span>{coverage.pricedTaskCount} priced</span>
      <span>{coverage.excludedTaskCount} excluded</span>
      {coverage.unboundCodexThreadCount > 0 && <span>{coverage.unboundCodexThreadCount} unbound Codex</span>}
      {coverage.abandonedCodexRolloutCount > 0 && <span>{coverage.abandonedCodexRolloutCount} abandoned</span>}
      {coverage.liveData && <span>{coverage.runningTaskCount} live</span>}
    </div>
  );
}

function AgentChip({ label, value, current, onClick }: {
  label: string; value: CostAgent | 'all'; current: CostAgent | 'all'; onClick: (v: CostAgent | 'all') => void;
}): React.ReactElement {
  const selected = current === value;
  // Toggle-button semantics (`aria-pressed`) match the actual UX better than a tablist
  // would — these chips are filters, not view selectors. The earlier `role="tab"` shape
  // promised arrow-key roving + a `tabpanel` association that was never implemented.
  return (
    <button
      type="button"
      className={`cost-agent-chip${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      onClick={() => onClick(value)}
    >
      {label}
    </button>
  );
}

function PerPlaybookSection({ rows }: { rows: PerPlaybookRow[] }): React.ReactElement {
  return (
    <section className="cost-per-playbook">
      <h3>Per playbook (≥1 run/agent in window)</h3>
      {rows.length === 0 ? (
        <div className="cost-empty">No tasks in this window.</div>
      ) : (
        <div className="cost-table-wrap">
          <table className="cost-table">
            <thead>
              <tr>
                <th>Playbook</th>
                <th>Claude</th>
                <th>Codex</th>
                <th>Cost ratio</th>
                <th>👍 ratio</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const c = row.perAgent['claude-code'];
                const x = row.perAgent['codex-cli'];
                return (
                  <tr key={row.playbookId ?? '<no-playbook>'}>
                    <td>{row.playbookName}</td>
                    <td><AgentMetricCell m={c} /></td>
                    <td><AgentMetricCell m={x} /></td>
                    <td>{formatCostRatio(c, x)}</td>
                    <td>{formatThumbsRatio(c, x)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AggregateSection({ aggregate }: {
  aggregate: Partial<Record<CostAgent, AggregateMetrics>>;
}): React.ReactElement {
  const claude = aggregate['claude-code'];
  const codex = aggregate['codex-cli'];
  const showAny = claude || codex;
  return (
    <section className="cost-aggregate">
      <h3>Aggregate (across mixed task classes — weak signal)</h3>
      {!showAny ? (
        <div className="cost-empty">No tasks in this window.</div>
      ) : (
        <div className="cost-aggregate-grid">
          {claude && <AgentAggregateCard label="Claude" m={claude} />}
          {codex  && <AgentAggregateCard label="Codex"  m={codex} />}
        </div>
      )}
    </section>
  );
}

function AgentMetricCell({ m }: { m: AggregateMetrics | undefined }): React.ReactElement {
  if (!m || m.pricedTaskCount === 0) {
    return (
      <span className="cost-agent-metric" aria-label="No average cost, n equals 0">
        <span className="cost-agent-avg">—</span>
        <span aria-hidden="true"> </span>
        <span className="cost-agent-count">n=0</span>
      </span>
    );
  }
  const average = m.totalCostUsd / m.pricedTaskCount;
  return (
    <span className="cost-agent-metric" aria-label={`${formatUsd(average)} average, n equals ${m.pricedTaskCount}`}>
      <span className="cost-agent-avg">{formatUsd(average)} avg</span>
      <span aria-hidden="true"> </span>
      <span className="cost-agent-count">n={m.pricedTaskCount}</span>
    </span>
  );
}

function AgentAggregateCard({ label, m }: { label: string; m: AggregateMetrics }): React.ReactElement {
  return (
    <div className="cost-aggregate-card">
      <h4>{label}</h4>
      <div className="cost-stat">
        <span className="cost-stat-label">tasks</span> <span className="cost-stat-val">{m.taskCount}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">total</span> <span className="cost-stat-val">{formatUsd(m.totalCostUsd)}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">in tok</span> <span className="cost-stat-val">{formatTokens(m.inputTokens)}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">out tok</span> <span className="cost-stat-val">{formatTokens(m.outputTokens)}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">cache rd</span> <span className="cost-stat-val">{formatTokens(m.cacheReadTokens)}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">med dur</span> <span className="cost-stat-val">{formatDur(m.medianDurationMs)}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">p95 dur</span> <span className="cost-stat-val">{formatDur(m.p95DurationMs)}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">max dur</span> <span className="cost-stat-val">{formatDur(m.maxDurationMs)}</span>
      </div>
      <div className="cost-stat">
        <span className="cost-stat-label">👍 rate</span> <span className="cost-stat-val">{formatThumbsRate(m)}</span>
      </div>
    </div>
  );
}

function UnboundCoverageCaveat({ u }: { u: UnboundCodexAggregate }): React.ReactElement {
  const dq = u.dataQualityCounts;
  const qualityHints: string[] = [];
  if (dq['unknown-pricing'] > 0) qualityHints.push(`${dq['unknown-pricing']} unknown-pricing`);
  if (dq['codex-no-tokens'] > 0) qualityHints.push(`${dq['codex-no-tokens']} no-tokens`);
  if (dq['codex-parse-error'] > 0) qualityHints.push(`${dq['codex-parse-error']} parse-error`);
  return (
    <section className="cost-coverage-caveat" aria-label="Coverage caveats">
      <h3>Coverage caveats</h3>
      <div className="cost-unbound-line">
        <strong>Unbound Codex</strong>
        <span>{u.threadCount} threads</span>
        <span>{formatUsd(u.totalCostUsd)} priced</span>
        <span>{formatTokens(u.totalInputTokens)} input</span>
        <span>{formatTokens(u.totalOutputTokens)} output</span>
        <span>{formatTokens(u.totalCachedInputTokens)} cached input</span>
      </div>
      {qualityHints.length > 0 && (
        <div className="cost-unbound-quality">Incomplete unbound rows: {qualityHints.join(', ')}</div>
      )}
    </section>
  );
}

function PerTaskSection({ rows }: { rows: PerTaskRow[] }): React.ReactElement {
  return (
    <section className="cost-per-task">
      <h3>Tasks ({rows.length})</h3>
      {rows.length === 0 ? (
        <div className="cost-empty">No tasks match the current filters.</div>
      ) : (
        <div className="cost-table-wrap">
          <table className="cost-table cost-per-task-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Agent</th>
                <th>Model</th>
                <th>Playbook</th>
                <th>Dur</th>
                <th>Cost</th>
                <th><span aria-hidden="true">👍</span><span className="sr-only">Feedback</span></th>
                <th>Quality</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.taskId} className={`cost-row dq-${r.dataQuality}`}>
                  <td>{new Date(r.startedAt).toLocaleString()}</td>
                  <td>{r.agent === 'claude-code' ? 'Claude' : 'Codex'}</td>
                  <td>{r.model ?? '—'}</td>
                  <td>{r.playbookId ?? '—'}</td>
                  <td>{formatRowDur(r)}</td>
                  <td title={r.estimatedCostUsd == null ? dataQualityTooltip(r.dataQuality) : undefined}>
                    {r.estimatedCostUsd == null ? (
                      <>
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">{dataQualityTooltip(r.dataQuality)}</span>
                      </>
                    ) : formatUsd(r.estimatedCostUsd)}
                  </td>
                  <td>{formatThumbCell(r.thumb)}</td>
                  <td title={dataQualityTooltip(r.dataQuality)}>
                    <QualityBadge row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QualityBadge({ row }: { row: PerTaskRow }): React.ReactElement {
  const label = dataQualityLabel(row);
  return (
    <span
      className={`cost-quality-badge dq-${row.dataQuality}`}
      aria-label={`${label}: ${dataQualityTooltip(row.dataQuality)}`}
    >
      {label}
    </span>
  );
}

// ---------- formatting helpers --------------------------------------------------

function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDur(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function formatRowDur(row: PerTaskRow): string {
  if (row.status === 'inProgress') return 'running';
  if (!row.isTerminal) return row.status;
  return formatDur(row.durationMs);
}

function formatThumbCell(thumb: PerTaskRow['thumb']): React.ReactElement | string {
  if (thumb === 'up') {
    return <><span aria-hidden="true">👍</span><span className="sr-only">Thumbs-up feedback</span></>;
  }
  if (thumb === 'down') {
    return <><span aria-hidden="true">👎</span><span className="sr-only">Thumbs-down feedback</span></>;
  }
  return '—';
}

function formatCostRatio(c: AggregateMetrics | undefined, x: AggregateMetrics | undefined): string {
  if (!c || !x || c.pricedTaskCount === 0 || x.pricedTaskCount === 0) return '—';
  const cAvg = c.totalCostUsd / c.pricedTaskCount;
  const xAvg = x.totalCostUsd / x.pricedTaskCount;
  if (cAvg === 0 && xAvg === 0) return '—';
  if (cAvg === 0) return `Codex ∞×`;
  if (xAvg === 0) return `Claude ∞×`;
  if (cAvg > xAvg) return `Claude ${(cAvg / xAvg).toFixed(2)}×`;
  if (xAvg > cAvg) return `Codex ${(xAvg / cAvg).toFixed(2)}×`;
  return '1.00×';
}

function formatThumbsRatio(c: AggregateMetrics | undefined, x: AggregateMetrics | undefined): string {
  const cs = c ? formatThumbsRate(c) : '—';
  const xs = x ? formatThumbsRate(x) : '—';
  return `${cs} / ${xs}`;
}

function formatThumbsRate(m: AggregateMetrics): string {
  // Show the sample size so a 100% rate from 1 vote can't be mistaken for a
  // strong signal. Derive BOTH the percentage and the count from the same
  // up+down denominator (not the separately-transported `thumbsUpRate`) so the
  // two can never disagree, even if the transported rate ever drifts. No
  // feedback → no rate is implied.
  const { up, down } = m.thumbsCount;
  const n = up + down;
  if (n === 0) return '—';
  return `${Math.round((up / n) * 100)}% (n=${n})`;
}

function dataQualityLabel(row: PerTaskRow): string {
  if (
    row.dataQuality === 'complete'
    && row.inputTokens === 0
    && row.outputTokens === 0
    && row.cacheReadTokens === 0
    && row.cacheWriteTokens === 0
  ) {
    return 'zero tokens';
  }
  switch (row.dataQuality) {
    case 'complete':                  return 'priced';
    case 'missing-usage':             return 'missing usage';
    case 'unknown-pricing':           return 'unknown price';
    case 'codex-parse-error':         return 'parse error';
    case 'codex-no-tokens':           return 'no tokens';
    case 'codex-rollout-not-found':   return 'missing rollout';
    case 'codex-rollout-abandoned':   return 'abandoned';
  }
}

function dataQualityTooltip(q: CostDataQuality): string {
  switch (q) {
    case 'complete':                  return 'Complete data — cost computed from tokens and a verified pricing row.';
    case 'missing-usage':             return 'Usage not available for this task; no transcript or persisted token snapshot was found.';
    case 'unknown-pricing':           return 'Tokens are known but the model has no pricing row in pricing-tables.ts. Cost cannot be computed.';
    case 'codex-parse-error':         return 'Codex rollout schema mismatch — see startup log for details.';
    case 'codex-no-tokens':           return 'Codex rollout has no token telemetry (pre-Nov-2025 schema).';
    case 'codex-rollout-not-found':   return 'No Codex rollout file matched this task by (cwd, ±60 s). Possible ambiguity from a batch launch — see logs.';
    case 'codex-rollout-abandoned':   return 'Codex rollout exists but never reached a terminal event (Ctrl-C / kill / crash); excluded from cost.';
  }
}

// ---------- CSV export ----------------------------------------------------------

interface CsvExportContext {
  window: TimeWindow;
  agent: CostAgent | 'all';
  search: string;
}

/**
 * Serialise the currently displayed per-playbook and per-task rows to a single
 * CSV document (#2422). Only fields already visible in the panel are emitted —
 * we deliberately do NOT dump raw token counts or the unbound/internal scanner
 * aggregates, to avoid implying a completeness the panel itself caveats.
 *
 * Two labelled sections separated by a blank line: "Per playbook" mirrors the
 * headline table (per-agent average + n, cost ratio, thumbs-up ratio); "Per
 * task" mirrors the task table. A short preamble records the active window /
 * agent filter / search so an exported file is self-describing.
 *
 * Cost figures are emitted as bare numbers (not the "$0.31 avg" display string)
 * so spreadsheets can sum them; timestamps use ISO 8601 for the same reason.
 */
export function buildCostComparisonCsv(
  data: CostComparisonResponse,
  ctx: CsvExportContext,
): string {
  const rows: string[][] = [];

  rows.push(['Cost Comparison export (estimated)']);
  rows.push(['Window', ctx.window]);
  rows.push(['Agent filter', ctx.agent]);
  rows.push(['Search', ctx.search || '(none)']);
  rows.push([]);

  rows.push(['Per playbook']);
  rows.push([
    'Playbook',
    'Claude avg (USD)', 'Claude n',
    'Codex avg (USD)', 'Codex n',
    'Cost ratio', 'Thumbs-up ratio (Claude / Codex)',
  ]);
  for (const row of data.perPlaybook) {
    const c = row.perAgent['claude-code'];
    const x = row.perAgent['codex-cli'];
    rows.push([
      row.playbookName,
      csvAvgUsd(c), csvCount(c),
      csvAvgUsd(x), csvCount(x),
      formatCostRatio(c, x),
      formatThumbsRatio(c, x),
    ]);
  }

  rows.push([]);
  rows.push(['Per task']);
  rows.push(['Started', 'Agent', 'Model', 'Playbook', 'Duration', 'Cost (USD)', 'Feedback', 'Quality']);
  for (const r of data.perTask) {
    rows.push([
      csvIsoDate(r.startedAt),
      r.agent === 'claude-code' ? 'Claude' : 'Codex',
      r.model ?? '',
      r.playbookId ?? '',
      formatRowDur(r),
      r.estimatedCostUsd == null ? '' : r.estimatedCostUsd.toFixed(4),
      r.thumb ?? '',
      dataQualityLabel(r),
    ]);
  }

  return `${rows.map((cells) => cells.map(escapeCsvField).join(',')).join('\r\n')}\r\n`;
}

function csvAvgUsd(m: AggregateMetrics | undefined): string {
  if (!m || m.pricedTaskCount === 0) return '';
  return (m.totalCostUsd / m.pricedTaskCount).toFixed(4);
}

function csvCount(m: AggregateMetrics | undefined): string {
  return String(m?.pricedTaskCount ?? 0);
}

function csvIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

/**
 * RFC-4180 field escaping plus leading-formula neutralisation, mirroring the
 * server's Ralph-export escaper (core/ralph-iteration-log.ts). Escaping lives
 * here rather than being imported so the frontend bundle stays free of server
 * modules; the two paths are covered by their own tests.
 */
function escapeCsvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (!/[",\n\r]/.test(safe)) return safe;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvFilename(window: TimeWindow, agent: CostAgent | 'all'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `kookr-cost-comparison-${window}-${agent}-${stamp}.csv`;
}

function downloadCsv(csv: string, filename: string): void {
  // Lead with a UTF-8 BOM so Excel decodes the non-ASCII glyphs the panel emits
  // (× / ∞ / — in the ratio and duration columns) instead of mojibake.
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
