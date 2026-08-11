#!/usr/bin/env node
// Kookr CLI status command — prints a human-readable snapshot of the running
// Kookr instance. Read-only, no mutations, no external dependencies.
// Contract: reads `AgentState[]` from /api/snapshot and `{ serverStartedAt,
// build.version }` from /api/health (see src/server/routes/diagnostics-routes.ts).
// Auto-detects port (4800 → 4801) when KOOKR_PORT is unset.

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const PORTS_TO_TRY = [4800, 4801];
const SEVERITIES = /** @type {const} */ (['critical', 'warning', 'info']);
const FAIL_ON_VALUES = /** @type {const} */ ([...SEVERITIES, 'none']);
const FINDINGS_EXIT_CODE = 5;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'terminated']);
const HELP_TEXT = `kookr status — print a read-only snapshot of a running Kookr instance.

Usage:
  kookr status [--json] [--fail-on <critical|warning|info|none>]
  kookr-status [--json] [--fail-on <critical|warning|info|none>]        Deprecated compatibility alias.

Options:
  --json                    Print one machine-readable JSON envelope to stdout.
  --fail-on <severity>      Exit ${FINDINGS_EXIT_CODE} when active findings meet or exceed
                            critical, warning, info, or none.
  -h, --help                Show this help.

Environment:
  KOOKR_PORT          Specific port on 127.0.0.1.
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

function renderReport({ port, health, agents }) {
  const lines = [];
  const startedAt = health.serverStartedAt ? Date.parse(health.serverStartedAt) : NaN;
  const uptime = Number.isFinite(startedAt) ? formatUptime(Date.now() - startedAt) : 'unknown';
  const buildLabel = health.build?.version && health.build.version !== 'dev'
    ? ` (${health.build.version})`
    : '';

  const { statusCounts, severityCounts, findings, totalCost } = summarize(agents);

  lines.push(`Kookr on port ${port}${buildLabel}`);
  lines.push(`Uptime:  ${uptime}`);
  lines.push(`Agents:  ${agents.length}`);

  if (agents.length > 0) {
    const statusLine = Object.entries(statusCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('  ');
    lines.push(`Status:  ${statusLine}`);
  }

  lines.push(`Cost:    ${formatCost(totalCost)}`);

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
  } else {
    lines.push('');
    lines.push('No active findings.');
  }
  return lines.join('\n');
}

function parseStatusArgs(argv) {
  const args = { help: false, json: false, failOn: 'none' };
  let error = null;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      args.help = true;
    } else if (tok === '--json') {
      args.json = true;
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

function emitJson(out, { ok, code, message, details = {} }) {
  out.log(JSON.stringify({ ok, code, message, details }));
}

function exitJson({ out, exit, exitCode, ok, code, message, details }) {
  emitJson(out, { ok, code, message, details });
  return exit(exitCode);
}

async function main({ argv = process.argv.slice(2), env = process.env, out = console, exit = process.exit } = {}) {
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
      });
    }
    out.error(`KOOKR_PORT must be an integer between 1 and 65535 (got: ${JSON.stringify(resolved.raw)}).`);
    return exit(1);
  }
  if (resolved.kind === 'none') {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 1,
        ok: false,
        code: 'NO_SERVER',
        message: `Kookr is not running on ports ${PORTS_TO_TRY.join(', ')}.`,
        details: { ports: PORTS_TO_TRY },
      });
    }
    out.error(
      `Kookr is not running on ports ${PORTS_TO_TRY.join(', ')}.\n` +
      `Set KOOKR_PORT if using a non-default port.`,
    );
    return exit(1);
  }

  const { port } = resolved;
  const base = `http://127.0.0.1:${port}`;
  let health;
  let agents;
  try {
    [health, agents] = await Promise.all([
      fetchJson(`${base}/api/health`).catch((e) => { throw new Error(`/api/health: ${e.message}`); }),
      fetchJson(`${base}/api/snapshot`).catch((e) => { throw new Error(`/api/snapshot: ${e.message}`); }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 1,
        ok: false,
        code: 'SERVER_ERROR',
        message: resolved.kind === 'explicit'
          ? `Failed to reach Kookr on port ${port} (${msg}).`
          : `Failed to reach Kookr on port ${port}: ${msg}`,
        details: { port, resolvedKind: resolved.kind, error: msg },
      });
    }
    if (resolved.kind === 'explicit') {
      out.error(
        `Failed to reach Kookr on port ${port} (${msg}).\n` +
        `Is Kookr running? KOOKR_PORT=${port}.`,
      );
    } else {
      out.error(`Failed to reach Kookr on port ${port}: ${msg}`);
    }
    return exit(1);
  }

  if (!Array.isArray(agents)) {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: 1,
        ok: false,
        code: 'SERVER_ERROR',
        message: 'Unexpected /api/snapshot response (expected an array).',
        details: { port, health, snapshot: agents },
      });
    }
    out.error(`Unexpected /api/snapshot response (expected an array).`);
    return exit(1);
  }

  const summary = summarize(agents);
  const findingsExceeded = hasFindingsAtOrAbove(summary, args.failOn);
  const gateDetails = args.failOn === 'none'
    ? {}
    : { failOn: args.failOn, highestSeverity: highestKnownSeverity(summary) };

  if (args.json) {
    // Computed only on the --json path; the text path derives the same slim
    // summary inside renderReport, so computing it here too would be wasted work.
    const starvationSummary = summarizePipelineStarvation(health);
    const staleSummary = summarizeStaleProcesses(health);
    const payloadDietSummary = summarizePayloadDiet(health);
    const hookReplayCheckpointsSummary = summarizeHookReplayCheckpoints(health);
    const firstHookMissSummary = summarizeFirstHookMiss(health);
    const capacitySummary = summarizeCapacity(health);
    const providerPausedSummary = summarizeProviderPausedOccupancy(health);
    const nonCriticalTimerPauseSummary = summarizeNonCriticalTimerPause(health);
    const snapshotShedSummary = summarizeSnapshotShed(health);
    const hookIngestionSummary = summarizeHookIngestion(health);
    const hungReclaimSummary = summarizeHungSuspectTtlReclaim(health);
    const lessonYieldSummary = summarizeLessonYield(health);
    return exitJson({
      out,
      exit,
      exitCode: findingsExceeded ? FINDINGS_EXIT_CODE : 0,
      ok: !findingsExceeded,
      code: findingsExceeded ? 'FINDINGS_PRESENT' : 'OK',
      message: findingsExceeded
        ? `Active findings meet or exceed ${args.failOn} severity.`
        : 'Kookr status snapshot',
      details: {
        port,
        health,
        agents,
        summary,
        ...(starvationSummary ? { pipelineStarvation: starvationSummary } : {}),
        ...(staleSummary ? { staleProcesses: staleSummary } : {}),
        ...(payloadDietSummary ? { payloadDiet: payloadDietSummary } : {}),
        ...(hookReplayCheckpointsSummary
          ? { hookReplayCheckpoints: hookReplayCheckpointsSummary }
          : {}),
        ...(firstHookMissSummary
          ? { firstHookMissTotal: firstHookMissSummary.firstHookMissTotal }
          : {}),
        ...(lessonYieldSummary ? { lessonYield: lessonYieldSummary } : {}),
        ...(hookIngestionSummary ? { hookIngestion: hookIngestionSummary } : {}),
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
        ...gateDetails,
      },
    });
  }
  out.log(renderReport({ port, health, agents }));
  if (findingsExceeded) return exit(FINDINGS_EXIT_CODE);
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
  apiAuthHeaders,
  formatUptime,
  formatCost,
  formatRss,
  isActiveFinding,
  summarize,
  hasFindingsAtOrAbove,
  highestKnownSeverity,
  summarizePipelineStarvation,
  summarizeStaleProcesses,
  summarizePayloadDiet,
  summarizeHookReplayCheckpoints,
  summarizeFirstHookMiss,
  summarizeCapacity,
  formatUtilPct,
  summarizeProviderPausedOccupancy,
  summarizeNonCriticalTimerPause,
  summarizeSnapshotShed,
  summarizeHookIngestion,
  summarizeHungSuspectTtlReclaim,
  summarizeLessonYield,
  renderReport,
  resolvePort,
  parsePortEnv,
  parseStatusArgs,
  main,
};
