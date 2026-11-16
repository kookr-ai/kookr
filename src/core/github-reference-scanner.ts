import type { AgentEvent } from './types.js';
import type { GitHubReference } from './github-types.js';
import type { AuthorshipEvidence } from './github-state-store.js';

/**
 * Extract GitHub PR and issue references from agent events using regex patterns.
 * Phase 1: deterministic regex extraction. Phase 2 will add Haiku LLM extraction.
 */

// --- Regex patterns ---

/**
 * PR/issue URL on any Git hosting platform (GitHub, GitLab, etc.)
 * Matches:
 *   https://github.com/owner/repo/pull/42
 *   https://github.com/owner/repo/issues/42
 *   https://gitlab.example.com/owner/repo/-/merge_requests/42
 */
const GIT_HOST_URL_RE = /https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:-\/)?(pull|issues|merge_requests)\/(\d+)/g;

/** Explicit "PR #42" or "pull request #42" or "issue #42" or "issue 42" */
const EXPLICIT_REF_RE = /\b(?:PR|pull request)\s*#?(\d+)/gi;
const EXPLICIT_ISSUE_RE = /\b(?:issue)\s*#?(\d+)/gi;

/**
 * Anchored bare ref: a prompt that *opens* with "#123" (e.g. "#123" alone or
 * "#123: fix login flow") is an explicit, intentional reference. Mid-prose
 * bare "#N" (e.g. "see #4, #7 and #12 for background") is deliberately NOT
 * extracted any more — it over-attributed task↔GitHub edges and inflated the
 * project drawer's "issues/PRs tied to active tasks" counts far beyond the
 * repo's real open counts.
 */
const LEADING_BARE_REF_RE = /^\s*#(\d+)\b/;

/**
 * Action verbs followed by #N — treated as issue references in prompt context.
 * Matches: "fix #18", "resolve #18", "close #18", "implement #18", "work on #18", "address #18"
 */
const ACTION_ISSUE_RE = /\b(?:fix|fixes|resolve|resolves|close|closes|implement|implements|address|addresses|work\s+on|start\s+working\s+on)\s+#(\d+)/gi;

const MUTATING_GH_COMMAND_RE = /\bgh\s+(?:issue\s+(?:create|edit|close|reopen|comment|transfer|pin|unpin|lock|unlock)|pr\s+(?:create|edit|merge|close|reopen|comment|review|ready|lock|unlock))\b/i;
const MUTATING_API_COMMAND_RE = /\b(?:gh\s+api|curl)\b[\s\S]*(?:^|\s)-X\s+(?:POST|PATCH|PUT|DELETE)\b/i;

export interface ExtractedRef {
  type: 'pr' | 'issue';
  owner?: string;
  repo?: string;
  number: number;
  url?: string;
}

/**
 * Extract GitHub references from a block of text.
 * Returns deduplicated references.
 */
