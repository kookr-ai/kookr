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

  // First-hook miss (issue #2235) — process-lifetime launch-ack failures already
  // on /api/health. Quiet-by-default so operators only see the line when the
  // reaper has reclaimed sessions that never emitted SessionStart.
  const firstHookMiss = summarizeFirstHookMiss(health);
  if (firstHookMiss) {
    lines.push(`First-hook miss: total=${firstHookMiss.firstHookMissTotal}`);
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
    const firstHookMissSummary = summarizeFirstHookMiss(health);
    const capacitySummary = summarizeCapacity(health);
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
        ...(firstHookMissSummary
          ? { firstHookMissTotal: firstHookMissSummary.firstHookMissTotal }
          : {}),
        ...(capacitySummary ? { capacity: capacitySummary } : {}),
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
  summarizeFirstHookMiss,
  summarizeCapacity,
  formatUtilPct,
  renderReport,
  resolvePort,
  parsePortEnv,
  parseStatusArgs,
  main,
};
