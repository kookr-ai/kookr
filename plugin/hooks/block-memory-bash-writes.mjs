#!/usr/bin/env node
// Logic for block-memory-bash-writes.sh. Reads a Claude Code PreToolUse hook
// event (Bash tool) from stdin and blocks common commands that WRITE/DELETE
// under a `.claude/projects/*/memory/` path. Reads (cat/grep/ls/head) pass.
//
// SCOPE: best-effort backstop, NOT a security boundary. A denylist over free-
// form shell cannot catch every write (interpreter writes like `python -c`,
// shell-var indirection, etc. evade it). The authoritative controls are
// (1) disabling auto memory at the source (CLAUDE_CODE_DISABLE_AUTO_MEMORY,
// which this gate also keys off) so the agent is never told to use memory, and
// (2) the Write/Edit/MultiEdit gate (parse-frontmatter.ts), which Bash redirects
// bypass. This gate exists to catch the common `cat >> .../memory/x.md`,
// `printf >> MEMORY.md`, and `rm .../memory/x.md` patterns those two miss.
//
// Detection is purely string/token based (indexOf + anchored token regexes) to
// stay linear — no `[^\n]*<path>` construction, which backtracks catastrophically
// on attacker/agent-influenced command strings.
//
// Exit: 0 = allow, 2 = block. Fail-open on parse errors.
import { readFileSync } from 'node:fs';

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  process.exit(0);
}

// Defensive: this helper only does anything when auto memory is disabled. The
// .sh wrapper already gates on this, but guard here too so a direct invocation
// can never change behavior when the operator has not opted in.
if (!process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) process.exit(0);

if ((event.tool_name ?? '') !== 'Bash') process.exit(0);

const cmd = String((event.tool_input ?? {}).command ?? '');
if (!cmd.includes('/memory/') || !cmd.includes('.claude/projects/')) process.exit(0);

// Anchored, tiny regexes (run only on short individual tokens — never the whole
// command — so no backtracking blowup).
const REDIRECT_OP = /^[0-9]*(?:&?>>?\|?|>&)$/; // > >> >| &> &>> 2> 2>> >&
const REDIRECT_PREFIX = /^[0-9]*(?:&?>>?\|?|>&)\S/; // >file with no space
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/; // VAR=val command prefix

// Linear memory-path test on a single token.
function isMemoryToken(rawTok) {
  let t = rawTok;
  const m = /^[0-9]*(?:&?>>?\|?|>&)/.exec(t); // strip a leading redirect operator
  if (m) t = t.slice(m[0].length);
  if (t.startsWith('of=')) t = t.slice(3); // dd of=<path>
  t = t.replace(/^["']+|["']+$/g, ''); // strip surrounding quotes
  const i = t.indexOf('.claude/projects/');
  return i !== -1 && t.indexOf('/memory/', i) !== -1;
}

const basename = (p) => p.replace(/^["']+|["']+$/g, '').split('/').pop() ?? '';

// Commands whose mere presence with a memory-path argument means a mutation.
const MUTATING_VERBS = new Set([
  'rm', 'tee', 'sed', 'mv', 'cp', 'install', 'ln', 'truncate', 'dd', 'touch',
  'mkdir', 'rmdir', 'chmod', 'chown', 'rsync',
]);

// Split into sub-commands. A single `|` separates a pipeline, but `>|` is a
// clobber redirect (not a pipe), so do not split on a `|` preceded by `>`.
const segments = cmd.split(/\|\||&&|(?<!>)\||;|\n/);
let blocked = false;

outer: for (const seg of segments) {
  if (!seg.includes('/memory/')) continue;
  const tokens = seg.trim().split(/\s+/).filter(Boolean);

  // (a) a redirect whose target is a memory path: `> mem`, `>>mem`, `>|mem`, `&> mem`
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (REDIRECT_OP.test(tok)) {
      if (i + 1 < tokens.length && isMemoryToken(tokens[i + 1])) { blocked = true; break outer; }
    } else if (REDIRECT_PREFIX.test(tok) && isMemoryToken(tok)) {
      blocked = true;
      break outer;
    }
  }

  // (b) a mutating verb as the command word + any memory-path argument
  const cmdWord = tokens.find((t) => !ENV_ASSIGN.test(t));
  if (cmdWord && MUTATING_VERBS.has(basename(cmdWord)) && tokens.some(isMemoryToken)) {
    blocked = true;
    break outer;
  }

  // (c) `of=<memory>` writers (dd and friends) even without a leading redirect
  if (tokens.some((t) => t.startsWith('of=') && isMemoryToken(t))) {
    blocked = true;
    break outer;
  }
}

if (blocked) {
  const home = process.env.HOME ?? '';
  process.stderr.write(
    [
      'block-memory-bash-writes: blocked a Bash write to the RETIRED file-based memory system.',
      'This command mutates a .claude/projects/*/memory/ path (auto memory is disabled).',
      "→ Facts about tools/stack/environment: ~/knowledge_bases/ via 'kb remember'.",
      `→ Behavioral rules: ${home}/.claude/CLAUDE.md (user) or the repo CLAUDE.md (project).`,
      'Reading memory (cat/grep/ls) is fine; only writes are blocked.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

process.exit(0);
