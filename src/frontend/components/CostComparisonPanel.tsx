import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AggregateMetrics,
  CostAgent,
  CostComparisonResponse,
  PerPlaybookRow,
  PerTaskRow,
  TimeWindow,
  CostDataQuality,
} from '../../shared/contracts/cost-comparison.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllNotes, setShowAllNotes] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEscapeToClose(onClose);

  // Auto-focus the close button on mount so keyboard users land somewhere inside
  // the dialog (otherwise focus stays on the trigger button behind the overlay).
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ window: windowChoice });
    if (agentFilter !== 'all') params.set('agent', agentFilter);
    if (debouncedSearch) params.set('q', debouncedSearch);
    fetch(`/api/cost-comparison?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        return (await r.json()) as CostComparisonResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [windowChoice, agentFilter, debouncedSearch]);

  const visibleNotes = useMemo(() => {
    if (!data) return { primary: [], rest: [] };
    return { primary: data.notes.slice(0, 3), rest: data.notes.slice(3) };
  }, [data]);

  return (
    <div
      className="cost-comparison-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cost-cmp-title"
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
              ref={closeBtnRef}
              className="btn-icon"
              onClick={onClose}
              aria-label="Close cost comparison"
            >×</button>
          </div>
        </header>

        {data && (
          <div className="cost-comparison-meta">
            data as of {new Date(data.scannedAt).toLocaleTimeString()} ({data.scanDurationMs} ms)
          </div>
        )}

        {error && (
          <div className="cost-comparison-error">
            Failed to load: {error}
          </div>
        )}

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
        <table className="cost-table">
          <thead>
            <tr>
              <th>Playbook</th>
              <th>Claude (n)</th>
              <th>Codex (n)</th>
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
                  <td>{formatAgentCell(c)}</td>
                  <td>{formatAgentCell(x)}</td>
                  <td>{formatCostRatio(c, x)}</td>
                  <td>{formatThumbsRatio(c, x)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AggregateSection({ aggregate }: { aggregate: Partial<Record<CostAgent, AggregateMetrics>> }): React.ReactElement {
  const claude = aggregate['claude-code'];
  const codex = aggregate['codex-cli'];
  return (
    <section className="cost-aggregate">
      <h3>Aggregate (across mixed task classes — weak signal)</h3>
      {!claude && !codex ? (
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

function PerTaskSection({ rows }: { rows: PerTaskRow[] }): React.ReactElement {
  return (
    <section className="cost-per-task">
      <h3>Tasks ({rows.length})</h3>
      {rows.length === 0 ? (
        <div className="cost-empty">No tasks match the current filters.</div>
      ) : (
        <table className="cost-table cost-per-task-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Agent</th>
              <th>Model</th>
              <th>Playbook</th>
              <th>Dur</th>
              <th>Cost</th>
              <th>👍</th>
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
                <td>{formatDur(r.durationMs)}</td>
                <td title={r.estimatedCostUsd == null ? dataQualityTooltip(r.dataQuality) : undefined}>
                  {r.estimatedCostUsd == null ? (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">{dataQualityTooltip(r.dataQuality)}</span>
                    </>
                  ) : formatUsd(r.estimatedCostUsd)}
                </td>
                <td>{r.thumb === 'up' ? '👍' : r.thumb === 'down' ? '👎' : '—'}</td>
                <td title={dataQualityTooltip(r.dataQuality)}>
                  <span aria-hidden="true">{dataQualityLabel(r.dataQuality)}</span>
                  <span className="sr-only">{dataQualityTooltip(r.dataQuality)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------- formatting helpers --------------------------------------------------

function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
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

function formatAgentCell(m: AggregateMetrics | undefined): string {
  if (!m) return '—×0';
  const median = m.taskCount > 0 ? m.totalCostUsd / m.taskCount : 0;
  return `${formatUsd(median)}×${m.taskCount}`;
}

function formatCostRatio(c: AggregateMetrics | undefined, x: AggregateMetrics | undefined): string {
  if (!c || !x || c.taskCount === 0 || x.taskCount === 0) return '—';
  const cAvg = c.totalCostUsd / c.taskCount;
  const xAvg = x.totalCostUsd / x.taskCount;
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
  if (m.thumbsUpRate == null) return '—';
  return `${Math.round(m.thumbsUpRate * 100)}%`;
}

function dataQualityLabel(q: CostDataQuality): string {
  switch (q) {
    case 'complete':                  return '●';
    case 'unknown-pricing':           return 'unkpr';
    case 'codex-parse-error':         return 'parse';
    case 'codex-no-tokens':           return 'no-tok';
    case 'codex-rollout-not-found':   return 'no-roll';
    case 'codex-rollout-abandoned':   return 'aband';
  }
}

function dataQualityTooltip(q: CostDataQuality): string {
  switch (q) {
    case 'complete':                  return 'Complete data — cost computed from tokens and a verified pricing row.';
    case 'unknown-pricing':           return 'Tokens are known but the model has no pricing row in pricing-tables.ts. Cost cannot be computed.';
    case 'codex-parse-error':         return 'Codex rollout schema mismatch — see startup log for details.';
    case 'codex-no-tokens':           return 'Codex rollout has no token telemetry (pre-Nov-2025 schema).';
    case 'codex-rollout-not-found':   return 'No Codex rollout file matched this task by (cwd, ±60 s). Possible ambiguity from a batch launch — see logs.';
    case 'codex-rollout-abandoned':   return 'Codex rollout exists but never reached a terminal event (Ctrl-C / kill / crash); excluded from cost.';
  }
}
