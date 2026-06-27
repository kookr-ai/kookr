import type { AgentState } from '../shared/contracts/agent-state.js';
import type { CompletionDigest } from '../shared/contracts/completion-digest.js';
import { redactSecrets } from './redact-secrets.js';

/**
 * One-click task handoff digest (issue #1042).
 *
 * Packages a single task into a concise, human-readable markdown packet an
 * operator can paste into a chat, ticket, or another agent's prompt when
 * handing off blocked or completed work. It is intentionally distinct from:
 *   - the live read-only share link (F16) — that streams live state,
 *   - the bug-report bundle — that is a redacted diagnostic blob for support.
 *
 * The packet is assembled purely from the projected {@link AgentState} the
 * dashboard already holds (task metadata, latest finding, completion digest,
 * GitHub refs, verification commands) so there is no new data dependency and
 * no external service call. All free text is passed through the shared
 * {@link redactSecrets} guardrail and length-capped before it leaves the app.
 */

export interface TaskHandoffOptions {
  /** Clock injection for deterministic tests. */
  now?: Date;
  /** Per-field free-text cap, in characters. Defaults to {@link DEFAULT_SNIPPET_CAP}. */
  maxSnippetLength?: number;
  /** Hard cap on the rendered markdown, in characters. Defaults to {@link DEFAULT_TOTAL_CAP}. */
  maxTotalLength?: number;
}

/** Default per-field free-text cap. */
export const DEFAULT_SNIPPET_CAP = 600;
/** Default hard cap on the whole rendered packet. */
export const DEFAULT_TOTAL_CAP = 16_000;

/**
 * Build the markdown handoff packet for a single task.
 *
 * Pure and synchronous: no I/O, no LLM call. Safe to run on the client the
 * moment the operator clicks "Copy handoff".
 */
