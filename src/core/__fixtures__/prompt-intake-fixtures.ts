// Regression fixtures for issue #1556 — the two real-world prompt shapes that
// leaked into task names in prod. Shared by task-naming.test.ts and
// prompt-display.test.ts so both exercise the exact same payloads.

/**
 * Task a5a89a9a: a CLI caller pasted the whole JSON spawn payload as the
 * `prompt`, so the deterministic namer took the literal first line — `{` — and
 * the task was named `"{"`. The payload carries the caller's intended name in
 * an embedded `name` field.
 */
export const JSON_SPAWN_PAYLOAD_PROMPT = `{
  "prompt": "Audit retrieval coverage across the KB shelves and report gaps.",
  "cwd": "/path/to/repo",
  "agentType": "claude",
  "name": "Retrieval Coverage Audit"
}`;

/** The name embedded in {@link JSON_SPAWN_PAYLOAD_PROMPT}. */
export const JSON_SPAWN_PAYLOAD_EMBEDDED_NAME = 'Retrieval Coverage Audit';

/** A JSON spawn payload of the same shape but with no `name` field. */
export const JSON_SPAWN_PAYLOAD_PROMPT_NO_NAME = `{
  "prompt": "Audit retrieval coverage across the KB shelves and report gaps.",
  "cwd": "/path/to/repo",
  "agentType": "claude"
}`;

/**
 * Task 447580f6: the `userPrompt` itself began with the worktree-guardrail
 * preamble — a caller re-spawned by pasting an already-guarded prompt back in,
 * so both the name and the displayed prompt led with the boilerplate. This is a
 * frozen historical sample of the preamble, including the "When an
 * investigation…" bullet that the earlier strip regex missed — the live
 * preamble has since gained bullets this sample does not carry, and the strip
 * regex is structural, so the sample does not need to track it.
 */
export const GUARDRAIL_PREFIXED_USER_PROMPT = `You are currently in the main checkout \`/path/to/repo\` on branch \`main\`. Do NOT commit to main or in this checkout — every Kookr task must make tracked-file changes in a fresh git worktree of its own, not in any pre-existing checkout (the main repo, the production runtime worktree, or any sibling worktree spawned for unrelated work).
- Refresh the remote base first: \`git fetch origin 'main'\`.
- Create one: \`git worktree add ../kookr-<short-name> -b <feature-branch> 'origin/main'\`
- Perform all tracked-file edits, commits, and pushes from that new worktree.
- If the task stays read-only, you may remain in the current checkout.
- When an investigation or analysis wraps up and the task hasn't already fixed the path forward, pick a right-sized next step from the evidence and execute it autonomously (implement now for a small change, open an issue for a medium one, draft an RFC or umbrella issue for a large one) — do not stop after the diagnosis to ask which path to take when the size is already clear. Carry the chosen path through its required follow-up (RFC iterative review when drafting; planned implementation slices when the diagnosis warrants them and delivery rules allow). Ask only when the right size is genuinely ambiguous or a product/scope choice cannot be justified from the evidence.
- After committing, don't end your turn silently — unless the task already told you to deliver, ask the user whether to push the branch and open a PR.

Harden the retrieval scorer against empty shelves.`;

/** The real body of {@link GUARDRAIL_PREFIXED_USER_PROMPT}, preamble removed. */
export const GUARDRAIL_PREFIXED_USER_PROMPT_BODY =
  'Harden the retrieval scorer against empty shelves.';
