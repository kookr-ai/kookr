#!/usr/bin/env node
// SessionStart injector for the Agent Notebook. When the session is running as
// a specialized role (env NB_ROLE set), inject that role's bounded notebook
// into context so the agent starts the task already knowing its past lessons.
//
// The notebook is tiny by construction (<=200 one-line entries), so we inject
// the whole thing — no retrieval needed. Output goes to stdout, which Claude
// Code adds to the session context for a SessionStart hook.
//
// Fail-open everywhere: if NB_ROLE is unset, `nb` is not on PATH, or there is
// no notebook yet, inject nothing and exit 0. Never block a session start.
import { execFileSync } from 'node:child_process';

const role = process.env.NB_ROLE;
if (!role || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(role)) process.exit(0);

try {
  const out = execFileSync('nb', ['show', role], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 4000,
  }).trim();
  // The empty sentinel is `(notebook for role "X" is empty)` — match its prefix,
  // not the substring "is empty", so a lesson containing those words still injects.
  if (out && !out.startsWith('(notebook for role')) {
    process.stdout.write(
      `## Your notebook — role: ${role}\n` +
        `Bounded, voted lessons from your past tasks (highest-scored first). ` +
        `Use them. At task end, maintain them: vote +1 on the ones that helped, ` +
        `-1 on any that misled you, \`nb rm\` any that proved incorrect, add at most ` +
        `one new ≤120-char lesson, and \`nb merge\` redundant ones if the notebook is full. ` +
        `To see what other roles exist — to reuse one, or spawn a subagent under it — run \`nb roles\`:\n\n` +
        out +
        '\n',
    );
  }
} catch {
  /* nb not installed / no notebook / timeout — inject nothing */
}
process.exit(0);
