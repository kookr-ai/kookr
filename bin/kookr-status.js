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
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'terminated']);
const HELP_TEXT = `kookr status — print a read-only snapshot of a running Kookr instance.

Usage:
  kookr status
  kookr-status        Deprecated compatibility alias.

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

async function main({ argv = process.argv.slice(2), env = process.env, out = console, exit = process.exit } = {}) {
  if (argv.length > 0) {
    if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
      out.log(HELP_TEXT);
      return exit(0);
    }
    out.error(`Unexpected argument: ${argv[0]}`);
    out.error('Try `kookr status --help`.');
    return exit(2);
  }

  const resolved = await resolvePort(env);
  if (resolved.kind === 'invalid') {
    out.error(`KOOKR_PORT must be an integer between 1 and 65535 (got: ${JSON.stringify(resolved.raw)}).`);
    return exit(1);
  }
  if (resolved.kind === 'none') {
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
    out.error(`Unexpected /api/snapshot response (expected an array).`);
    return exit(1);
  }

  out.log(renderReport({ port, health, agents }));
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
  console.error('[kookr] WARNING: `kookr-status` is deprecated; use `kookr status`.');
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`kookr-status: ${msg}`);
    process.exit(1);
  });
}

export { HELP_TEXT, apiAuthHeaders, formatUptime, formatCost, isActiveFinding, summarize, renderReport, resolvePort, parsePortEnv, main };
