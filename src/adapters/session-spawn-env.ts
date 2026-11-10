// src/adapters/session-spawn-env.ts — the environment a spawned agent receives.
//
// Owns one choke point, `composeSessionSpawnEnv`, for both env modes, the
// inherited-marker strip below, and TERM normalization.
//
// Spawned agent sessions inherit the Kookr server's own `process.env` (the
// `envMode: 'inherit'` path in local-dtach-backend.ts). That is normally what we
// want — PATH, HOME, locale and provider credentials all need to reach the
// agent. But a few variables describe the *server's own* position in a process
// tree, and an agent that reads them as if they described itself changes
// behavior in ways that break Kookr.
//
// `CLAUDE_CODE_CHILD_SESSION` is the motivating case. Claude Code sets it for
// processes it spawns so a nested CLI knows it is a child of another session,
// and a child session does not persist a conversation transcript. When the
// Kookr server is itself started from inside a Claude Code session — a restart
// or deploy run from an agent's shell is the usual route — the marker lands in
// the server's environment and is then inherited by *every* agent the server
// spawns. Those agents report "Transcript saving is off — inherited
// CLAUDE_CODE_CHILD_SESSION marker" and write no transcript.
//
// The consequence is not cosmetic. Kookr's whole session-restore story
// (docs/rfc/rfc-restore-lost-agent-sessions.md) resumes a dead task's
// conversation with `claude --resume <id> --fork-session`. With no transcript on
// disk there is no conversation to resume, so both crash recovery and the
// operator's Reopen button relaunch into `No conversation found with session
// ID: …` — the agent exits immediately and the task is reaped as hung.
//
// Stripping the marker at the spawn choke point fixes it for every agent type
// and for however the marker reached the server, which is why this lives in the
// backend rather than in one adapter.

import { ensureInteractiveTermEnv } from './session-term-env.js';

/**
 * Environment variables describing the *server's* process-tree position, which
 * must never be inherited by a spawned agent CLI.
 *
 * Keep this list minimal: only variables that are actively harmful when an
 * agent reads them as self-describing belong here. Anything an agent legitimately
 * needs — credentials, PATH, locale — must keep flowing through.
 */
export const NON_INHERITABLE_AGENT_ENV_VARS: readonly string[] = [
  // Claude Code: suppresses transcript persistence for nested sessions, which
  // silently disables conversation resume for every task Kookr launches.
  'CLAUDE_CODE_CHILD_SESSION',
];

/**
 * Return a copy of `env` with every {@link NON_INHERITABLE_AGENT_ENV_VARS} entry
 * removed.
 *
 * Applied to the *inherited* portion only, before any caller-supplied `spec.env`
 * is merged on top. A caller that deliberately sets one of these variables for a
 * specific session therefore still wins — this only drops what leaked in from
 * the server's own environment.
 */
export function stripNonInheritableAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of NON_INHERITABLE_AGENT_ENV_VARS) delete next[name];
  return next;
}

/**
 * Compose the exact environment a spawned agent session receives — the single
 * choke point for both env modes, the inherited-marker strip, and TERM
 * normalization.
 *
 * Order matters and is asserted by tests:
 *  1. `'replace'` starts from the caller's allowlist alone; `'inherit'` (the
 *     default) starts from the server's environment minus
 *     {@link NON_INHERITABLE_AGENT_ENV_VARS}.
 *  2. `specEnv` is merged on top, so a caller that deliberately sets one of the
 *     stripped markers still wins.
 *  3. TERM is normalized last, so neither an inherited nor an explicit
 *     `TERM=dumb` can reach a PTY-backed agent TUI.
 */
export function composeSessionSpawnEnv(args: {
  specEnv?: Record<string, string>;
  envMode?: 'inherit' | 'replace';
  processEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const { specEnv, envMode, processEnv = process.env } = args;
  const base =
    envMode === 'replace' ? {} : stripNonInheritableAgentEnv(processEnv);
  return ensureInteractiveTermEnv({ ...base, ...specEnv });
}
