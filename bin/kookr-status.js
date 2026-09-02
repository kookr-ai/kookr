#!/usr/bin/env node
// Kookr CLI status command — prints a human-readable snapshot of the running
// Kookr instance. Read-only, no mutations, no external dependencies.
// Contract: reads `AgentState[]` from /api/snapshot, `{ serverStartedAt,
// build.version }` from /api/health, and the readiness verdict from /api/ready
// (see src/server/routes/diagnostics-routes.ts).
// Auto-detects port (4800 → 4801) when KOOKR_PORT is unset.

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  firstRestartIntentAcrossPorts,
  describeUnreachableCause,
  restartIntentJson,
  readUnreachableCause,
} from './kookr-restart-intent.js';

const PORTS_TO_TRY = [4800, 4801];
const SEVERITIES = /** @type {const} */ (['critical', 'warning', 'info']);
const FAIL_ON_VALUES = /** @type {const} */ ([...SEVERITIES, 'none']);
const FINDINGS_EXIT_CODE = 5;
const READINESS_EXIT_CODE = 6;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'terminated']);
// Bounded per-request deadlines (issue #2848). Health is the required liveness
// probe; a slow /api/snapshot must not block the whole status request, so the
// snapshot and the degraded-path task list each carry their own bounded timeout.
const SNAPSHOT_TIMEOUT_MS = 2000;
const READINESS_TIMEOUT_MS = 2000;
const TASKS_TIMEOUT_MS = 2000;
// Machine-readable status is a closed JSON document. A size limit is
// reasonable, but slicing the serialized byte stream at 80 KiB (the
// 2026-08-25 fleet dump ended mid-string; jq then failed) removes that
// contract. Bound collections and oversized strings first, then stringify.
const STATUS_JSON_MAX_BYTES = 80 * 1024;
const STATUS_JSON_MAX_STRING_BYTES = 4 * 1024;
/** Named collections that may be shortened so the envelope stays under budget. */
const STATUS_JSON_COLLECTIONS = [
  { name: 'agents', path: ['agents'] },
  { name: 'findings', path: ['summary', 'findings'] },
];
const HELP_TEXT = `kookr status — print a read-only snapshot of a running Kookr instance.

Usage:
  kookr status [--json] [--require-ready] [--fail-on <critical|warning|info|none>]
  kookr-status [--json] [--require-ready] [--fail-on <critical|warning|info|none>]
                                                                     Deprecated compatibility alias.

Options:
  --json                    Print one complete machine-readable JSON envelope to stdout.
                            Large fleets are bounded structurally at 80 KiB.
  --fail-on <severity>      Exit ${FINDINGS_EXIT_CODE} when active findings meet or exceed
                            critical, warning, info, or none.
  --require-ready           Exit ${READINESS_EXIT_CODE} unless /api/ready confirms readiness.
  -h, --help                Show this help.

Environment:
  KOOKR_PORT                     Specific port on 127.0.0.1.
  KOOKR_STATUS_JSON_MAX_BYTES    Max serialized size of --json output
                                 (default: 81920 / 80 KiB).
`;