export function extractRefsFromText(text: string): ExtractedRef[] {
  const refs: ExtractedRef[] = [];
  const seen = new Set<string>();

  function addRef(ref: ExtractedRef): void {
    const key = `${ref.type}:${ref.owner ?? ''}/${ref.repo ?? ''}#${ref.number}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  }

  // Full PR/issue URLs from any Git hosting platform (most reliable)
  for (const match of text.matchAll(GIT_HOST_URL_RE)) {
    const [url, owner, repo, typeStr, numStr] = match;
    addRef({
      type: typeStr === 'issues' ? 'issue' : 'pr',
      owner,
      repo,
      number: parseInt(numStr, 10),
      url,
    });
  }

  // Explicit "PR #42" references (no owner/repo — needs inference)
  for (const match of text.matchAll(EXPLICIT_REF_RE)) {
    addRef({
      type: 'pr',
      number: parseInt(match[1], 10),
    });
  }

  // Explicit "issue #42" references
  for (const match of text.matchAll(EXPLICIT_ISSUE_RE)) {
    addRef({
      type: 'issue',
      number: parseInt(match[1], 10),
    });
  }

  return refs;
}

/**
 * Extract GitHub references from a task prompt.
 * Unlike extractRefsFromText, this also:
 * - Matches action verb + #N patterns as issue refs (e.g. "fix #18", "resolve #42")
 * - Treats a *leading* bare #N (prompt is "#123" or starts with "#123: …") as an issue ref
 *
 * Bare #N mid-prose (no action verb, no "issue"/"PR" adjacency) does NOT
 * create a reference: prompts routinely cite many issue numbers as context,
 * and attributing all of them to the task destroyed trust in the per-project
 * "tied to active tasks" counts.
 */
export function extractRefsFromPrompt(text: string): ExtractedRef[] {
  // Start with standard text extraction
  const refs = extractRefsFromText(text);
  const seen = new Set<string>();

  function addRef(ref: ExtractedRef): void {
    const key = `${ref.type}:${ref.owner ?? ''}/${ref.repo ?? ''}#${ref.number}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  }

  // Index existing refs for dedup
  for (const ref of refs) {
    const key = `${ref.type}:${ref.owner ?? ''}/${ref.repo ?? ''}#${ref.number}`;
    seen.add(key);
  }

  // Action verb + #N → issue refs (e.g. "fix #18", "resolve #42")
  for (const match of text.matchAll(ACTION_ISSUE_RE)) {
    addRef({
      type: 'issue',
      number: parseInt(match[1], 10),
    });
  }

  // Leading bare #N → issue ref. A prompt that opens with the number is an
  // explicit reference; bare #N elsewhere in prose is intentionally ignored.
  const leading = text.match(LEADING_BARE_REF_RE);
  if (leading) {
    addRef({
      type: 'issue',
      number: parseInt(leading[1], 10),
    });
  }

  return refs;
}

/**
 * Extract GitHub references from agent events.
 *
 * Scans all tool_result events and stop events for PR/issue URLs.
 * No command filtering — any tool output containing a recognizable
 * PR/issue URL triggers extraction.
 */
export function extractRefsFromEvents(
  events: AgentEvent[],
  defaultOwner?: string,
  defaultRepo?: string,
): ExtractedRef[] {
  const allRefs: ExtractedRef[] = [];
  const seen = new Set<string>();
  const toolUsesById = new Map<string, Extract<AgentEvent, { type: 'tool_use' }>>();
  /** Last shell tool_use only — non-shell tools must not poison command pairing. */
  let lastShellToolUse: Extract<AgentEvent, { type: 'tool_use' }> | null = null;

  function addRefs(refs: ExtractedRef[], options: { includeIssues: boolean }): void {
    for (const ref of refs) {
      if (ref.type === 'issue' && !options.includeIssues) continue;

      const owner = ref.owner ?? defaultOwner;
      const repo = ref.repo ?? defaultRepo;
      const key = `${ref.type}:${owner ?? ''}/${repo ?? ''}#${ref.number}`;

      if (seen.has(key)) continue;
      seen.add(key);

      allRefs.push({
        ...ref,
        owner: owner ?? ref.owner,
        repo: repo ?? ref.repo,
      });
    }
  }

  for (const event of events) {
    if (event.type === 'tool_use') {
      if (isShellToolName(event.toolName)) {
        lastShellToolUse = event;
      }
      if (event.toolUseId) {
        toolUsesById.set(event.toolUseId, event);
      }
    } else if (event.type === 'tool_result') {
      const response = event.toolResponse;
      if (typeof response !== 'string' && typeof response !== 'object') continue;
      if (!shouldScanToolResult(event, toolUsesById, lastShellToolUse)) continue;

      const text = typeof response === 'string' ? response : JSON.stringify(response);
      addRefs(extractRefsFromText(text), { includeIssues: true });
    } else if (event.type === 'stop' || event.type === 'stop_failure') {
      addRefs(extractRefsFromText(event.lastMessage), { includeIssues: false });
    }
  }

  return allRefs;
}

/**
 * Shell tools whose results may contain incidental PR/issue URLs from read-only
 * commands (`gh pr list`, `git log`, …). Only mutating gh/API commands from
 * these tools are scanned. Claude uses `Bash`; Grok Build uses
 * `run_terminal_command` (see GROK_TOOL_ALIASES). Non-shell tools (`read_file`,
 * `grep`, …) are never scanned — their bodies routinely mention historical PR
 * URLs that must not attach to the task.
 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'run_terminal_command']);

function isShellToolName(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && SHELL_TOOL_NAMES.has(toolName);
}

function shouldScanToolResult(
  event: Extract<AgentEvent, { type: 'tool_result' }>,
  toolUsesById: ReadonlyMap<string, Extract<AgentEvent, { type: 'tool_use' }>>,
  lastShellToolUse: Extract<AgentEvent, { type: 'tool_use' }> | null,
): boolean {
  // Non-shell tools: never auto-attach refs from file reads / greps / etc.
  if (!isShellToolName(event.toolName)) {
    return false;
  }

  const command = pairedShellCommand(event, toolUsesById, lastShellToolUse);

  if (!command) {
    return false;
  }

  return MUTATING_GH_COMMAND_RE.test(command) || MUTATING_API_COMMAND_RE.test(command);
}

/** The shell command a tool_result answers: its paired tool_use, else the last shell tool_use. */
function pairedShellCommand(
  event: Extract<AgentEvent, { type: 'tool_result' }>,
  toolUsesById: ReadonlyMap<string, Extract<AgentEvent, { type: 'tool_use' }>>,
  lastShellToolUse: Extract<AgentEvent, { type: 'tool_use' }> | null,
): string | null {
  const pairedUse = event.toolUseId ? toolUsesById.get(event.toolUseId) : undefined;
  const shellUse =
    pairedUse && isShellToolName(pairedUse.toolName) ? pairedUse : lastShellToolUse;
  return extractCommand(shellUse?.toolInput);
}

const GIT_PUSH_COMMAND_RE = /\bgit\b(?:\s+-C\s+\S+)?\s+push\b/;
const GH_PR_CREATE_COMMAND_RE = /\bgh\s+pr\s+create\b/;
/**
 * A ref line `git push` prints for an update that went through:
 * ` * [new branch]   feat -> feat`, `   1a2b3c4..5d6e7f8  feat -> feat`, or a
 * forced ` + 1a2b3c4...5d6e7f8 feat -> feat (forced update)`. Rejected
 * (` ! [rejected]`), deleted and tag lines do not match.
 */
const PUSHED_REF_LINE_RE = /^\s*(?:\*\s+\[new branch\]|\+?\s*[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/gm;
/** The `To <remote>` line of `git push` output, naming the repository pushed to. */
const PUSH_REMOTE_LINE_RE = /^To\s+(\S+)/m;
const GITHUB_REMOTE_RE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const PULL_URL_RE = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;

/**
 * The text of a tool response: the string itself, or the string fields of a
 * response object (Claude Code's Bash result is `{ stdout, stderr, ... }`;
 * `git push` reports on stderr).
 */
function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  return Object.values(response as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
}

/**
 * Authorship evidence in a task's own shell activity (issue #3678): the
 * branches a successful `git push` reported updating, and the PRs a
 * `gh pr create` printed. Only shell tool results paired with those commands
 * count, so reading a PR (`gh pr view`, `git log`) never claims it. The
 * repository comes from the push's `To <remote>` line or the PR URL, falling
 * back to the task's own repository for a push whose remote is not on GitHub's
 * URL form; with neither, the branch is skipped.
 */
export function extractAuthorshipFromEvents(
  events: AgentEvent[],
  defaultOwner?: string,
  defaultRepo?: string,
): AuthorshipEvidence {
  const pushedBranches: Array<{ owner: string; repo: string; branch: string }> = [];
  const createdPrs: Array<{ owner: string; repo: string; number: number }> = [];
  const toolUsesById = new Map<string, Extract<AgentEvent, { type: 'tool_use' }>>();
  let lastShellToolUse: Extract<AgentEvent, { type: 'tool_use' }> | null = null;

  for (const event of events) {
    if (event.type === 'tool_use') {
      if (isShellToolName(event.toolName)) lastShellToolUse = event;
      if (event.toolUseId) toolUsesById.set(event.toolUseId, event);
      continue;
    }
    if (event.type !== 'tool_result' || !isShellToolName(event.toolName)) continue;
    const command = pairedShellCommand(event, toolUsesById, lastShellToolUse);
    if (!command) continue;
    const text = responseText(event.toolResponse);
    if (text === '') continue;

    if (GIT_PUSH_COMMAND_RE.test(command)) {
      const remote = PUSH_REMOTE_LINE_RE.exec(text)?.[1];
      const parsed = remote ? GITHUB_REMOTE_RE.exec(remote) : null;
      const owner = parsed?.[1] ?? defaultOwner;
      const repo = parsed?.[2] ?? defaultRepo;
      if (owner && repo) {
        for (const m of text.matchAll(PUSHED_REF_LINE_RE)) {
          const branch = m[1].replace(/^refs\/heads\//, '');
          if (branch !== '') pushedBranches.push({ owner, repo, branch });
        }
      }
    }
    if (GH_PR_CREATE_COMMAND_RE.test(command)) {
      for (const m of text.matchAll(PULL_URL_RE)) {
        createdPrs.push({ owner: m[1], repo: m[2], number: Number.parseInt(m[3], 10) });
      }
    }
  }

  return { pushedBranches, createdPrs };
}

function extractCommand(toolInput: unknown): string | null {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return null;

  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : null;
}

/**
 * Infer owner/repo from a git remote URL.
 * Handles SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git).
 */
export function parseGitRemoteUrl(remoteUrl: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

/**
 * Convert extracted refs to full GitHubReference objects.
 */
export function toGitHubReferences(
  extracted: ExtractedRef[],
  agentId: string,
  taskId: string,
): GitHubReference[] {
  return extracted
    .filter((ref): ref is ExtractedRef & { owner: string; repo: string } =>
      ref.owner != null && ref.repo != null,
    )
    .map((ref) => ({
      type: ref.type,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      url: ref.url ?? `https://github.com/${ref.owner}/${ref.repo}/${ref.type === 'pr' ? 'pull' : 'issues'}/${ref.number}`,
      detectedAt: new Date(),
      detectedFrom: agentId,
      taskId,
    }));
}
