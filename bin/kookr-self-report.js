#!/usr/bin/env node
// kookr-self-report — let a launched agent report that it cannot do its job
// because of something upstream of the work itself (issue #2977).
//
// On the agent's PATH via buildAgentLaunchContext, alongside the `kb` and
// `kookr` shims. Self-contained on purpose: an agent reaching for this has
// already hit something broken, so the report must not depend on a build
// having succeeded. Types live in bin/kookr-self-report.d.ts; tests in
// src/cli/kookr-self-report.test.ts drive `runSelfReportCli` directly.
//
//   kookr-self-report "the prompt stops mid-sentence after 'not in'"
//   kookr-self-report --kind environment_broken "the worktree has no origin remote"
//
// Identity and endpoint come from the session environment (KOOKR_AGENT_ID,
// KOOKR_API_BASE_URL), so there is nothing to look up or quote by hand.

/**
 * Keep in lockstep with `SELF_REPORT_KINDS` in
 * `src/server/routes/self-report-routes.ts` — the server rejects anything else.
 */
const KINDS = ['prompt_unusable', 'environment_broken', 'other'];

/** Keep in lockstep with `SELF_REPORT_PATH` in the same module. */
const SELF_REPORT_PATH = '/api/self-report';

/** An agent hitting this is already in trouble; never hang it on a wedged server. */
const REQUEST_TIMEOUT_MS = 5_000;

const USAGE = `usage: kookr-self-report [--kind ${KINDS.join('|')}] "<what is wrong>"`;

export async function runSelfReportCli({
  argv = [],
  env = process.env,
  fetchImpl = fetch,
  out = console.log,
  err = console.error,
} = {}) {
  let kind = 'prompt_unusable';
  let kindSeen = false;
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out(USAGE);
      return 0;
    }
    if (arg.startsWith('--kind=')) {
      kind = arg.slice('--kind='.length);
      kindSeen = true;
      continue;
    }
    if (arg === '--kind') {
      kind = argv[i + 1] ?? '';
      kindSeen = true;
      i += 1;
      continue;
    }
    rest.push(arg);
  }

  // Kind before detail: `--kind "my prompt is broken"` swallows the detail as a
  // kind, and complaining about a missing detail there would send the agent
  // looking for the wrong mistake.
  if (kindSeen && !KINDS.includes(kind)) {
    err(`kookr-self-report: --kind must be one of: ${KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
    return 2;
  }

  const detail = rest.join(' ').trim();
  if (!detail) {
    err('kookr-self-report: a detail describing what is wrong is required');
    err(USAGE);
    return 2;
  }

  const agentId = env.KOOKR_AGENT_ID;
  const baseUrl = env.KOOKR_API_BASE_URL;
  if (!agentId || !baseUrl) {
    err('kookr-self-report: KOOKR_AGENT_ID and KOOKR_API_BASE_URL must be set (this runs inside a Kookr session)');
    return 2;
  }

  // A non-loopback server requires a bearer token (issue #708). Agents inherit
  // the server's environment, so the token is present exactly when it is
  // needed; without this the escape hatch 401s on every remote deployment —
  // the unattended ones where nobody is watching the terminal.
  const token = env.KOOKR_API_TOKEN && env.KOOKR_API_TOKEN.trim();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetchImpl(`${baseUrl}${SELF_REPORT_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId, kind, detail }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      err(`kookr-self-report: server returned ${res.status} ${await res.text()}`);
      return 1;
    }
    out(`kookr-self-report: recorded ${kind} for ${agentId}`);
    return 0;
  } catch (error) {
    err(`kookr-self-report: could not reach ${baseUrl} — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Direct execution (the PATH shim) — tests import runSelfReportCli instead.
if (process.argv[1] && process.argv[1].endsWith('kookr-self-report.js')) {
  process.exit(await runSelfReportCli({ argv: process.argv.slice(2) }));
}