// Issue #708: a non-loopback server requires a bearer token. kookr-status only
// issues safe GETs (which the gate lets through), but the token is attached when
// present so the CLI keeps working if read endpoints are gated in the future.
function apiAuthHeaders(env = process.env) {
  const token = env.KOOKR_API_TOKEN && env.KOOKR_API_TOKEN.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(url, timeoutMs = 2000) {
  const res = await fetch(url, {
    headers: apiAuthHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// Readiness is optional for backward compatibility with older Kookr servers.
// Unlike fetchJson(), this accepts the endpoint's expected 503 response so the
// not-ready verdict and its checks remain available to operators and scripts.
async function fetchReadiness(url, timeoutMs = READINESS_TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      headers: apiAuthHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      return {
        status: 'unavailable',
        available: false,
        ready: null,
        httpStatus: res.status,
        checks: null,
        error: res.ok ? 'unexpected /api/ready response' : status,
      };
    }

    if (!isRecord(body) || typeof body.ready !== 'boolean' || !isRecord(body.checks)) {
      return {
        status: 'unavailable',
        available: false,
        ready: null,
        httpStatus: res.status,
        checks: null,
        error: 'unexpected /api/ready response',
      };
    }

    const ready = res.ok && body.ready;
    return {
      status: ready ? 'ready' : 'not-ready',
      available: true,
      ready,
      httpStatus: res.status,
      checks: body.checks,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      available: false,
      ready: null,
      httpStatus: null,
      checks: null,
      error: errMessage(err),
    };
  }
}

function parsePortEnv(raw) {
  if (raw === undefined || raw === '') return { kind: 'unset' };
  const trimmed = String(raw).trim();
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { kind: 'invalid', raw };
  }
  return { kind: 'valid', port };
}

async function resolvePort(env = process.env) {
  const parsed = parsePortEnv(env.KOOKR_PORT);
  if (parsed.kind === 'invalid') return { kind: 'invalid', raw: parsed.raw };
  if (parsed.kind === 'valid') return { kind: 'explicit', port: parsed.port };
  for (const port of PORTS_TO_TRY) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/api/health`, 500);
      return { kind: 'auto', port };
    } catch {}
  }
  return { kind: 'none' };
}

function formatUptime(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return 'unknown';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatCost(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function isActiveFinding(agent) {
  const status = agent.taskStatus;
  return Boolean(
    agent.anomaly
      && !agent.snoozedUntil
      && !agent.suppressed
      && status !== 'pending'
      && !TERMINAL_STATUSES.has(status),
  );
}

function summarize(agents) {
  const statusCounts = Object.create(null);
  const severityCounts = Object.create(null);
  for (const s of SEVERITIES) severityCounts[s] = 0;
  const findings = [];
  let totalCost = 0;
  for (const agent of agents) {
    const status = agent.taskStatus ?? 'unknown';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const cost = agent.tokenUsage?.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      totalCost += cost;
    }
    if (isActiveFinding(agent)) {
      const severity = agent.anomaly.severity;
      if (Object.hasOwn(severityCounts, severity)) severityCounts[severity] += 1;
      findings.push({
        agentId: agent.agentId,
        taskName: agent.taskName ?? agent.agentId,
        type: agent.anomaly.type,
        severity,
        explanation: agent.anomaly.explanation,
      });
    }
  }
  return { statusCounts, severityCounts, findings, totalCost };
}

function hasFindingsAtOrAbove(summary, failOn) {
  if (failOn === 'none') return false;
  const thresholdIndex = SEVERITIES.indexOf(failOn);
  if (thresholdIndex < 0) return false;
  return SEVERITIES
    .slice(0, thresholdIndex + 1)
    .some((severity) => summary.severityCounts[severity] > 0);
}

function highestKnownSeverity(summary) {
  return SEVERITIES.find((severity) => summary.severityCounts[severity] > 0) ?? null;
}

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// Degraded-path task outcome summary (issue #2848). When the full /api/snapshot
// event history is slow or unavailable, machine-readable status rebuilds the
// stable summary from the bounded compact task list (`/api/tasks?view=compact`),
// which omits event histories and multi-KB prompt bodies. Counts tasks by status
// and sums per-task cost. Findings/anomalies are NOT derivable here (they live in
// live monitor state), so the degraded envelope marks them omitted.
function summarizeTasks(tasks) {
  const statusCounts = Object.create(null);
  let totalCost = 0;
  for (const task of tasks) {
    const status = task.status ?? 'unknown';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const cost = task.tokenUsage?.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) totalCost += cost;
  }
  return { statusCounts, totalCost, count: tasks.length };
}

// Pipeline starvation projection (issue #2183). /api/health publishes
// `pipelineStarvation.repos` (schema pipeline-starvation.v1) with per-repo
// `consecutiveBlockedEmpty` (belt-empty droughts cycling starvation scouts) and
// the effective adaptive scout cooldown. Surface only ELEVATED repos
// (consecutiveBlockedEmpty > 0) so steady state stays quiet; return null (a
// no-op for both text and --json) when the block is absent or all repos idle.
function summarizePipelineStarvation(health) {
  const repos = health?.pipelineStarvation?.repos;
  if (!repos || typeof repos !== 'object') return null;
  const rows = [];
  for (const key of Object.keys(repos).sort()) {
    const row = repos[key];
    if (!row || typeof row !== 'object') continue;
    const consecutive = Number(row.consecutiveBlockedEmpty);
    if (!Number.isFinite(consecutive) || consecutive <= 0) continue;
    const cooldown = Number(row.effectiveScoutCooldownMs);
    rows.push({
      repo: typeof row.repo === 'string' && row.repo.length > 0 ? row.repo : key,
      consecutiveBlockedEmpty: Math.floor(consecutive),
      effectiveScoutCooldownMs: Number.isFinite(cooldown) && cooldown > 0 ? Math.floor(cooldown) : 0,
    });
  }
  if (rows.length === 0) return null;
  return { elevated: rows.length, repos: rows };
}

// Humanized RSS for stale-process operator lines (issue #2209). Binary units so
// multi-GB dtach leaks stay readable; sub-KB values floor to whole bytes.
function formatRss(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Stale-process projection (issue #2209). /api/health publishes
// `staleProcesses.{dtach,relayServer}.{count,rssBytes}` for host-wide leak
// visibility. Surface only elevated classes (count > 0) so steady state stays
// quiet; return null (a no-op for both text and --json) when the block is
// absent or all counts are zero. Visibility only — never reaps.
function summarizeStaleProcesses(health) {
  const block = health?.staleProcesses;
  if (!block || typeof block !== 'object') return null;
  /** @param {unknown} row */
  function elevatedClass(row) {
    if (!row || typeof row !== 'object') return null;
    const count = Number(/** @type {{ count?: unknown }} */ (row).count);
    if (!Number.isFinite(count) || count <= 0) return null;
    const rssRaw = Number(/** @type {{ rssBytes?: unknown }} */ (row).rssBytes);
    const rssBytes = Number.isFinite(rssRaw) && rssRaw > 0 ? Math.floor(rssRaw) : 0;
    return { count: Math.floor(count), rssBytes };
  }
  const dtach = elevatedClass(block.dtach);
  const relayServer = elevatedClass(block.relayServer);
  if (!dtach && !relayServer) return null;
  return {
    ...(dtach ? { dtach } : {}),
    ...(relayServer ? { relayServer } : {}),
  };
}

// Host-stale dtach reaper projection (issue #2386). /api/health publishes
// `hostStaleDtachReaper` (issues #2356 / #2384) with lastUnderPressure,
// lastDtachCount, and reaped totals. Surface when under pressure or any reaped
// total is elevated so headless operators see active reclaim without curling
// health; quiet fleets stay silent. Null when absent or non-elevated.
// Visibility only — never changes reaper policy.
function summarizeHostStaleDtachReaper(health) {
  const block = health?.hostStaleDtachReaper;
  if (!block || typeof block !== 'object') return null;

  const lastUnderPressure = Boolean(
    /** @type {{ lastUnderPressure?: unknown }} */ (block).lastUnderPressure,
  );

  const dtachRaw = /** @type {{ lastDtachCount?: unknown }} */ (block).lastDtachCount;
  let lastDtachCount = null;
  if (dtachRaw !== null && dtachRaw !== undefined) {
    const n = Number(dtachRaw);
    if (Number.isFinite(n) && n >= 0) lastDtachCount = Math.floor(n);
  }

  const lastReapedRaw = Number(
    /** @type {{ lastHostStaleDtachReaped?: unknown }} */ (block).lastHostStaleDtachReaped,
  );
  const lastHostStaleDtachReaped =
    Number.isFinite(lastReapedRaw) && lastReapedRaw >= 0
      ? Math.floor(lastReapedRaw)
      : 0;

  const totalReapedRaw = Number(
    /** @type {{ totalHostStaleDtachReaped?: unknown }} */ (block).totalHostStaleDtachReaped,
  );
  const totalHostStaleDtachReaped =
    Number.isFinite(totalReapedRaw) && totalReapedRaw >= 0
      ? Math.floor(totalReapedRaw)
      : 0;

  if (
    !lastUnderPressure
    && lastHostStaleDtachReaped <= 0
    && totalHostStaleDtachReaped <= 0
  ) {
    return null;
  }

  return {
    lastUnderPressure,
    lastDtachCount,
    lastHostStaleDtachReaped,
    totalHostStaleDtachReaped,
  };
}

// Payload-diet projection (issue #2220). /api/health publishes
// `payloadDiet.{trackedTasks,terminalTasks,lastSnapshotBytes}` from the same
// getter already logged at boot/prune. Always-on compact gauge whenever the
// block is present — operators need steady-state pressure, not only spikes
// (capacity, by contrast, is elevated-only — see summarizeCapacity). Return
// null when the block is absent (older server / partial health fixture).
// PLACEHOLDER_REMOVE — operators need steady-state pressure, not
// only spikes. Return null when the block is absent (older server / partial
// health fixture).
function summarizePayloadDiet(health) {
  const block = health?.payloadDiet;
  if (!block || typeof block !== 'object') return null;
  const trackedRaw = Number(/** @type {{ trackedTasks?: unknown }} */ (block).trackedTasks);
  const terminalRaw = Number(/** @type {{ terminalTasks?: unknown }} */ (block).terminalTasks);
  if (!Number.isFinite(trackedRaw) || !Number.isFinite(terminalRaw)) return null;
  const snapRaw = /** @type {{ lastSnapshotBytes?: unknown }} */ (block).lastSnapshotBytes;
  let lastSnapshotBytes = null;
  if (snapRaw !== null && snapRaw !== undefined) {
    const n = Number(snapRaw);
    if (Number.isFinite(n) && n >= 0) lastSnapshotBytes = Math.floor(n);
  }
  return {
    trackedTasks: Math.floor(trackedRaw),
    terminalTasks: Math.floor(terminalRaw),
    lastSnapshotBytes,
  };
}

// Hook replay-checkpoint projection (issue #2281). /api/health publishes
// `hookReplayCheckpoints.{sessionCount,fileBytes}` (or null when disabled).
// Surface whenever the block is a non-null object with finite counters so
// --json mirrors health; human render is elevated-only (non-zero sessions or
// bytes). Return null when absent, null-on-health (disabled), or non-numeric.
function summarizeHookReplayCheckpoints(health) {
  const block = health?.hookReplayCheckpoints;
  if (block === null || block === undefined) return null;
  if (typeof block !== 'object') return null;
  const sessionsRaw = Number(/** @type {{ sessionCount?: unknown }} */ (block).sessionCount);
  const bytesRaw = Number(/** @type {{ fileBytes?: unknown }} */ (block).fileBytes);
  if (!Number.isFinite(sessionsRaw) || !Number.isFinite(bytesRaw)) return null;
  if (sessionsRaw < 0 || bytesRaw < 0) return null;
  return {
    sessionCount: Math.floor(sessionsRaw),
    fileBytes: Math.floor(bytesRaw),
  };
}

// First-hook miss projection (issue #2235). /api/health publishes scalar
// `firstHookMissTotal` (process-lifetime reaps for launches that never emitted
// SessionStart / any agent hook — see issue #2036). Surface only when total > 0
// so steady state stays quiet; return null (no-op for text and --json) when
// the field is absent, non-numeric, or zero.
function summarizeFirstHookMiss(health) {
  const raw = health?.firstHookMissTotal;
  if (raw === undefined || raw === null) return null;
  const total = Number(raw);
  if (!Number.isFinite(total) || total <= 0) return null;
  return { firstHookMissTotal: Math.floor(total) };
}

// Capacity projection (issue #2234). /api/health already publishes the full
// capacity ledger (`effectiveWorking`, `phantomActive`, `utilizationPct`,
// `byClass`, free slots…). Remote operators and Lucy/Discord digests only saw
// findings — not capacity truth — so a 93.8% nominal fleet with phantom slots
// looked healthy. Surface a slim projection when phantomActive > 0, the util
// gap is large, or nominal utilization is high; steady-state healthy fleets
// stay quiet. Visibility only — never mutates admission.
const CAPACITY_HIGH_UTIL_PCT = 75;
const CAPACITY_UTIL_GAP_PCT = 10;
const CAPACITY_BY_CLASS_KEYS = /** @type {const} */ ([
  'working',
  'finishedAwaitingAck',
  'hungSuspect',
  'launching',
]);

function formatUtilPct(pct) {
  if (!Number.isFinite(pct)) return '0';
  return String(Number(pct.toFixed(2)));
}

function summarizeCapacity(health) {
  const block = health?.capacity;
  if (!block || typeof block !== 'object') return null;

  const maxActiveTasks = Number(/** @type {{ maxActiveTasks?: unknown }} */ (block).maxActiveTasks);
  const active = Number(/** @type {{ active?: unknown }} */ (block).active);
  const free = Number(/** @type {{ free?: unknown }} */ (block).free);
  const effectiveWorking = Number(/** @type {{ effectiveWorking?: unknown }} */ (block).effectiveWorking);
  const phantomActive = Number(/** @type {{ phantomActive?: unknown }} */ (block).phantomActive);
  const utilizationPct = Number(/** @type {{ utilizationPct?: unknown }} */ (block).utilizationPct);
  const effectiveUtilizationPct = Number(
    /** @type {{ effectiveUtilizationPct?: unknown }} */ (block).effectiveUtilizationPct,
  );
  if (
    !Number.isFinite(maxActiveTasks)
    || !Number.isFinite(active)
    || !Number.isFinite(free)
    || !Number.isFinite(effectiveWorking)
    || !Number.isFinite(phantomActive)
    || !Number.isFinite(utilizationPct)
    || !Number.isFinite(effectiveUtilizationPct)
  ) {
    return null;
  }

  const byClassRaw = /** @type {{ byClass?: unknown }} */ (block).byClass;
  if (!byClassRaw || typeof byClassRaw !== 'object') return null;
  /** @type {Record<string, number>} */
  const byClass = {};
  for (const key of CAPACITY_BY_CLASS_KEYS) {
    const n = Number(/** @type {Record<string, unknown>} */ (byClassRaw)[key]);
    if (!Number.isFinite(n)) return null;
    byClass[key] = Math.floor(n);
  }

  const utilGap = utilizationPct - effectiveUtilizationPct;
  const elevated =
    phantomActive > 0
    || utilGap >= CAPACITY_UTIL_GAP_PCT
    || utilizationPct >= CAPACITY_HIGH_UTIL_PCT;
  if (!elevated) return null;

  /** @type {{
   *   maxActiveTasks: number,
   *   active: number,
   *   free: number,
   *   effectiveWorking: number,
   *   phantomActive: number,
   *   utilizationPct: number,
   *   effectiveUtilizationPct: number,
   *   byClass: Record<string, number>,
   *   freeForGeneralSources?: number,
   * }} */
  const summary = {
    maxActiveTasks: Math.floor(maxActiveTasks),
    active: Math.floor(active),
    free: Math.floor(free),
    effectiveWorking: Math.floor(effectiveWorking),
    phantomActive: Math.floor(phantomActive),
    utilizationPct,
    effectiveUtilizationPct,
    byClass,
  };

  const freeGeneralRaw = /** @type {{ freeForGeneralSources?: unknown }} */ (block).freeForGeneralSources;
  if (freeGeneralRaw !== undefined && freeGeneralRaw !== null) {
    const freeGeneral = Number(freeGeneralRaw);
    if (Number.isFinite(freeGeneral)) {
      summary.freeForGeneralSources = Math.floor(freeGeneral);
    }
  }

  return summary;
}

// Provider-paused occupancy projection (issue #2236). /api/health already
// publishes the full providerPausedOccupancy block (issue #2079). Surface a
// quiet-by-default slim warning when count > 0 so unattended hosts and
// remote operators see quota-pause pressure without curling health. Null
// when absent or count is zero (steady state). Does not weaken open-PR
// fail-safes — visibility only.
function summarizeProviderPausedOccupancy(health) {
  const block = health?.providerPausedOccupancy;
  if (!block || typeof block !== 'object') return null;
  const countRaw = Number(/** @type {{ count?: unknown }} */ (block).count);
  if (!Number.isFinite(countRaw) || countRaw <= 0) return null;
  const ageRaw = /** @type {{ oldestPauseAgeMs?: unknown }} */ (block).oldestPauseAgeMs;
  let oldestPauseAgeMs = null;
  if (ageRaw !== null && ageRaw !== undefined) {
    const n = Number(ageRaw);
    if (Number.isFinite(n) && n >= 0) oldestPauseAgeMs = Math.floor(n);
  }
  const reclaimAttemptedRaw = Number(
    /** @type {{ reclaimAttempted?: unknown }} */ (block).reclaimAttempted,
  );
  const reclaimedTotalRaw = Number(
    /** @type {{ reclaimedTotal?: unknown }} */ (block).reclaimedTotal,
  );
  const softTtlRaw = Number(/** @type {{ softTtlMs?: unknown }} */ (block).softTtlMs);
  const effectiveTtlRaw = Number(
    /** @type {{ effectiveTtlMs?: unknown }} */ (block).effectiveTtlMs,
  );
  const capacityEarlyReclaim = Boolean(
    /** @type {{ capacityEarlyReclaim?: unknown }} */ (block).capacityEarlyReclaim,
  );
  return {
    count: Math.floor(countRaw),
    oldestPauseAgeMs,
    reclaimAttempted:
      Number.isFinite(reclaimAttemptedRaw) && reclaimAttemptedRaw >= 0
        ? Math.floor(reclaimAttemptedRaw)
        : 0,
    reclaimedTotal:
      Number.isFinite(reclaimedTotalRaw) && reclaimedTotalRaw >= 0
        ? Math.floor(reclaimedTotalRaw)
        : 0,
    // Issue #2225: soft/capacity early reclaim policy (optional on older servers).
    softTtlMs:
      Number.isFinite(softTtlRaw) && softTtlRaw > 0 ? Math.floor(softTtlRaw) : null,
    effectiveTtlMs:
      Number.isFinite(effectiveTtlRaw) && effectiveTtlRaw > 0
        ? Math.floor(effectiveTtlRaw)
        : null,
    capacityEarlyReclaim,
  };
}

// Non-critical timer pause projection (issue #2230). /api/health already
// publishes the full nonCriticalTimerPause block (issue #1785 / #1812). Surface
// a quiet-by-default slim warning when the gate is currently paused, event-loop
// delay p95 is above threshold, or pausedTicksTotal > 0 (process-lifetime
// residual from a latency incident). Null when the block is absent or healthy
// (paused=false, zero ticks, p95 ≤ threshold). Visibility only.
function summarizeNonCriticalTimerPause(health) {
  const block = health?.nonCriticalTimerPause;
  if (!block || typeof block !== 'object') return null;

  const paused = Boolean(/** @type {{ paused?: unknown }} */ (block).paused);
  const thresholdRaw = Number(/** @type {{ thresholdMs?: unknown }} */ (block).thresholdMs);
  const thresholdMs =
    Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? Math.floor(thresholdRaw) : 0;

  const p95Raw = /** @type {{ lastEventLoopDelayP95Ms?: unknown }} */ (block).lastEventLoopDelayP95Ms;
  let lastEventLoopDelayP95Ms = null;
  if (p95Raw !== null && p95Raw !== undefined) {
    const n = Number(p95Raw);
    if (Number.isFinite(n) && n >= 0) lastEventLoopDelayP95Ms = Math.floor(n);
  }

  const ticksRaw = Number(/** @type {{ pausedTicksTotal?: unknown }} */ (block).pausedTicksTotal);
  const pausedTicksTotal =
    Number.isFinite(ticksRaw) && ticksRaw > 0 ? Math.floor(ticksRaw) : 0;

  const p95Elevated =
    lastEventLoopDelayP95Ms !== null
    && thresholdMs > 0
    && lastEventLoopDelayP95Ms > thresholdMs;
  if (!paused && pausedTicksTotal <= 0 && !p95Elevated) return null;

  return {
    paused,
    thresholdMs,
    lastEventLoopDelayP95Ms,
    pausedTicksTotal,
  };
}

// Snapshot rebuild shed projection (issue #2299 / #1775). /api/health publishes
// snapshotShed.{thresholdMs,lastEventLoopDelayP95Ms,shedTotal}. --json mirrors
// the slim gauge whenever the block is present (including shedTotal=0) so remote
// digests see the counter without curling health; human render is elevated-only
// (shedTotal > 0) because zero sheds is steady state. Null when absent or the
// counters are non-numeric. Visibility only — does not change shed behavior.
function summarizeSnapshotShed(health) {
  const block = health?.snapshotShed;
  if (!block || typeof block !== 'object') return null;

  const shedRaw = Number(/** @type {{ shedTotal?: unknown }} */ (block).shedTotal);
  if (!Number.isFinite(shedRaw) || shedRaw < 0) return null;
  const shedTotal = Math.floor(shedRaw);

  const thresholdRaw = Number(/** @type {{ thresholdMs?: unknown }} */ (block).thresholdMs);
  const thresholdMs =
    Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? Math.floor(thresholdRaw) : 0;

  const p95Raw = /** @type {{ lastEventLoopDelayP95Ms?: unknown }} */ (block).lastEventLoopDelayP95Ms;
  let lastEventLoopDelayP95Ms = null;
  if (p95Raw !== null && p95Raw !== undefined) {
    const n = Number(p95Raw);
    if (Number.isFinite(n) && n >= 0) lastEventLoopDelayP95Ms = Math.floor(n);
  }

  return {
    thresholdMs,
    lastEventLoopDelayP95Ms,
    shedTotal,
  };
}

// Hook-ingestion lag projection (issue #2319). /api/health publishes
// hookIngestion.{sessionCount,notableLagCount,maxLagMs,p95LagMs,...} from the
// in-memory diagnostics snapshot when ingestion is wired. --json mirrors the
// slim block whenever present (including zeros) so remote digests see lag
// without scraping /api/diagnostics/hook-ingestion; human render is
// elevated-only (notableLagCount > 0). Null when absent or non-numeric.
// Visibility only — never changes readiness.
function summarizeHookIngestion(health) {
  const block = health?.hookIngestion;
  if (!block || typeof block !== 'object') return null;

  const sessionsRaw = Number(/** @type {{ sessionCount?: unknown }} */ (block).sessionCount);
  const notableRaw = Number(/** @type {{ notableLagCount?: unknown }} */ (block).notableLagCount);
  if (!Number.isFinite(sessionsRaw) || sessionsRaw < 0) return null;
  if (!Number.isFinite(notableRaw) || notableRaw < 0) return null;

  const thresholdRaw = Number(
    /** @type {{ lagWarningThresholdMs?: unknown }} */ (block).lagWarningThresholdMs,
  );
  const lagWarningThresholdMs =
    Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? Math.floor(thresholdRaw) : 0;

  /** @param {unknown} raw */
  function nullableNonNegMs(raw) {
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  }

  const generatedAtRaw = /** @type {{ generatedAt?: unknown }} */ (block).generatedAt;
  const generatedAt =
    typeof generatedAtRaw === 'string' && generatedAtRaw.length > 0
      ? generatedAtRaw
      : undefined;

  return {
    sessionCount: Math.floor(sessionsRaw),
    notableLagCount: Math.floor(notableRaw),
    lagWarningThresholdMs,
    maxLagMs: nullableNonNegMs(/** @type {{ maxLagMs?: unknown }} */ (block).maxLagMs),
    p95LagMs: nullableNonNegMs(/** @type {{ p95LagMs?: unknown }} */ (block).p95LagMs),
    ...(generatedAt ? { generatedAt } : {}),
  };
}

// Launch-dependency degradation projection (issue #2363). /api/health publishes
// launchDependencies (schema launch-dependency-diagnostics.v1) with
// totalDegradedTasks, totalFindings, and per-dependency / per-category rollups.
// --json mirrors a slim counts object whenever the block is present (including
// totalDegradedTasks=0) so remote digests see residual launch preflight debt
// without curling health; human render is elevated-only (totalDegradedTasks > 0).
// Omits affectedTaskIds — operators that need ids still use /api/health.
// Null when absent or non-numeric. Visibility only.
function summarizeLaunchDependencies(health) {
  const block = health?.launchDependencies;
  if (!block || typeof block !== 'object') return null;

  const degradedRaw = Number(
    /** @type {{ totalDegradedTasks?: unknown }} */ (block).totalDegradedTasks,
  );
  const findingsRaw = Number(
    /** @type {{ totalFindings?: unknown }} */ (block).totalFindings,
  );
  if (!Number.isFinite(degradedRaw) || degradedRaw < 0) return null;
  if (!Number.isFinite(findingsRaw) || findingsRaw < 0) return null;

  /** @type {Array<{ dependency: string, degradedTaskCount: number, categories: string[] }>} */
  const dependencies = [];
  const depsRaw = /** @type {{ dependencies?: unknown }} */ (block).dependencies;
  if (Array.isArray(depsRaw)) {
    for (const row of depsRaw) {
      if (!row || typeof row !== 'object') continue;
      const name = /** @type {{ dependency?: unknown }} */ (row).dependency;
      if (typeof name !== 'string' || name.length === 0) continue;
      const countRaw = Number(
        /** @type {{ degradedTaskCount?: unknown }} */ (row).degradedTaskCount,
      );
      if (!Number.isFinite(countRaw) || countRaw < 0) continue;
      const catsRaw = /** @type {{ categories?: unknown }} */ (row).categories;
      /** @type {string[]} */
      const categories = [];
      if (Array.isArray(catsRaw)) {
        for (const cat of catsRaw) {
          if (typeof cat === 'string' && cat.length > 0) categories.push(cat);
        }
      }
      dependencies.push({
        dependency: name,
        degradedTaskCount: Math.floor(countRaw),
        categories,
      });
    }
  }

  return {
    totalDegradedTasks: Math.floor(degradedRaw),
    totalFindings: Math.floor(findingsRaw),
    dependencies,
  };
}

// How many schedule names the human WARN line lists before "+N more".
// Discord/Lucy digests stay one line; --json still carries the full roster.
const SCHEDULES_PAUSED_SAMPLE_LIMIT = 3;

// Fail-closed consecutive-failure pauses (issue #2424). /api/health already
// publishes health.schedules.schedulesPausedByFailure when the runner has
// parked one or more schedules after consecutiveFailures ≥ 3. Elevated-only
// human WARN so Lucy/Discord see the pause without fetching the 14KB health
// blob; --json repeats the slim {id, name, consecutiveFailures} rows.
// Null when the array is absent, empty, or every row is malformed.
// Visibility only — does not auto-resume, does not touch /api/ready.
function summarizeSchedulesPausedByFailure(health) {
  const raw = health?.schedules?.schedulesPausedByFailure;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  /** @type {Array<{ id: string, name: string, consecutiveFailures: number }>} */
  const rows = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const id = /** @type {{ id?: unknown }} */ (row).id;
    const name = /** @type {{ name?: unknown }} */ (row).name;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof name !== 'string' || name.length === 0) continue;
    const failuresRaw = Number(
      /** @type {{ consecutiveFailures?: unknown }} */ (row).consecutiveFailures,
    );
    if (!Number.isFinite(failuresRaw) || failuresRaw < 0) continue;
    rows.push({
      id,
      name,
      consecutiveFailures: Math.floor(failuresRaw),
    });
  }
  return rows.length > 0 ? rows : null;
}

// Startup crash-recovery counts (issue #2351). /api/health publishes a slim
// `startupRecovery` block after deferred recovery completes (relaunched /
// skipped / failed / crashLoopSkips + generatedAt). Always-on compact gauge
// when present so unattended hosts and Lucy/Discord digests see post-restart
// recovery without curling /api/startup-summary. Null when absent or non-numeric.
// Visibility only — does not change recovery policy.
function summarizeStartupRecovery(health) {
  const block = health?.startupRecovery;
  if (!block || typeof block !== 'object') return null;

  const relaunched = Number(/** @type {{ relaunched?: unknown }} */ (block).relaunched);
  const skipped = Number(/** @type {{ skipped?: unknown }} */ (block).skipped);
  const failed = Number(/** @type {{ failed?: unknown }} */ (block).failed);
  const crashLoopSkips = Number(
    /** @type {{ crashLoopSkips?: unknown }} */ (block).crashLoopSkips,
  );
  if (!Number.isFinite(relaunched) || relaunched < 0) return null;
  if (!Number.isFinite(skipped) || skipped < 0) return null;
  if (!Number.isFinite(failed) || failed < 0) return null;
  if (!Number.isFinite(crashLoopSkips) || crashLoopSkips < 0) return null;

  const generatedRaw = /** @type {{ generatedAt?: unknown }} */ (block).generatedAt;
  const generatedAt =
    typeof generatedRaw === 'string' && generatedRaw.length > 0 ? generatedRaw : null;

  return {
    relaunched: Math.floor(relaunched),
    skipped: Math.floor(skipped),
    failed: Math.floor(failed),
    crashLoopSkips: Math.floor(crashLoopSkips),
    generatedAt,
  };
}

// OSS attempts projection (issue #2332). /api/health publishes a slim
// `ossAttempts` block when the store is wired (open/total counts, lastRefreshAt,
// issueCheckErrorCount). Always-on compact gauge whenever openCount+totalCount
// are numeric so operators see contribution-gate pressure without curling the
// full /api/oss-attempts payload. Null when absent or non-numeric.
// Visibility only — does not change rate-limit policy.
function summarizeOssAttempts(health) {
  const block = health?.ossAttempts;
  if (!block || typeof block !== 'object') return null;

  const openRaw = Number(/** @type {{ openCount?: unknown }} */ (block).openCount);
  const totalRaw = Number(/** @type {{ totalCount?: unknown }} */ (block).totalCount);
  if (!Number.isFinite(openRaw) || openRaw < 0) return null;
  if (!Number.isFinite(totalRaw) || totalRaw < 0) return null;

  const errRaw = Number(
    /** @type {{ issueCheckErrorCount?: unknown }} */ (block).issueCheckErrorCount,
  );
  const issueCheckErrorCount =
    Number.isFinite(errRaw) && errRaw >= 0 ? Math.floor(errRaw) : 0;

  const lastRefreshRaw = /** @type {{ lastRefreshAt?: unknown }} */ (block).lastRefreshAt;
  const lastRefreshAt =
    typeof lastRefreshRaw === 'string' && lastRefreshRaw.length > 0
      ? lastRefreshRaw
      : null;

  return {
    openCount: Math.floor(openRaw),
    totalCount: Math.floor(totalRaw),
    lastRefreshAt,
    issueCheckErrorCount,
  };
}

// Scheduled maintenance-prune projection (issue #2345). /api/health always
// publishes `maintenancePrune` when the tracker is wired (enabled, intervalHours,
// lastRunAt, lastReclaimedBytes, lastRemovedCount, lastError). Always-on gauge
// whenever enabled + intervalHours are present so operators see whether prune is
// armed and whether the last sweep succeeded without grepping server.log.
// Null when absent or malformed. Visibility only — does not run a prune.
function summarizeMaintenancePrune(health) {
  const block = health?.maintenancePrune;
  if (!block || typeof block !== 'object') return null;

  if (typeof /** @type {{ enabled?: unknown }} */ (block).enabled !== 'boolean') return null;

  const intervalRaw = Number(/** @type {{ intervalHours?: unknown }} */ (block).intervalHours);
  if (!Number.isFinite(intervalRaw) || intervalRaw < 0) return null;

  const lastRunRaw = /** @type {{ lastRunAt?: unknown }} */ (block).lastRunAt;
  const lastRunAt =
    typeof lastRunRaw === 'string' && lastRunRaw.length > 0 ? lastRunRaw : null;

  const reclaimedRaw = /** @type {{ lastReclaimedBytes?: unknown }} */ (block).lastReclaimedBytes;
  let lastReclaimedBytes = null;
  if (reclaimedRaw !== null && reclaimedRaw !== undefined) {
    const n = Number(reclaimedRaw);
    if (!Number.isFinite(n) || n < 0) return null;
    lastReclaimedBytes = Math.floor(n);
  }

  const removedRaw = /** @type {{ lastRemovedCount?: unknown }} */ (block).lastRemovedCount;
  let lastRemovedCount = null;
  if (removedRaw !== null && removedRaw !== undefined) {
    const n = Number(removedRaw);
    if (!Number.isFinite(n) || n < 0) return null;
    lastRemovedCount = Math.floor(n);
  }

  const errRaw = /** @type {{ lastError?: unknown }} */ (block).lastError;
  const lastError =
    typeof errRaw === 'string' && errRaw.length > 0 ? errRaw : null;

  return {
    enabled: /** @type {{ enabled: boolean }} */ (block).enabled,
    intervalHours: intervalRaw,
    lastRunAt,
    lastReclaimedBytes,
    lastRemovedCount,
    lastError,
  };
}

// Lesson-authoring yield projection (issue #2305 / #1538). /api/health already
// publishes lessonYield (yieldRate, decided, completedInWindow, buckets) once
// the 24h cache is warm; cold cache omits the block. Always-on compact gauge
// whenever decided + completedInWindow are present so operators see yield from
// `kookr status` without curling health. Null when absent or non-numeric.
// Visibility only — does not change the completion gate.
function summarizeLessonYield(health) {
  const block = health?.lessonYield;
  if (!block || typeof block !== 'object') return null;

  const decidedRaw = Number(/** @type {{ decided?: unknown }} */ (block).decided);
  const completedRaw = Number(
    /** @type {{ completedInWindow?: unknown }} */ (block).completedInWindow,
  );
  if (!Number.isFinite(decidedRaw) || decidedRaw < 0) return null;
  if (!Number.isFinite(completedRaw) || completedRaw < 0) return null;
  const decided = Math.floor(decidedRaw);
  const completedInWindow = Math.floor(completedRaw);

  const yieldRaw = Number(/** @type {{ yieldRate?: unknown }} */ (block).yieldRate);
  let yieldRate = Number.isFinite(yieldRaw) && yieldRaw >= 0 ? yieldRaw : null;
  if (yieldRate === null) {
    // Health always publishes yieldRate; fall back to the documented definition
    // when a partial fixture omits it so --json still has a finite number.
    yieldRate = completedInWindow === 0 ? 0 : decided / completedInWindow;
  }

  const bucketsRaw =
    /** @type {{ buckets?: { wroteLesson?: unknown; explicitSkip?: unknown; searchOnly?: unknown; noKbActivity?: unknown } }} */ (
      block
    ).buckets;
  const b = bucketsRaw && typeof bucketsRaw === 'object' ? bucketsRaw : {};

  return {
    yieldRate,
    decided,
    completedInWindow,
    buckets: {
      wroteLesson: nonNegIntFloor(b.wroteLesson),
      explicitSkip: nonNegIntFloor(b.explicitSkip),
      searchOnly: nonNegIntFloor(b.searchOnly),
      noKbActivity: nonNegIntFloor(b.noKbActivity),
    },
  };
}

// Hung-suspect TTL reclaim residual projection (issue #2229). /api/health
// already publishes hungSuspectTtlReclaim (issue #1989 / #2045) with process-
// lifetime skip-reason breakdown (and #2228 open-PR confirmed/unknown split).
// Unattended hosts and Lucy/Discord digests only saw residual via curling
// health. Surface a quiet-by-default slim residual when reclaimedTotal===0 AND
// (skips, candidates, or hungSuspect capacity residual) are elevated. Does not
// weaken open-PR fail-safes — visibility only. Null when absent, reclaim is
// progressing, or gauges are all zero.
function nonNegIntFloor(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function summarizeHungSuspectTtlReclaim(health) {
  const block = health?.hungSuspectTtlReclaim;
  if (!block || typeof block !== 'object') return null;

  const reclaimedTotal = nonNegIntFloor(
    /** @type {{ reclaimedTotal?: unknown }} */ (block).reclaimedTotal,
  );
  // Reclaim is progressing — stay quiet. The residual class is only interesting
  // when the process has never freed a hungSuspect slot (reclaimedTotal=0).
  if (reclaimedTotal > 0) return null;

  const reclaimAttempted = nonNegIntFloor(
    /** @type {{ reclaimAttempted?: unknown }} */ (block).reclaimAttempted,
  );
  const skippedNoLiveness = nonNegIntFloor(
    /** @type {{ skippedNoLiveness?: unknown }} */ (block).skippedNoLiveness,
  );
  const skippedOpenPrFailsafe = nonNegIntFloor(
    /** @type {{ skippedOpenPrFailsafe?: unknown }} */ (block).skippedOpenPrFailsafe,
  );
  const skippedOpenPrConfirmed = nonNegIntFloor(
    /** @type {{ skippedOpenPrConfirmed?: unknown }} */ (block).skippedOpenPrConfirmed,
  );
  const skippedOpenPrUnknown = nonNegIntFloor(
    /** @type {{ skippedOpenPrUnknown?: unknown }} */ (block).skippedOpenPrUnknown,
  );
  const skippedUnderTtl = nonNegIntFloor(
    /** @type {{ skippedUnderTtl?: unknown }} */ (block).skippedUnderTtl,
  );
  const skippedExemptAnomaly = nonNegIntFloor(
    /** @type {{ skippedExemptAnomaly?: unknown }} */ (block).skippedExemptAnomaly,
  );
  const skippedProviderPaused = nonNegIntFloor(
    /** @type {{ skippedProviderPaused?: unknown }} */ (block).skippedProviderPaused,
  );
  const lastCandidatesConsidered = nonNegIntFloor(
    /** @type {{ lastCandidatesConsidered?: unknown }} */ (block).lastCandidatesConsidered,
  );

  let hungSuspect;
  const byClass = health?.capacity?.byClass;
  if (byClass && typeof byClass === 'object') {
    const hs = Number(/** @type {{ hungSuspect?: unknown }} */ (byClass).hungSuspect);
    if (Number.isFinite(hs) && hs >= 0) hungSuspect = Math.floor(hs);
  }

  /** @type {Record<string, number> | undefined} */
  let residualClasses;
  const lastOutcomes = /** @type {{ lastOutcomes?: unknown }} */ (block).lastOutcomes;
  if (Array.isArray(lastOutcomes) && lastOutcomes.length > 0) {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const entry of lastOutcomes) {
      if (!entry || typeof entry !== 'object') continue;
      const outcome = /** @type {{ outcome?: unknown }} */ (entry).outcome;
      if (typeof outcome !== 'string' || outcome.length === 0) continue;
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    if (Object.keys(counts).length > 0) residualClasses = counts;
  }

  const skipsElevated =
    skippedNoLiveness
    + skippedOpenPrFailsafe
    + skippedOpenPrConfirmed
    + skippedOpenPrUnknown
    + skippedUnderTtl
    + skippedExemptAnomaly
    + skippedProviderPaused
    > 0;
  const candidatesElevated = lastCandidatesConsidered > 0 || reclaimAttempted > 0;
  const residualElevated =
    (typeof hungSuspect === 'number' && hungSuspect > 0)
    || (residualClasses !== undefined && Object.keys(residualClasses).length > 0);
  if (!skipsElevated && !candidatesElevated && !residualElevated) return null;

  /** @type {{
   *   reclaimedTotal: number,
   *   reclaimAttempted: number,
   *   skippedNoLiveness: number,
   *   skippedOpenPrFailsafe: number,
   *   skippedOpenPrConfirmed: number,
   *   skippedOpenPrUnknown: number,
   *   skippedUnderTtl: number,
   *   skippedExemptAnomaly: number,
   *   skippedProviderPaused: number,
   *   lastCandidatesConsidered: number,
   *   hungSuspect?: number,
   *   residualClasses?: Record<string, number>,
   * }} */
  const summary = {
    reclaimedTotal,
    reclaimAttempted,
    skippedNoLiveness,
    skippedOpenPrFailsafe,
    skippedOpenPrConfirmed,
    skippedOpenPrUnknown,
    skippedUnderTtl,
    skippedExemptAnomaly,
    skippedProviderPaused,
    lastCandidatesConsidered,
  };
  if (typeof hungSuspect === 'number') summary.hungSuspect = hungSuspect;
  if (residualClasses) summary.residualClasses = residualClasses;
  return summary;
}

function renderReport({ port, health, agents, readiness, degraded }) {
  const lines = [];
  const startedAt = health.serverStartedAt ? Date.parse(health.serverStartedAt) : NaN;
  const uptime = Number.isFinite(startedAt) ? formatUptime(Date.now() - startedAt) : 'unknown';
  const buildLabel = health.build?.version && health.build.version !== 'dev'
    ? ` (${health.build.version})`
    : '';

  const { statusCounts, severityCounts, findings, totalCost } = summarize(agents);

  lines.push(`Kookr on port ${port}${buildLabel}`);
  lines.push(`Uptime:  ${uptime}`);
  if (readiness) {
    if (readiness.status === 'ready') {
      const checkCount = Object.keys(readiness.checks ?? {}).length;
      lines.push(`Readiness: ready (${checkCount} ${checkCount === 1 ? 'check' : 'checks'})`);
    } else if (readiness.status === 'not-ready') {
      const failures = Object.entries(readiness.checks ?? {})
        .filter(([, check]) => isRecord(check) && check.critical === true && check.ready === false)
        .map(([name, check]) => `${name}=${
          typeof check.status === 'string' ? check.status : 'not-ready'
        }`);
      const detail = [`HTTP ${readiness.httpStatus ?? 'unknown'}`, ...failures].join('; ');
      lines.push(`Readiness: NOT READY (${detail})`);
    } else {
      lines.push(`Readiness: unavailable (${readiness.error})`);
    }
  }

  if (degraded) {
    // Issue #2848: the full event snapshot was slow/unavailable — agent and
    // finding detail are omitted. Health-derived capacity/pause/queue lines below
    // still render, and task outcome counts come from the compact task list.
    lines.push('⚠ Degraded: full event snapshot unavailable — agent/finding detail omitted.');
    lines.push(`  snapshot: ${degraded.snapshotReason}`);
    const ts = degraded.taskSummary;
    if (ts) {
      lines.push(`Tasks:   ${ts.count}`);
      const statusLine = Object.entries(ts.statusCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('  ');
      if (statusLine) lines.push(`Status:  ${statusLine}`);
      lines.push(`Cost:    ${formatCost(ts.totalCost)}`);
    } else {
      lines.push(`  tasks: ${degraded.tasksReason} (task outcome counts unavailable)`);
    }
  } else {
    lines.push(`Agents:  ${agents.length}`);

    if (agents.length > 0) {
      const statusLine = Object.entries(statusCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('  ');
      lines.push(`Status:  ${statusLine}`);
    }

    lines.push(`Cost:    ${formatCost(totalCost)}`);
  }

  // Automation kill-switch / SAFE MODE (issue #1710) — daily-digest line so
  // operators see the incident-response state without opening the dashboard.
  const safeMode = health.safeMode;
  if (safeMode && safeMode.engaged) {
    lines.push(
      typeof safeMode.digest === 'string' && safeMode.digest.length > 0
        ? safeMode.digest
        : (safeMode.since ? `SAFE MODE since ${safeMode.since}` : 'SAFE MODE'),
    );
  }

  // Per-project automation pause — distinct from SAFE MODE so
  // safeMode.engaged=false is not readable as "automation is running."
  const projectAutomation = health.projectAutomation;
  if (projectAutomation) {
    const digest = typeof projectAutomation.digest === 'string' && projectAutomation.digest.length > 0
      ? projectAutomation.digest
      : null;
    if (digest) lines.push(digest);
  }

  // CI-blind-merge debt (issue #1703) — surfaced on /api/health as
  // ciBlindDebt / ci_blind_debt so daily reports and operators see unverified
  // merge inventory instead of treating "PRs merged" as fully verified.
  const debt = health.ciBlindDebt ?? health.ci_blind_debt;
  if (debt && typeof debt.queueDepth === 'number') {
    const oldest =
      typeof debt.oldestAgeMs === 'number'
        ? `  oldest=${formatUptime(debt.oldestAgeMs)}`
        : '';
    lines.push(
      `CI-blind debt: blind=${debt.blindMergeCount ?? debt.queueDepth}` +
        `  queue=${debt.queueDepth}` +
        `  verifyFailed=${debt.verifyFailedCount ?? 0}` +
        oldest,
    );
  }

  // Pipeline starvation (issue #2183) — the issue belt is empty and starvation
  // scouts are cycling. One line per elevated repo so daily digests and quick
  // operator checks catch the on-demand idea-scout refill condition; the cooldown
  // segment is shown only when non-zero.
  const starvation = summarizePipelineStarvation(health);
  if (starvation) {
    for (const r of starvation.repos) {
      const cooldown = r.effectiveScoutCooldownMs > 0
        ? `  cooldown=${formatUptime(r.effectiveScoutCooldownMs)}`
        : '';
      lines.push(
        `Pipeline starvation: ${r.repo} blockedEmpty=${r.consecutiveBlockedEmpty}${cooldown}`,
      );
    }
  }

  // Stale processes (issue #2209) — host-wide dtach / relay-server leaks already
  // on /api/health. One quiet-by-default line so operators with dozens of
  // leaked masters do not need to curl health to notice.
  const stale = summarizeStaleProcesses(health);
  if (stale) {
    const parts = [];
    if (stale.dtach) {
      parts.push(`dtach=${stale.dtach.count} rss=${formatRss(stale.dtach.rssBytes)}`);
    }
    if (stale.relayServer) {
      parts.push(
        `relayServer=${stale.relayServer.count} rss=${formatRss(stale.relayServer.rssBytes)}`,
      );
    }
    lines.push(`Stale processes: ${parts.join('  ')}`);
  }

  // Host-stale dtach reaper (issue #2386) — under-pressure / reaped totals
  // already on /api/health. Quiet-by-default so remote operators see active
  // reclaim without curling health when the soft bound is crossed or kills ran.
  const hostStaleReaper = summarizeHostStaleDtachReaper(health);
  if (hostStaleReaper) {
    const dtach =
      hostStaleReaper.lastDtachCount === null
        ? 'unknown'
        : String(hostStaleReaper.lastDtachCount);
    lines.push(
      `Host-stale dtach reaper: underPressure=${hostStaleReaper.lastUnderPressure}` +
        `  dtach=${dtach}` +
        `  lastReaped=${hostStaleReaper.lastHostStaleDtachReaped}` +
        `  totalReaped=${hostStaleReaper.totalHostStaleDtachReaped}`,
    );
  }

  // Payload diet (issue #2220) — always-on compact gauge when /api/health
  // publishes the block. Matches the boot log line shape so digests and
  // `kookr status` share one mental model for in-memory task-record pressure.
  const diet = summarizePayloadDiet(health);
  if (diet) {
    const snapshot = diet.lastSnapshotBytes === null
      ? 'none'
      : formatRss(diet.lastSnapshotBytes);
    lines.push(
      `Payload diet: tracked=${diet.trackedTasks}  terminal=${diet.terminalTasks}  snapshot=${snapshot}`,
    );
  }

  // Hook replay checkpoints (issue #2281) — elevated-only so a fresh node with
  // an empty/missing checkpoint file stays quiet; operators notice growth
  // without grepping disk. Zero gauges still flow through --json via details.
  const checkpoints = summarizeHookReplayCheckpoints(health);
  if (checkpoints && (checkpoints.sessionCount > 0 || checkpoints.fileBytes > 0)) {
    lines.push(
      `Hook replay checkpoints: sessions=${checkpoints.sessionCount}  file=${formatRss(checkpoints.fileBytes)}`,
    );
  }

  // First-hook miss (issue #2235) — process-lifetime launch-ack failures already
  // on /api/health. Quiet-by-default so operators only see the line when the
  // reaper has reclaimed sessions that never emitted SessionStart.
  const firstHookMiss = summarizeFirstHookMiss(health);
  if (firstHookMiss) {
    lines.push(`First-hook miss: total=${firstHookMiss.firstHookMissTotal}`);
  }

  // Lesson yield (issue #2305 / #1538) — always-on compact gauge when
  // /api/health publishes the warm 24h cache block. Completion-gated lessons
  // are a live control-plane concern; operators should see yield without
  // curling health or /api/diagnostics/lesson-yield.
  const lessonYield = summarizeLessonYield(health);
  if (lessonYield) {
    const b = lessonYield.buckets;
    lines.push(
      `Lesson yield: rate=${formatUtilPct(lessonYield.yieldRate)}` +
        `  decided=${lessonYield.decided}/${lessonYield.completedInWindow}` +
        `  wrote=${b.wroteLesson}` +
        `  skip=${b.explicitSkip}` +
        `  searchOnly=${b.searchOnly}` +
        `  noKb=${b.noKbActivity}`,
    );
  }

  // OSS attempts (issue #2332) — always-on compact gauge when /api/health
  // publishes the slim ossAttempts block. Operators debugging contribution
  // rate-limits or a stale refresh see pressure without opening the dashboard.
  const ossAttempts = summarizeOssAttempts(health);
  if (ossAttempts) {
    const refresh =
      ossAttempts.lastRefreshAt === null ? 'never' : ossAttempts.lastRefreshAt;
    lines.push(
      `OSS attempts: open=${ossAttempts.openCount}` +
        `  total=${ossAttempts.totalCount}` +
        `  lastRefresh=${refresh}` +
        `  issueCheckErrors=${ossAttempts.issueCheckErrorCount}`,
    );
  }

  // Maintenance prune (issue #2345) — always-on when /api/health publishes the
  // schedule block (including enabled=false). Offline operators see whether
  // prune is armed and what the last sweep reclaimed without grepping logs.
  const maintenancePrune = summarizeMaintenancePrune(health);
  if (maintenancePrune) {
    const lastRun =
      maintenancePrune.lastRunAt === null ? 'never' : maintenancePrune.lastRunAt;
    const reclaimed =
      maintenancePrune.lastReclaimedBytes === null
        ? 'n/a'
        : String(maintenancePrune.lastReclaimedBytes);
    const removed =
      maintenancePrune.lastRemovedCount === null
        ? 'n/a'
        : String(maintenancePrune.lastRemovedCount);
    const err =
      maintenancePrune.lastError === null ? 'none' : maintenancePrune.lastError;
    lines.push(
      `Maintenance prune: enabled=${maintenancePrune.enabled}` +
        `  intervalHours=${maintenancePrune.intervalHours}` +
        `  lastRun=${lastRun}` +
        `  reclaimed=${reclaimed}` +
        `  removed=${removed}` +
        `  lastError=${err}`,
    );
  }

  // Startup recovery (issue #2351) — compact post-restart crash-recovery
  // counts when /api/health publishes the block. Always-on so unattended
  // restarts leave a glanceable relaunch / crash-loop skip trail.
  const startupRecovery = summarizeStartupRecovery(health);
  if (startupRecovery) {
    lines.push(
      `Startup recovery: relaunched=${startupRecovery.relaunched}` +
        `  skipped=${startupRecovery.skipped}` +
        `  failed=${startupRecovery.failed}` +
        `  crashLoop=${startupRecovery.crashLoopSkips}`,
    );
  }

  // Capacity (issue #2234) — phantom / high-util pressure from the ledger
  // already on /api/health. Quiet by default; one line with byClass + free
  // slots when phantoms, a large util gap, or high nominal utilization
  // would otherwise hide real free capacity from remote digests.
  const capacity = summarizeCapacity(health);
  if (capacity) {
    const freeGeneral =
      typeof capacity.freeForGeneralSources === 'number'
        ? ` freeGeneral=${capacity.freeForGeneralSources}`
        : '';
    const byClassParts = CAPACITY_BY_CLASS_KEYS
      .map((key) => `${key}=${capacity.byClass[key]}`)
      .join(' ');
    lines.push(
      `Capacity: active=${capacity.active}/${capacity.maxActiveTasks} free=${capacity.free}${freeGeneral}`
        + `  util=${formatUtilPct(capacity.utilizationPct)}%`
        + ` effective=${formatUtilPct(capacity.effectiveUtilizationPct)}%`
        + `  effectiveWorking=${capacity.effectiveWorking}`
        + ` phantom=${capacity.phantomActive}`
        + `  ${byClassParts}`,
    );
  }

  // Provider-paused occupancy (issue #2236) — quiet-by-default warning when
  // /api/health reports count > 0. Shows count, oldest pause age, and hard-TTL
  // reclaim counters so quota stalls are visible without health spelunking.
  const providerPaused = summarizeProviderPausedOccupancy(health);
  if (providerPaused) {
    const oldest =
      providerPaused.oldestPauseAgeMs === null
        ? 'unknown'
        : formatUptime(providerPaused.oldestPauseAgeMs);
    const softPart =
      providerPaused.capacityEarlyReclaim && providerPaused.effectiveTtlMs
        ? `  earlyReclaim=on effectiveTtl=${formatUptime(providerPaused.effectiveTtlMs)}`
        : providerPaused.capacityEarlyReclaim
          ? '  earlyReclaim=on'
          : '';
    lines.push(
      `Provider-paused occupancy: count=${providerPaused.count}` +
        `  oldest=${oldest}` +
        `  reclaimAttempted=${providerPaused.reclaimAttempted}` +
        `  reclaimedTotal=${providerPaused.reclaimedTotal}` +
        softPart,
    );
  }

  // Non-critical timer pause (issue #2230) — quiet-by-default warning when
  // /api/health reports current pause, elevated event-loop p95, or residual
  // pausedTicksTotal from a latency incident.
  const timerPause = summarizeNonCriticalTimerPause(health);
  if (timerPause) {
    const p95 =
      timerPause.lastEventLoopDelayP95Ms === null
        ? 'unknown'
        : `${timerPause.lastEventLoopDelayP95Ms}ms`;
    lines.push(
      `Non-critical timer pause: paused=${timerPause.paused}` +
        `  p95=${p95}` +
        `  threshold=${timerPause.thresholdMs}ms` +
        `  pausedTicks=${timerPause.pausedTicksTotal}`,
    );
  }

  // Snapshot rebuild shed (issue #2299) — elevated-only human line when
  // shedTotal > 0 so #2167-class event-loop starvation drops are visible on
  // the default operator path. Zero gauges still flow through --json.
  const snapshotShed = summarizeSnapshotShed(health);
  if (snapshotShed && snapshotShed.shedTotal > 0) {
    const p95 =
      snapshotShed.lastEventLoopDelayP95Ms === null
        ? 'unknown'
        : `${snapshotShed.lastEventLoopDelayP95Ms}ms`;
    lines.push(
      `Snapshot shed: shedTotal=${snapshotShed.shedTotal}` +
        `  p95=${p95}` +
        `  threshold=${snapshotShed.thresholdMs}ms`,
    );
  }

  // Hook-ingestion lag (issue #2319) — elevated-only human line when
  // notableLagCount > 0 so silent data-plane stalls show on the default
  // operator path. Zero gauges still flow through --json.
  const hookIngestion = summarizeHookIngestion(health);
  if (hookIngestion && hookIngestion.notableLagCount > 0) {
    const max =
      hookIngestion.maxLagMs === null ? 'unknown' : `${hookIngestion.maxLagMs}ms`;
    const p95 =
      hookIngestion.p95LagMs === null ? 'unknown' : `${hookIngestion.p95LagMs}ms`;
    lines.push(
      `Hook ingestion lag: notable=${hookIngestion.notableLagCount}` +
        `  sessions=${hookIngestion.sessionCount}` +
        `  max=${max}` +
        `  p95=${p95}` +
        `  threshold=${hookIngestion.lagWarningThresholdMs}ms`,
    );
  }

  // Launch dependencies (issue #2363) — elevated-only human line when
  // totalDegradedTasks > 0 so advisory preflight / post-restart residual
  // (e.g. kb provider_api) shows without curling /api/health. Zero totals
  // still flow through --json when the health block is present.
  const launchDeps = summarizeLaunchDependencies(health);
  if (launchDeps && launchDeps.totalDegradedTasks > 0) {
    const depParts = launchDeps.dependencies.map((d) => {
      const cats =
        d.categories.length > 0 ? ` (${d.categories.join(', ')})` : '';
      return `${d.dependency}=${d.degradedTaskCount}${cats}`;
    });
    lines.push(
      `Launch dependencies: degraded=${launchDeps.totalDegradedTasks}` +
        (depParts.length > 0 ? `  ${depParts.join('  ')}` : ''),
    );
  }

  // Schedules paused after consecutive failures (issue #2424) — elevated-only
  // WARN with count + a short name sample so unattended Discord digests see
  // fail-closed pauses without curling /api/health. Full roster is --json.
  const pausedSchedules = summarizeSchedulesPausedByFailure(health);
  if (pausedSchedules) {
    const sample = pausedSchedules
      .slice(0, SCHEDULES_PAUSED_SAMPLE_LIMIT)
      .map((row) => row.name);
    const overflow = pausedSchedules.length - sample.length;
    const more = overflow > 0 ? ` (+${overflow} more)` : '';
    const noun = pausedSchedules.length === 1 ? 'schedule' : 'schedules';
    lines.push(
      `WARN: ${pausedSchedules.length} ${noun} paused after consecutive failures: ${sample.join(', ')}${more}`,
    );
  }

  // Hung-suspect TTL reclaim residual (issue #2229) — quiet-by-default when
  // reclaimedTotal=0 and skips/candidates/residual are elevated. Prints the
  // skip breakdown + residual class counts so unattended operators do not
  // need to curl /api/health. Does not weaken open-PR fail-safes.
  const hungReclaim = summarizeHungSuspectTtlReclaim(health);
  if (hungReclaim) {
    const hungSuspectPart =
      typeof hungReclaim.hungSuspect === 'number'
        ? ` hungSuspect=${hungReclaim.hungSuspect}`
        : '';
    const residualPart = hungReclaim.residualClasses
      ? `  residual=${Object.keys(hungReclaim.residualClasses)
        .sort()
        .map((k) => `${k}=${hungReclaim.residualClasses[k]}`)
        .join(',')}`
      : '';
    lines.push(
      `Hung-suspect reclaim: reclaimedTotal=${hungReclaim.reclaimedTotal}` +
        hungSuspectPart +
        `  reclaimAttempted=${hungReclaim.reclaimAttempted}` +
        `  candidates=${hungReclaim.lastCandidatesConsidered}` +
        `  skips openPr=${hungReclaim.skippedOpenPrFailsafe}` +
        ` openPrConfirmed=${hungReclaim.skippedOpenPrConfirmed}` +
        ` openPrUnknown=${hungReclaim.skippedOpenPrUnknown}` +
        ` underTtl=${hungReclaim.skippedUnderTtl}` +
        ` providerPaused=${hungReclaim.skippedProviderPaused}` +
        ` noLiveness=${hungReclaim.skippedNoLiveness}` +
        ` exemptAnomaly=${hungReclaim.skippedExemptAnomaly}` +
        residualPart,
    );
  }

  if (findings.length > 0) {
    const sevLine = SEVERITIES
      .filter((s) => severityCounts[s] > 0)
      .map((s) => `${severityCounts[s]} ${s}`)
      .join(', ');
    lines.push('');
    lines.push(`Findings (${findings.length}${sevLine ? `: ${sevLine}` : ''}):`);
    for (const f of findings) {
      const sev = String(f.severity).toUpperCase().padEnd(8);
      lines.push(`  [${sev}] ${f.taskName} — ${f.type}: ${f.explanation}`);
    }
  } else if (degraded) {
    lines.push('');
    lines.push('Findings: unavailable (event snapshot degraded).');
  } else {
    lines.push('');
    lines.push('No active findings.');
  }
  return lines.join('\n');
}

function parseStatusArgs(argv) {
  const args = { help: false, json: false, failOn: 'none', requireReady: false };
  let error = null;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      args.help = true;
    } else if (tok === '--json') {
      args.json = true;
    } else if (tok === '--require-ready') {
      args.requireReady = true;
    } else if (tok === '--fail-on') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        if (error === null) error = '--fail-on requires one of: critical, warning, info, none';
      } else {
        i += 1;
        if (FAIL_ON_VALUES.includes(value)) {
          args.failOn = value;
        } else if (error === null) {
          error = `Invalid --fail-on value: ${value}. Expected one of: critical, warning, info, none`;
        }
      }
    } else if (tok.startsWith('--fail-on=')) {
      const value = tok.slice('--fail-on='.length);
      if (FAIL_ON_VALUES.includes(value)) {
        args.failOn = value;
      } else if (error === null) {
        error = `Invalid --fail-on value: ${value}. Expected one of: critical, warning, info, none`;
      }
    } else if (error === null) {
      error = `Unexpected argument: ${tok}`;
    }
  }
  if (error) return { ...args, error };
  return args;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function truncateUtf8(text, maxBytes) {
  const raw = String(text);
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= maxBytes) return raw;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

function boundValueStrings(value, maxStringBytes) {
  if (typeof value === 'string') return truncateUtf8(value, maxStringBytes);
  if (Array.isArray(value)) return value.map((item) => boundValueStrings(item, maxStringBytes));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = boundValueStrings(nested, maxStringBytes);
    }
    return out;
  }
  return value;
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

function shrinkArrayToFit(items, apply, maxBytes) {
  if (jsonBytes(apply(items)) <= maxBytes) return items;
  let lo = 0;
  let hi = items.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (jsonBytes(apply(items.slice(0, mid))) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return items.slice(0, best);
}

function resolveStatusJsonMaxBytes(env = process.env) {
  const raw = env.KOOKR_STATUS_JSON_MAX_BYTES;
  if (raw === undefined || raw === '') return STATUS_JSON_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return STATUS_JSON_MAX_BYTES;
  return n;
}

/**
 * Bound a status JSON envelope so stringify() yields one complete document
 * under `maxBytes`. Capacity, queue depth, outcome counts, and envelope
 * metadata stay intact; large task/event collections are shortened with
 * explicit original/returned counts instead of slicing the byte stream.
 *
 * @param {{ ok: unknown, code: unknown, message: unknown, details?: unknown }} envelope
 * @param {{ maxBytes?: number, maxStringBytes?: number }} [options]
 */
function boundStatusJson(envelope, options = {}) {
  const maxBytes = options.maxBytes ?? STATUS_JSON_MAX_BYTES;
  const maxStringBytes = options.maxStringBytes ?? STATUS_JSON_MAX_STRING_BYTES;
  const message = typeof envelope.message === 'string'
    ? truncateUtf8(envelope.message, Math.max(maxStringBytes, 256))
    : envelope.message;
  const detailsRaw = envelope.details == null ? {} : cloneJson(envelope.details);
  const next = {
    ok: envelope.ok,
    code: envelope.code,
    message,
    details: boundValueStrings(detailsRaw, maxStringBytes),
  };
  if (jsonBytes(next) <= maxBytes) return next;
  const details = next.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return next;

  /** @type {Record<string, { truncated: true, originalCount: number, returnedCount: number }>} */
  const truncation = {};
  /** @type {Map<string, unknown[]>} */
  const originals = new Map();
  const bindCollection = (spec, originalCount) => (sliced) => {
    setPath(details, spec.path, sliced);
    if (sliced.length < originalCount) {
      truncation[spec.name] = {
        truncated: true,
        originalCount,
        returnedCount: sliced.length,
      };
      details.truncation = truncation;
    } else {
      delete truncation[spec.name];
      if (Object.keys(truncation).length === 0) delete details.truncation;
      else details.truncation = truncation;
    }
    return next;
  };

  const present = [];
  for (const spec of STATUS_JSON_COLLECTIONS) {
    const items = getPath(details, spec.path);
    if (!Array.isArray(items) || items.length === 0) continue;
    originals.set(spec.name, items);
    present.push({ spec, items, size: jsonBytes(items) });
  }
  present.sort((a, b) => b.size - a.size);

  // Shrink the currently largest collection first so a findings overflow
  // cannot wipe a small agents list (or vice versa).
  for (const { spec, items } of present) {
    if (jsonBytes(next) <= maxBytes) break;
    const apply = bindCollection(spec, items.length);
    truncation[spec.name] = { truncated: true, originalCount: items.length, returnedCount: 0 };
    details.truncation = truncation;
    apply(shrinkArrayToFit(items, apply, maxBytes));
  }

  // Give leftover budget back in declared preference order (agents, then findings).
  for (const spec of STATUS_JSON_COLLECTIONS) {
    const original = originals.get(spec.name);
    if (!original) continue;
    const apply = bindCollection(spec, original.length);
    apply(shrinkArrayToFit(original, apply, maxBytes));
  }
  return next;
}

function emitJson(out, { ok, code, message, details = {} }, options = {}) {
  out.log(JSON.stringify(boundStatusJson({ ok, code, message, details }, options)));
}

function exitJson({ out, exit, exitCode, ok, code, message, details, jsonOptions }) {
  emitJson(out, { ok, code, message, details }, jsonOptions);
  return exit(exitCode);
}

// Health-derived slim projections shared by the happy and degraded --json paths
// (issue #2848). Every input comes from /api/health, so these blocks (capacity,
// pause state, queue/utilization gauges, …) remain present even when the full
// /api/snapshot event history is unavailable. Returns a spreadable object that
// carries only the blocks /api/health actually published — key ordering matches
// the historical happy-path envelope.
function buildHealthDetailProjections(health) {
  const starvationSummary = summarizePipelineStarvation(health);
  const staleSummary = summarizeStaleProcesses(health);
  const hostStaleDtachReaperSummary = summarizeHostStaleDtachReaper(health);
  const payloadDietSummary = summarizePayloadDiet(health);
  const hookReplayCheckpointsSummary = summarizeHookReplayCheckpoints(health);
  const firstHookMissSummary = summarizeFirstHookMiss(health);
  const capacitySummary = summarizeCapacity(health);
  const providerPausedSummary = summarizeProviderPausedOccupancy(health);
  const nonCriticalTimerPauseSummary = summarizeNonCriticalTimerPause(health);
  const snapshotShedSummary = summarizeSnapshotShed(health);
  const hookIngestionSummary = summarizeHookIngestion(health);
  const launchDependenciesSummary = summarizeLaunchDependencies(health);
  const schedulesPausedByFailureSummary = summarizeSchedulesPausedByFailure(health);
  const hungReclaimSummary = summarizeHungSuspectTtlReclaim(health);
  const lessonYieldSummary = summarizeLessonYield(health);
  const ossAttemptsSummary = summarizeOssAttempts(health);
  const maintenancePruneSummary = summarizeMaintenancePrune(health);
  const startupRecoverySummary = summarizeStartupRecovery(health);
  return {
    ...(starvationSummary ? { pipelineStarvation: starvationSummary } : {}),
    ...(staleSummary ? { staleProcesses: staleSummary } : {}),
    ...(hostStaleDtachReaperSummary
      ? { hostStaleDtachReaper: hostStaleDtachReaperSummary }
      : {}),
    ...(payloadDietSummary ? { payloadDiet: payloadDietSummary } : {}),
    ...(hookReplayCheckpointsSummary
      ? { hookReplayCheckpoints: hookReplayCheckpointsSummary }
      : {}),
    ...(firstHookMissSummary
      ? { firstHookMissTotal: firstHookMissSummary.firstHookMissTotal }
      : {}),
    ...(lessonYieldSummary ? { lessonYield: lessonYieldSummary } : {}),
    ...(ossAttemptsSummary ? { ossAttempts: ossAttemptsSummary } : {}),
    ...(maintenancePruneSummary
      ? { maintenancePrune: maintenancePruneSummary }
      : {}),
    ...(startupRecoverySummary
      ? { startupRecovery: startupRecoverySummary }
      : {}),
    ...(hookIngestionSummary ? { hookIngestion: hookIngestionSummary } : {}),
    ...(launchDependenciesSummary
      ? { launchDependencies: launchDependenciesSummary }
      : {}),
    ...(schedulesPausedByFailureSummary
      ? { schedulesPausedByFailure: schedulesPausedByFailureSummary }
      : {}),
    ...(capacitySummary ? { capacity: capacitySummary } : {}),
    ...(providerPausedSummary
      ? { providerPausedOccupancy: providerPausedSummary }
      : {}),
    ...(nonCriticalTimerPauseSummary
      ? { nonCriticalTimerPause: nonCriticalTimerPauseSummary }
      : {}),
    ...(snapshotShedSummary ? { snapshotShed: snapshotShedSummary } : {}),
    ...(hungReclaimSummary
      ? { hungSuspectTtlReclaim: hungReclaimSummary }
      : {}),
  };
}

async function main({ argv = process.argv.slice(2), env = process.env, out = console, exit = process.exit } = {}) {
  const jsonOptions = { maxBytes: resolveStatusJsonMaxBytes(env) };
  const args = parseStatusArgs(argv);
  if (args.error) {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 2,
        ok: false,
        code: 'USER_ERROR',
        message: args.error,
        details: { subcommand: 'status' },
        jsonOptions,
      });
    }
    out.error(args.error);
    out.error('Try `kookr status --help`.');
    return exit(2);
  }
  if (args.help) {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 0,
        ok: true,
        code: 'OK',
        message: 'Help',
        details: { help: HELP_TEXT },
        jsonOptions,
      });
    }
    out.log(HELP_TEXT);
    return exit(0);
  }

  const resolved = await resolvePort(env);
  if (resolved.kind === 'invalid') {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 1,
        ok: false,
        code: 'USER_ERROR',
        message: `KOOKR_PORT must be an integer between 1 and 65535 (got: ${JSON.stringify(resolved.raw)}).`,
        details: { raw: resolved.raw },
        jsonOptions,
      });
    }
    out.error(`KOOKR_PORT must be an integer between 1 and 65535 (got: ${JSON.stringify(resolved.raw)}).`);
    return exit(1);
  }
  if (resolved.kind === 'none') {
    // Issue #2410: distinguish a planned redeploy from an unexpected outage by
    // reading the local restart-intent marker written by prod-restart.sh.
    const found = firstRestartIntentAcrossPorts(PORTS_TO_TRY, { env });
    const intent = found?.intent ?? null;
    const cause = describeUnreachableCause(intent);
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 1,
        ok: false,
        code: 'NO_SERVER',
        message: `Kookr is not running on ports ${PORTS_TO_TRY.join(', ')}. ${cause}`,
        details: {
          ports: PORTS_TO_TRY,
          restartIntent: restartIntentJson(intent),
        },
        jsonOptions,
      });
    }
    out.error(
      `Kookr is not running on ports ${PORTS_TO_TRY.join(', ')}.\n` +
      `${cause}\n` +
      `Set KOOKR_PORT if using a non-default port.`,
    );
    return exit(1);
  }

  const { port } = resolved;
  const base = `http://127.0.0.1:${port}`;

  // Issue #2848: health is the required liveness probe; the full event snapshot
  // is optional. Fetch both in parallel (bounded deadlines) but treat only a
  // health failure as fatal. A slow/unavailable/malformed /api/snapshot degrades
  // to a bounded fast path built from /api/health plus the compact task list, so
  // machine-readable status stays a cheap, reliable control-plane probe even when
  // event history grows and full snapshot assembly slows.
  // fetchReadiness normalizes every endpoint failure into an explicit
  // unavailable verdict, so only health/snapshot need settled-promise arms.
  const readinessPromise = fetchReadiness(`${base}/api/ready`, READINESS_TIMEOUT_MS);
  const [healthResult, snapshotResult] = await Promise.allSettled([
    fetchJson(`${base}/api/health`),
    fetchJson(`${base}/api/snapshot`, SNAPSHOT_TIMEOUT_MS),
  ]);
  const readiness = await readinessPromise;

  if (healthResult.status === 'rejected') {
    const msg = `/api/health: ${errMessage(healthResult.reason)}`;
    // Issue #2410: an explicit-port fetch failure is also an "API unreachable"
    // case — read the marker for this port to tell a planned redeploy apart
    // from an unexpected outage.
    const now = Date.now();
    const { intent, message: cause } = readUnreachableCause({ port, env, now });
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 1,
        ok: false,
        code: 'SERVER_ERROR',
        message: resolved.kind === 'explicit'
          ? `Failed to reach Kookr on port ${port} (${msg}). ${cause}`
          : `Failed to reach Kookr on port ${port}: ${msg}. ${cause}`,
        details: {
          port,
          resolvedKind: resolved.kind,
          error: msg,
          restartIntent: restartIntentJson(intent, now),
        },
        jsonOptions,
      });
    }
    if (resolved.kind === 'explicit') {
      out.error(
        `Failed to reach Kookr on port ${port} (${msg}).\n` +
        `${cause}\n` +
        `Is Kookr running? KOOKR_PORT=${port}.`,
      );
    } else {
      out.error(`Failed to reach Kookr on port ${port}: ${msg}.\n${cause}`);
    }
    return exit(1);
  }

  const health = healthResult.value;
  const agents = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  const readinessFailed = args.requireReady && readiness.status !== 'ready';
  const readinessGateDetails = args.requireReady ? { readinessRequired: true } : {};

  if (Array.isArray(agents)) {
    // Happy path — the full snapshot is present, so the historical agents,
    // summary, findings, and --fail-on fields stay intact alongside the additive
    // readiness block.
    const summary = summarize(agents);
    const findingsExceeded = hasFindingsAtOrAbove(summary, args.failOn);
    const exitCode = readinessFailed
      ? READINESS_EXIT_CODE
      : findingsExceeded
        ? FINDINGS_EXIT_CODE
        : 0;
    const gateDetails = args.failOn === 'none'
      ? {}
      : { failOn: args.failOn, highestSeverity: highestKnownSeverity(summary) };

    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode,
        ok: exitCode === 0,
        code: readinessFailed ? 'READINESS_FAILED' : findingsExceeded ? 'FINDINGS_PRESENT' : 'OK',
        message: readinessFailed
          ? `Kookr readiness gate failed: ${readiness.status}.`
          : findingsExceeded
            ? `Active findings meet or exceed ${args.failOn} severity.`
            : 'Kookr status snapshot',
        details: {
          port,
          health,
          readiness,
          agents,
          summary,
          ...buildHealthDetailProjections(health),
          ...gateDetails,
          ...readinessGateDetails,
        },
        jsonOptions,
      });
    }
    out.log(renderReport({ port, health, agents, readiness }));
    if (readinessFailed) return exit(READINESS_EXIT_CODE);
    if (findingsExceeded) return exit(FINDINGS_EXIT_CODE);
    return;
  }

  // Degraded path (issue #2848) — the full event snapshot is slow, unreachable,
  // or malformed. Rebuild the stable machine summary from /api/health (capacity,
  // utilization, queue depth, pause state, freshness) plus the bounded compact
  // task list (task outcome counts). Findings/anomalies live only in the snapshot
  // and are marked omitted rather than silently dropped. The document is complete
  // and `ok` — the control plane is alive — so scheduled reflection and incident
  // tooling still get a parseable probe.
  const snapshotReason = snapshotResult.status === 'rejected'
    ? errMessage(snapshotResult.reason)
    : 'unexpected /api/snapshot response (expected an array)';

  let tasks = null;
  let tasksReason = null;
  try {
    const body = await fetchJson(`${base}/api/tasks?view=compact`, TASKS_TIMEOUT_MS);
    if (Array.isArray(body)) tasks = body;
    else tasksReason = 'unexpected /api/tasks response (expected an array)';
  } catch (err) {
    tasksReason = errMessage(err);
  }

  const taskSummary = tasks ? summarizeTasks(tasks) : null;

  const startedAtMs = health && health.serverStartedAt
    ? Date.parse(health.serverStartedAt)
    : NaN;
  const serverFreshness = {
    serverStartedAt: (health && health.serverStartedAt) ?? null,
    uptimeMs: Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : null,
    // Cache age the served /api/health body stamps on itself (issue #2429/#2492)
    // — how stale the health snapshot is relative to its last assembly.
    healthCacheAgeMs: health && typeof health.healthCacheAgeMs === 'number'
      ? health.healthCacheAgeMs
      : null,
  };

  const degradedSections = [
    {
      source: '/api/snapshot',
      status: 'unavailable',
      reason: snapshotReason,
      omitted: ['agents', 'findings'],
    },
    taskSummary
      ? {
        source: '/api/tasks?view=compact',
        status: 'ok',
        returnedCount: taskSummary.count,
        originalCount: taskSummary.count,
        bounded: false,
      }
      : {
        source: '/api/tasks?view=compact',
        status: 'unavailable',
        reason: tasksReason,
        omitted: ['taskOutcomeCounts'],
      },
  ];

  const degradedSummary = {
    statusCounts: taskSummary ? taskSummary.statusCounts : null,
    // Severity/findings live in live monitor state carried only by /api/snapshot,
    // which is unavailable here — reported as zeros with findingsAvailable:false
    // so a consumer never mistakes "unknown" for "none".
    severityCounts: { critical: 0, warning: 0, info: 0 },
    findings: [],
    totalCost: taskSummary ? taskSummary.totalCost : null,
    source: taskSummary ? 'tasks' : 'unavailable',
    findingsAvailable: false,
    taskCountsAvailable: Boolean(taskSummary),
  };

  const degraded = {
    reason: 'full event snapshot unavailable',
    sections: degradedSections,
    serverFreshness,
  };

  if (args.json) {
    // Findings cannot be evaluated without the snapshot, so the --fail-on gate is
    // reported as not evaluated and does not fail the probe (safe default: a cheap
    // liveness probe must not exit non-zero merely because event history is slow).
    const gateDetails = args.failOn === 'none'
      ? {}
      : { failOn: args.failOn, highestSeverity: null, findingsEvaluated: false };
    return exitJson({
      out,
      exit,
      exitCode: readinessFailed ? READINESS_EXIT_CODE : 0,
      ok: !readinessFailed,
      code: readinessFailed ? 'READINESS_FAILED' : 'OK_DEGRADED',
      message: readinessFailed
        ? `Kookr readiness gate failed: ${readiness.status}.`
        : 'Kookr status snapshot (degraded: full event snapshot unavailable)',
      details: {
        port,
        health,
        readiness,
        summary: degradedSummary,
        ...buildHealthDetailProjections(health),
        degraded,
        ...gateDetails,
        ...readinessGateDetails,
      },
      jsonOptions,
    });
  }
  // renderReport takes the slim DegradedRenderContext shape ({ snapshotReason,
  // taskSummary, tasksReason }) — distinct from the richer `degraded` block above
  // that the --json envelope carries. See bin/kookr-status.d.ts.
  out.log(renderReport({
    port,
    health,
    agents: [],
    readiness,
    degraded: { snapshotReason, taskSummary, tasksReason },
  }));
  if (readinessFailed) return exit(READINESS_EXIT_CODE);
}

