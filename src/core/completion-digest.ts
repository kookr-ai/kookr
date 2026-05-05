import type { AgentEvent } from './types.js';

/**
 * Structured summary of what an agent accomplished during a task.
 * Generated on task completion from the event window + GitHub state.
 */
export interface CompletionDigest {
  /** 2-5 human-readable bullet points summarising the work done. */
  bullets: string[];
  /** Unique file basenames that were written or edited. */
  filesChanged: string[];
  /** Brief test result summary, if detected. */
  testSummary?: string;
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
  opts?: { prUrls?: string[] },
): CompletionDigest {
  const filesChanged = extractFilesChanged(events);
  const testSummary = extractTestSummary(events);
  const commits = countGitCommits(events);
  const bullets: string[] = [];

  if (filesChanged.length > 0) {
    const shown = filesChanged.slice(0, 3).join(', ');
    const extra = filesChanged.length > 3 ? ` +${filesChanged.length - 3} more` : '';
    bullets.push(`Changed ${filesChanged.length} file${filesChanged.length !== 1 ? 's' : ''}: ${shown}${extra}`);
  }

  if (opts?.prUrls && opts.prUrls.length > 0) {
    bullets.push(`Created PR${opts.prUrls.length > 1 ? 's' : ''}: ${opts.prUrls.join(', ')}`);
  }

  if (commits > 0) {
    bullets.push(`Made ${commits} commit${commits !== 1 ? 's' : ''}`);
  }

  if (testSummary) {
    bullets.push(testSummary);
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

  return {
    bullets: bullets.slice(0, 5),
    filesChanged,
    testSummary,
  };
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

function findLastStop(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ((event.type === 'stop' || event.type === 'stop_failure') && event.lastMessage) {
      return event.lastMessage;
    }
  }
  return undefined;
}