export function buildTaskHandoffDigest(agent: AgentState, opts: TaskHandoffOptions = {}): string {
  const now = opts.now ?? new Date();
  const snippetCap = clampPositive(opts.maxSnippetLength, DEFAULT_SNIPPET_CAP);
  const totalCap = clampPositive(opts.maxTotalLength, DEFAULT_TOTAL_CAP);

  const title = clean(agent.taskName, snippetCap) ?? agent.taskId ?? agent.agentId;
  const sections: string[] = [];

  sections.push(`# Task handoff: ${title}`);
  sections.push(`_Generated ${now.toISOString()}_`);

  sections.push(renderStatus(agent));

  const prompt = clean(agent.description, snippetCap);
  if (prompt) sections.push(`## Prompt / criteria\n${prompt}`);

  const finding = renderFinding(agent, snippetCap);
  if (finding) sections.push(finding);

  const digest = renderDigest(agent.completionDigest, snippetCap);
  if (digest) sections.push(digest);

  const github = renderGitHub(agent);
  if (github) sections.push(github);

  const verification = renderVerification(agent.completionDigest);
  if (verification) sections.push(verification);

  sections.push(`## Next action\n${nextAction(agent)}`);

  const markdown = sections.join('\n\n').trimEnd() + '\n';
  if (markdown.length <= totalCap) return markdown;
  // Keep the rendered packet at or under the cap even for pathologically small
  // caps: only append the notice when it fits, otherwise hard-slice.
  if (totalCap < TRUNCATION_NOTICE.length) return markdown.slice(0, totalCap);
  return markdown.slice(0, totalCap - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

const TRUNCATION_NOTICE = '\n\n_… handoff truncated to size cap._\n';

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderStatus(agent: AgentState): string {
  const lines = ['## Status'];
  lines.push(`- Lifecycle: ${agent.taskStatus ?? 'unknown'}`);
  if (agent.turnState) lines.push(`- Turn state: ${agent.turnState}`);
  lines.push(`- Disposition: ${isBlocked(agent) ? 'blocked — needs attention' : isCompleted(agent) ? 'completed' : 'in progress'}`);
  if (agent.gitIsWorktree && agent.cwd) lines.push(`- Worktree: ${agent.cwd}`);
  return lines.join('\n');
}

function renderFinding(agent: AgentState, cap: number): string | undefined {
  const anomaly = agent.anomaly;
  if (!anomaly) return undefined;
  const explanation = clean(anomaly.explanation, cap);
  const lines = ['## Latest finding'];
  const header = `- ${anomaly.type} (${anomaly.severity})${anomaly.subType ? ` · ${anomaly.subType}` : ''}`;
  lines.push(header);
  if (explanation) lines.push(`\n${explanation}`);
  return lines.join('\n');
}

function renderDigest(digest: CompletionDigest | undefined, cap: number): string | undefined {
  if (!digest) return undefined;
  const lines = ['## Completion digest'];
  for (const bullet of digest.bullets ?? []) {
    const text = clean(bullet, cap);
    if (text) lines.push(`- ${text}`);
  }
  if (digest.filesChanged && digest.filesChanged.length > 0) {
    const shown = digest.filesChanged.slice(0, 10).map((f) => clean(f, cap) ?? f);
    const extra = digest.filesChanged.length > 10 ? ` (+${digest.filesChanged.length - 10} more)` : '';
    lines.push(`- Files changed: ${shown.join(', ')}${extra}`);
  }
  if (digest.testSummary) {
    const text = clean(digest.testSummary, cap);
    if (text) lines.push(`- ${text}`);
  }
  return lines.length > 1 ? lines.join('\n') : undefined;
}

function renderGitHub(agent: AgentState): string | undefined {
  const prUrls = agent.completionDigest?.prUrls ?? [];
  const branch = agent.gitBranch ?? agent.completionDigest?.branch;
  const commits = agent.completionDigest?.commits ?? (agent.gitCommit ? [agent.gitCommit] : []);
  if (prUrls.length === 0 && !branch && commits.length === 0) return undefined;

  const lines = ['## GitHub references'];
  for (const url of prUrls) lines.push(`- PR: ${redactSecrets(url)}`);
  if (branch) lines.push(`- Branch: \`${redactSecrets(branch)}\``);
  for (const sha of commits.slice(0, 5)) lines.push(`- Commit: \`${redactSecrets(sha)}\``);
  return lines.join('\n');
}

function renderVerification(digest: CompletionDigest | undefined): string | undefined {
  const commands = digest?.verificationCommands ?? [];
  if (commands.length === 0) return undefined;
  const lines = ['## Verification commands'];
  for (const command of commands.slice(0, 10)) {
    lines.push('```sh');
    lines.push(redactSecrets(command));
    lines.push('```');
  }
  return lines.join('\n');
}

function nextAction(agent: AgentState): string {
  if (isBlocked(agent)) {
    return agent.anomaly?.subType === 'ask_user_question'
      ? 'Answer the agent\'s question, then resume the task.'
      : 'Investigate the finding above and unblock the agent.';
  }
  if (isCompleted(agent)) {
    const prUrls = agent.completionDigest?.prUrls ?? [];
    return prUrls.length > 0
      ? 'Review the linked pull request(s) and merge if the criteria are met.'
      : 'Review the completed changes and confirm the criteria are met.';
  }
  return 'Resume or continue monitoring this task.';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlocked(agent: AgentState): boolean {
  if (!agent.anomaly) return false;
  return agent.anomaly.severity === 'critical' || agent.anomaly.subType === 'ask_user_question';
}

function isCompleted(agent: AgentState): boolean {
  return agent.taskStatus === 'completed';
}

/** Trim, redact, collapse blank-only strings to undefined, and length-cap. */
function clean(value: string | undefined, cap: number): string | undefined {
  if (!value) return undefined;
  const redacted = redactSecrets(value).trim();
  if (!redacted) return undefined;
  if (redacted.length <= cap) return redacted;
  return redacted.slice(0, cap).trimEnd() + '… [truncated]';
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