// Guard main() so vitest can import the module without triggering a fetch.
// npm/pnpm install the bin as a symlink, so resolve argv[1] through its realpath
// before comparing to import.meta.url (which is always realpath-resolved).
function isInvokedDirectly() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  if (!process.argv.includes('--json')) {
    console.error('[kookr] WARNING: `kookr-status` is deprecated; use `kookr status`.');
  }
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`kookr-status: ${msg}`);
    process.exit(1);
  });
}

export {
  HELP_TEXT,
  READINESS_EXIT_CODE,
  STATUS_JSON_MAX_BYTES,
  STATUS_JSON_MAX_STRING_BYTES,
  boundStatusJson,
  resolveStatusJsonMaxBytes,
  apiAuthHeaders,
  formatUptime,
  formatCost,
  formatRss,
  isActiveFinding,
  summarize,
  summarizeTasks,
  hasFindingsAtOrAbove,
  highestKnownSeverity,
  summarizePipelineStarvation,
  summarizeStaleProcesses,
  summarizeHostStaleDtachReaper,
  summarizePayloadDiet,
  summarizeHookReplayCheckpoints,
  summarizeFirstHookMiss,
  summarizeCapacity,
  formatUtilPct,
  summarizeProviderPausedOccupancy,
  summarizeNonCriticalTimerPause,
  summarizeSnapshotShed,
  summarizeHookIngestion,
  summarizeLaunchDependencies,
  summarizeSchedulesPausedByFailure,
  summarizeHungSuspectTtlReclaim,
  summarizeLessonYield,
  summarizeOssAttempts,
  summarizeMaintenancePrune,
  summarizeStartupRecovery,
  renderReport,
  resolvePort,
  parsePortEnv,
  parseStatusArgs,
  main,
};
