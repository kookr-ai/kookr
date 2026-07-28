import type { AgentEvent } from './types.js';
import type { CriteriaCompletionVerdict } from '../shared/contracts/completion-digest.js';

/**
 * Structured summary of what an agent accomplished during a task.
 * Generated on task completion from the event window + GitHub state.
 */
export interface CompletionDigest {
  /** 2-5 human-readable bullet points summarising the work done. */
  bullets: string[];
  /** Unique files that were written, edited, or observed in the final branch diff. */
  filesChanged: string[];
  /** Brief test result summary, if detected. */
  testSummary?: string;
  /** Git branch used for the completed work, when available. */
  branch?: string;
  /** Commit SHA(s) that belong to the completed work, when available. */
  commits?: string[];
  /** Pull request URL(s) created or updated by the task, when available. */
  prUrls?: string[];
  /**
   * Merge commit SHA of the task's delivered PR, when it merged (issue #1596).
   * The containment key the per-schedule ROI rollup tests against the last
   * smoke-gate-passed prod SHA to distinguish `merged` from `live-verified`.
   */
  mergeCommit?: string;
  /** Verification commands the agent ran, preserved for later review. */
  verificationCommands?: string[];
  /** Token/cost closeout, including explicit unavailable states. */
  tokenUsage?: CompletionTokenUsage;
  /** Advisory LLM-assisted check of user-provided completion criteria. */
  criteriaVerdict?: CriteriaCompletionVerdict;
}

export type CompletionTokenUsageQuality =
  | 'available'
  | 'unavailable'
  | 'unknown-pricing'
  | 'parse-error'
  | 'rollout-not-found'
  | 'rollout-abandoned';

export interface CompletionTokenUsage {
  source: 'transcript' | 'codex-rollout';
  quality: CompletionTokenUsageQuality;
  model?: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  reason?: string;
}

/**
 * Generate a completion digest from the agent's event window.
 *
 * Rule-based extraction — no LLM call, no external dependencies.
 * Scans tool_use / tool_result events for files changed, git commits,
 * test results, and the agent's final stop message.
 */
export function generateCompletionDigest(
  events: AgentEvent[],
  opts?: {
    prUrls?: string[];
    branch?: string;
    commits?: string[];
    filesChanged?: string[];
    tokenUsage?: CompletionTokenUsage;
  },
): CompletionDigest {
  const filesChanged = unique([...(opts?.filesChanged ?? []), ...extractFilesChanged(events)]);
  const testSummary = extractTestSummary(events);
  const commitCount = opts?.commits?.length ?? countGitCommits(events);
  const prUrls = unique([...(opts?.prUrls ?? []), ...extractPrUrls(events)]);
  const verificationCommands = extractVerificationCommands(events);
  const bullets: string[] = [];

  if (filesChanged.length > 0) {
    const shown = filesChanged.slice(0, 3).join(', ');
    const extra = filesChanged.length > 3 ? ` +${filesChanged.length - 3} more` : '';
    bullets.push(`Changed ${filesChanged.length} file${filesChanged.length !== 1 ? 's' : ''}: ${shown}${extra}`);
  }

  if (prUrls.length > 0) {
    bullets.push(`Created PR${prUrls.length > 1 ? 's' : ''}: ${prUrls.join(', ')}`);
  }

  if (opts?.branch) {
    bullets.push(`Branch: ${opts.branch}`);
  }

  if (commitCount > 0) {
    bullets.push(`Made ${commitCount} commit${commitCount !== 1 ? 's' : ''}`);
  }

  if (testSummary) {
    bullets.push(testSummary);
  }

  if (opts?.tokenUsage?.quality !== undefined && opts.tokenUsage.quality !== 'available') {
    bullets.push(`Token usage unavailable: ${opts.tokenUsage.reason ?? opts.tokenUsage.quality}`);
  }

  // Pad with the agent's final message if we have < 2 bullets
  if (bullets.length < 2) {
    const lastStop = findLastStop(events);
    if (lastStop) {
      bullets.push(lastStop.slice(0, 200));
    }
  }

  // Fallback when nothing was extractable
  if (bullets.length === 0) {
    bullets.push('Task completed');
  }

  const digest: CompletionDigest = {
    bullets: bullets.slice(0, 5),
    filesChanged,
    testSummary,
  };
  if (opts?.branch) digest.branch = opts.branch;
  if (opts?.commits && opts.commits.length > 0) digest.commits = opts.commits;
  if (prUrls.length > 0) digest.prUrls = prUrls;
  if (verificationCommands.length > 0) digest.verificationCommands = verificationCommands;
  if (opts?.tokenUsage) digest.tokenUsage = opts.tokenUsage;
  return digest;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractFilesChanged(events: AgentEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    if (event.toolName !== 'Write' && event.toolName !== 'Edit') continue;
    const input = event.toolInput as Record<string, unknown> | undefined;
    const filePath = input?.file_path as string | undefined;
    if (filePath) {
      files.add(filePath.split('/').pop() ?? filePath);
    }
  }
  return Array.from(files);
}

function extractTestSummary(events: AgentEvent[]): string | undefined {
  // Walk backwards to find the most recent test output
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'tool_result' || event.toolName !== 'Bash') continue;

    const response = String(event.toolResponse ?? '');

    // Vitest-style: "Tests  12 passed (3)" / "Tests  2 failed | 10 passed"
    const vitestMatch = response.match(/Tests\s+(\d+\s+(?:passed|failed)(?:\s*\|\s*\d+\s+(?:passed|failed))*)/i);
    if (vitestMatch) return `Tests: ${vitestMatch[1].trim()}`;

    // Generic: "N tests passed", "N tests failed"
    const passMatch = response.match(/(\d+)\s+(?:tests?|specs?)\s+passed/i);
    const failMatch = response.match(/(\d+)\s+(?:tests?|specs?)\s+failed/i);
    if (passMatch || failMatch) {
      const parts: string[] = [];
      if (passMatch) parts.push(`${passMatch[1]} passed`);
      if (failMatch) parts.push(`${failMatch[1]} failed`);
      return `Tests: ${parts.join(', ')}`;
    }
  }
  return undefined;
}

function countGitCommits(events: AgentEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== 'tool_use' || event.toolName !== 'Bash') continue;
    const input = event.toolInput as Record<string, unknown> | undefined;
    const cmd = input?.command as string | undefined;
    if (cmd && /git\s+commit\b/.test(cmd)) count++;
  }
  return count;
}

function extractVerificationCommands(events: AgentEvent[]): string[] {
  const commands: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_use' || event.toolName !== 'Bash') continue;
    const input = event.toolInput as Record<string, unknown> | undefined;
    const command = input?.command;
    if (typeof command !== 'string') continue;
    if (isVerificationCommand(command)) commands.push(command);
  }
  return unique(commands);
}

function isVerificationCommand(command: string): boolean {
  return /\b(test|vitest|playwright|tsc|type-?check|check:e2e|lint|build)\b/i.test(command);
}

function extractPrUrls(events: AgentEvent[]): string[] {
  const urls: string[] = [];
  for (const event of events) {
    if (event.type === 'tool_result') {
      urls.push(...githubPrUrls(String(event.toolResponse ?? '')));
    } else if ((event.type === 'stop' || event.type === 'stop_failure') && event.lastMessage) {
      urls.push(...githubPrUrls(event.lastMessage));
    }
  }
  return unique(urls);
}

function githubPrUrls(text: string): string[] {
  return text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g) ?? [];
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function findLastStop(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ((event.type === 'stop' || event.type === 'stop_failure') && event.lastMessage) {
      return event.lastMessage;
    }
  }
  return undefined;
}
