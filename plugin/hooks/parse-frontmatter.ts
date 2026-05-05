#!/usr/bin/env bun
// Reflect-task memory write gate.
//
// Stdin: a Claude Code PreToolUse hook event JSON.
// Stdout: nothing (silence on allow).
// Stderr: a redirect message on block, named the right destination so the agent
//         doesn't paraphrase-loop trying to bypass the gate.
//
// Exit:
//   0  → allow (path is not a memory path, OR frontmatter type is acceptable)
//   2  → block (memory path AND missing/malformed/banned frontmatter type)
//
// Behavior is fail-closed: any parse failure or unexpected shape blocks. Bash
// entry-point also blocks if `bun` is unavailable, so the agent never reaches
// memory-write paths without this check having a chance to run.

import { readFileSync, existsSync } from 'node:fs';

// Memory paths the gate cares about. Hardcoded to the canonical Claude Code
// memory layout — projects/<encoded-cwd>/memory/*.md under HOME/.claude.
function isMemoryPath(p: string): boolean {
  const home = process.env.HOME ?? '';
  if (!home) return false;
  // Match both ~/.claude/projects/.../memory/*.md and equivalent absolute path
  return p.startsWith(`${home}/.claude/projects/`) && p.includes('/memory/');
}

// Read all of stdin (the hook event).
const stdin = readFileSync(0, 'utf-8');
let event: { tool_name?: string; tool_input?: unknown };
try {
  event = JSON.parse(stdin);
} catch {
  // Can't parse the event itself — fail-closed.
  console.error('reflect-memory-frontmatter-gate: malformed hook event JSON; blocking.');
  process.exit(2);
}

const toolName = event.tool_name ?? '';
if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') {
  // Not a write tool; nothing to gate.
  process.exit(0);
}

const toolInput = (event.tool_input ?? {}) as Record<string, unknown>;
const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

if (!filePath || !isMemoryPath(filePath)) {
  // Not a memory path; not our concern.
  process.exit(0);
}

// Memory path. Determine the would-be content.
let content: string;
if (toolName === 'Write') {
  content = typeof toolInput.content === 'string' ? toolInput.content : '';
} else if (toolName === 'Edit') {
  // Edit replaces old_string with new_string in an existing file. We need the
  // post-edit content to inspect the post-edit frontmatter. Cheap heuristic:
  // read the existing file, apply the substitution.
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const oldStr = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
  const newStr = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
  content = existing.replace(oldStr, newStr);
} else {
  // MultiEdit — multiple sequential edits. Apply each.
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  let working = existing;
  const edits = (toolInput.edits ?? []) as Array<{ old_string?: string; new_string?: string }>;
  for (const edit of edits) {
    if (typeof edit.old_string === 'string' && typeof edit.new_string === 'string') {
      working = working.replace(edit.old_string, edit.new_string);
    }
  }
  content = working;
}

const verdict = inspectFrontmatter(content);
if (verdict.allow) {
  process.exit(0);
}

// Block. Print a destination-naming message so the agent doesn't paraphrase-loop.
const home = process.env.HOME ?? '';
console.error(
  [
    `reflect-memory-frontmatter-gate: blocked write to ${filePath}.`,
    `Reason: ${verdict.reason}`,
    ``,
    `Memory writes from a reflect task require frontmatter \`type: context | reference | project_history\`.`,
    `Behavioral rules belong elsewhere:`,
    `  - Hooks: <project>/.claude/hooks/ or ${home}/.claude/hooks/`,
    `  - Skills: <project>/.claude/skills/ or ${home}/.claude/skills/`,
    `  - CLAUDE.md: <project>/CLAUDE.md or ${home}/.claude/CLAUDE.md`,
    `Pick the strongest mechanism that applies (project Persistence Mechanism Picker).`,
  ].join('\n'),
);
process.exit(2);

interface Verdict {
  allow: boolean;
  reason: string;
}

function inspectFrontmatter(content: string): Verdict {
  // Strict YAML frontmatter: must start with --- on line 1, end with --- on a
  // subsequent line. Anything else fails closed.
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { allow: false, reason: 'no YAML frontmatter (file does not start with `---`)' };
  }
  // Find closing fence
  const lines = content.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { allow: false, reason: 'YAML frontmatter not closed with `---`' };
  }
  const fmLines = lines.slice(1, closeIdx);

  // Look for a `type:` key. We do NOT support multi-line values, lists, or
  // block scalars for the type field — it must be a simple scalar on one line.
  // This is intentional: the strictness eliminates the bash-YAML-parsing
  // class of bypasses.
  const typeMatch = fmLines.find((line) => /^type\s*:/.test(line));
  if (!typeMatch) {
    return { allow: false, reason: '`type:` key absent from frontmatter' };
  }
  const valueRaw = typeMatch.replace(/^type\s*:\s*/, '').trim();
  // Strip a trailing comment if present
  const value = valueRaw.replace(/#.*$/, '').trim().replace(/^["']|["']$/g, '');

  if (value === 'feedback') {
    return { allow: false, reason: '`type: feedback` (behavioral rule) is banned in mixed-runtime projects' };
  }
  const allowed = new Set(['context', 'reference', 'project_history', 'user', 'project']);
  // 'user' and 'project' are auto-memory legacy types accepted for compatibility
  // with the existing memory corpus; the gate's job is specifically to block
  // 'feedback' (behavioral rule) writes from a reflect spawn.
  if (allowed.has(value)) {
    return { allow: true, reason: 'ok' };
  }
  return { allow: false, reason: `unrecognized \`type: ${value}\` — only context|reference|project_history|user|project allowed` };
}
