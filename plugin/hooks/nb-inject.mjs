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

// `nb list` prints a "(no notebooks…)" sentinel when the store is empty; match
// its prefix so a real shelf whose text happens to contain those words still
// injects. Nothing worth surfacing → stay silent.
if (!index || index.startsWith('(no notebooks')) process.exit(0);

process.stdout.write(
  `## Your agent-notebook index\n` +
    `These are your available notebooks (each a "shelf" — a bounded, voted set of ` +
    `one-line lessons for one kind of task), written by you and other agents across ` +
    `past tasks. Open the shelf/shelves whose description fits this task with ` +
    `\`nb show <shelf>\` — and open more the moment the task reveals a need you didn't ` +
    `see coming (a snag another shelf has already learned). Use their lessons.\n` +
    `At the end, run the retrospective on the shelves you used: \`nb vote <shelf> <id> +1\` ` +
    `on what helped and \`-1\` on what misled, prune/merge/split to keep each shelf sharp, ` +
    `and \`nb add <shelf> "<lesson>"\` at most one new durable lesson (or none).\n\n` +
    index +
    '\n',
);
process.exit(0);
