#!/usr/bin/env node
// SessionStart injector for the Agent Notebook — inject the notebook INDEX so
// the agent starts a task already seeing what experience exists, without
// spending a call.
//
// This follows the published agent-notebook harness recipe
// (examples/hooks/claude-code/nb-session-start.sh): inject `nb list` — the index
// of every notebook (shelf) with its one-line "open me when…" description — and
// let the agent open the shelves that fit its task. It is deliberately
// role-agnostic: there is no NB_ROLE and nothing guesses a per-repo shelf. The
// same injection runs for every session, so a lesson the agent would never
// think to search for still reaches it by meeting a shelf's trigger in the index.
//
// The index is tiny by construction (one line per shelf), so we inject the whole
// thing — no retrieval needed. Output goes to stdout, which Claude Code adds to
// the session context for a SessionStart hook.
//
// Fail-open everywhere: if `nb` is not on PATH or there is no notebook yet,
// inject nothing and exit 0. Never block a session start.
import { execFileSync } from 'node:child_process';

let index = '';
try {
  index = execFileSync('nb', ['list'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 4000,
  }).trim();
} catch {
  /* nb not installed / timeout — inject nothing */
  process.exit(0);
}

// Empty store → `nb list` leaves stdout empty (its "no notebooks yet" notice
// goes to stderr, which we ignore). Nothing to surface → stay silent.
if (!index) process.exit(0);

process.stdout.write(
  `## Your agent-notebook index\n` +
    `Below is an index of your notebooks. Each one is a "shelf": a short, bounded list of ` +
    `one-line lessons for one kind of task, written by you and other agents on past tasks. ` +
    `Each line shows the shelf name, how many lessons it holds, and when to open it.\n` +
    `Open the shelves that fit this task with \`nb show <shelf>\` (the shelf name is the first ` +
    `column) and apply what they say. If the work turns up a new kind of problem, check the ` +
    `index again and open another shelf.\n` +
    `At the end you will be asked for a short retrospective on the shelves you opened — vote the ` +
    `lessons that helped, \`nb rm\` any that were wrong, and \`nb add\` at most one new lesson (or none).\n\n` +
    index +
    '\n',
);
process.exit(0);
