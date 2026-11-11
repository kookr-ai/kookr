/**
 * Pure helpers for turning a task prompt into a display name. Shared by the
 * server (deterministic fallback naming, snapshot projection) and the
 * dashboard (archived tasks loaded through "Load older history"), so every
 * surface strips the same prompt openers (#3561 slice 3).
 */

// The worktree-guardrail preamble that `applyWorktreeGuardrails`
// (server/worktree-guardrails.ts) prepends to a launched prompt: an opening
// "You are currently in the (main checkout|git worktree) `…`" line, one or
// more "- " guidance bullets, then a blank line separating it from the real
// prompt body. Kept intentionally structural (anchor line + bullet block +
// blank line) rather than pinned to the exact wording of each bullet, so it
// keeps matching as the guidance copy evolves — an earlier version enumerated
// every bullet verbatim and silently stopped stripping once a new bullet
// ("When an investigation…") was added (issue #1556).
const WORKTREE_GUARDRAIL_PREFIX_RE =
  /^You are currently in the (?:main checkout|git worktree) `[^\n]*\n(?:[-*] [^\n]*\n)+\n([\s\S]*)$/;

/**
 * Strip the worktree-guardrail preamble from a prompt-like string, returning
 * the real body. Returns the input unchanged when no guardrail prefix is
 * present. Used both for display and as the first step of deterministic task
 * naming so guardrail boilerplate never leaks into a task name (issue #1556).
 */
export function stripWorktreeGuardrailPrefix(text: string): string {
  const match = WORKTREE_GUARDRAIL_PREFIX_RE.exec(text);
  return match?.[1] ?? text;
}

// A line that, once leading markers are stripped, is nothing but JSON
// structural punctuation — `{`, `}`, `[`, `]`, optionally with a trailing
// comma/colon. These are the opening lines of a spawn payload pasted in as the
// prompt (issue #1556, task a5a89a9a named `"{"`) and must never become a task
// name; the namer falls through to the first line with real content.
const STRUCTURAL_JUNK_LINE_RE = /^[{}[\]()][{}[\]()\s,:]*$/;

function isNameWorthyLine(line: string): boolean {
  return line.length > 0 && !STRUCTURAL_JUNK_LINE_RE.test(line);
}

/**
 * The first prompt line worth naming a task after: guardrail preamble
 * stripped, leading markdown/list markers removed, JSON punctuation lines
 * skipped, whitespace collapsed. Empty when the prompt has no such line.
 */
export function firstMeaningfulPromptLine(prompt: string): string {
  const firstLine = stripWorktreeGuardrailPrefix(prompt)
    .split('\n')
    .map((line) => line.replace(/^[\s#>*-]+/, '').trim())
    .find(isNameWorthyLine);
  return firstLine?.replace(/\s+/g, ' ') ?? '';
}

// Words that address the agent instead of naming the work: "You are …",
// "Your job is to …", "Can you …", "Please …". A name that keeps them reads
// as a prompt, not a task (#3561 slice 3). "You must" and "You should" are
// left alone: stripping them turns "You must not push" into "Not push".
const PROMPT_OPENER_RE =
  /^(?:you\s+are|you['’]re|your\s+(?:job|task|goal|role|mission|assignment)\s+is(?:\s+to)?|you\s+(?:will|need\s+to)|i\s+(?:want|need)\s+you\s+to|(?:can|could|would)\s+you(?:\s+please)?|please,?)\s+/i;
// After "You are", a role sentence such as "a careful reviewer." names no
// work; it is dropped when more text follows it.
const ROLE_SENTENCE_RE = /^(?:an?|the)\s+[^.!?]*[.!?]\s+(?=\S)/i;
const MAX_OPENER_PASSES = 3;

/**
 * Remove prompt openers from the start of a prompt-derived task name and
 * capitalise what remains: "You are continuing a task chain" becomes
 * "Continuing a task chain", "You are a reviewer. Your job is to review
 * PR 12" becomes "Review PR 12". Returns the input unchanged when it has no
 * opener or when removing one would leave nothing. Pure and idempotent.
 */
export function stripPromptOpeners(name: string): string {
  const original = name.trim();
  let current = original;
  for (let pass = 0; pass < MAX_OPENER_PASSES; pass++) {
    const opener = PROMPT_OPENER_RE.exec(current);
    if (!opener) break;
    let rest = current.slice(opener[0].length);
    if (/^you(?:\s+are|['’]re)/i.test(opener[0])) rest = rest.replace(ROLE_SENTENCE_RE, '');
    rest = rest.trim();
    if (rest.length === 0) break;
    current = rest;
  }
  if (current === original) return name;
  return current.charAt(0).toUpperCase() + current.slice(1);
}

/**
 * The task name to show for a task. An authoritative name (set by a user,
 * a playbook or the LLM namer) is shown as is. A name derived from the prompt
 * (flagged `autoNamed`, or matching the prompt's first line, which covers
 * tasks named by the deterministic fallback before the flag was kept) has its
 * openers stripped, so stored names from before #3561 slice 3 display cleanly
 * without rewriting them. With no name, the prompt itself is the title.
 */
export function presentTaskName(
  task: { name?: string; autoNamed?: boolean },
  displayPrompt: string,
  untitled: (prompt: string) => string,
): string {
  const name = task.name;
  if (!name) return stripPromptOpeners(untitled(displayPrompt));
  // Cheap check first: this runs for every task on every snapshot, and most
  // names carry no opener, so the prompt is only scanned when one does.
  if (!PROMPT_OPENER_RE.test(name.trimStart())) return name;
  if (task.autoNamed || isPromptDerivedName(name, displayPrompt)) return stripPromptOpeners(name);
  return name;
}

function isPromptDerivedName(name: string, displayPrompt: string): boolean {
  const stem = name.replace(/…$/, '').trimEnd();
  return stem.length > 0 && firstMeaningfulPromptLine(displayPrompt).startsWith(stem);
}
