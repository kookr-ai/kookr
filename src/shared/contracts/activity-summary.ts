import type { AgentEvent } from './agent-events.js';
import type { AgentActivityMeta } from './hook-events.js';
import type { UserInputDeliverySnapshot } from './user-input-delivery.js';
import { unwrapProviderUserPrompt } from './user-prompt-text.js';

// ── Activity item types ──────────────────────────────────────────────

export interface UserMessage {
  type: 'user_message';
  text: string;
  timestamp?: string;
}

export interface UserInputDeliveryItem {
  type: 'user_input_delivery';
  delivery: UserInputDeliverySnapshot;
}

export interface AgentMessage {
  type: 'agent_message';
  text: string;
  timestamp?: string;
}

export interface ToolGroupEntry {
  toolName: string;
  category: ToolCategory;
  count: number;
  errors: number;
  /** Short label for display, e.g. "src/foo.ts" */
  detail?: string;
  /** Most recent `toolUseId` contributing to this entry, within this specific
   *  tool group. Set only for Edit/Write/NotebookEdit tools that emit it.
   *  Used by the activity panel diff click — scoping to a group prevents a
   *  click on an earlier group from resolving to a later group's edit of the
   *  same file. */
  lastEditId?: string;
  /** Full `file_path` from the most recent contributing `tool_use`, for
   *  Edit/Write entries. Distinct from `detail` (a display label) — this
   *  is the authoritative path used to fetch the diff. */
  lastEditFilePath?: string;
}

export interface ToolGroup {
  type: 'tool_group';
  entries: ToolGroupEntry[];
  totalCalls: number;
  totalErrors: number;
}

export interface SystemNotice {
  type: 'system_notice';
  subType: 'session_start' | 'permission_request' | 'notification' | 'session_end';
  text: string;
  timestamp?: string;
}

/** Best-effort classification of the content in a coalesced paste burst,
 *  used only to phrase the summary label. */
export type PasteContentKind = 'JSON' | 'log' | 'text';

/**
 * A run of adjacent single-line `user_prompt` events coalesced into one item.
 * An accidental multiline terminal paste submits each line as its own prompt;
 * rather than rendering dozens of "You" messages, the summarizer collapses the
 * run into a single inspectable item. The raw `lines` are retained verbatim so
 * the activity panel can offer an expandable detail view and diagnostic/export
 * paths keep full fidelity. See issue #357.
 */
export interface UserPasteBurst {
  type: 'user_paste_burst';
  /** Number of coalesced single-line prompts. */
  lineCount: number;
  /** The raw pasted lines, in submission order. */
  lines: string[];
  /** Content classification used to phrase the summary label. */
  contentKind: PasteContentKind;
  timestamp?: string;
}

export type ActivityItem =
  | UserMessage
  | UserInputDeliveryItem
  | AgentMessage
  | ToolGroup
  | SystemNotice
  | UserPasteBurst;

// ── Tool categorization ──────────────────────────────────────────────

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const GIT_TOOLS_PATTERN = /^(git\s|gh\s)/;

export type ToolCategory = 'read' | 'edit' | 'bash' | 'git' | 'agent' | 'search' | 'other';

export function categorizeTool(toolName: string, toolInput?: unknown): ToolCategory {
  if (READ_TOOLS.has(toolName)) return 'read';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (toolName === 'Agent') return 'agent';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'search';
  if (toolName === 'Bash') {
    // 'command' must be in DESCRIPTOR_KEYS in src/server/event-projection.ts
    const cmd = typeof toolInput === 'object' && toolInput !== null && 'command' in toolInput
      ? String((toolInput as { command: string }).command)
      : '';
    if (GIT_TOOLS_PATTERN.test(cmd)) return 'git';
    return 'bash';
  }
  return 'other';
}

/**
 * Human-readable label for a tool call.
 * Any toolInput key read here must be in DESCRIPTOR_KEYS in
 * src/server/event-projection.ts so it survives transport-size truncation.
 */
export function toolLabel(toolName: string, toolInput?: unknown): string {
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
    // 'file_path' must be in DESCRIPTOR_KEYS in src/server/event-projection.ts
    const path = typeof toolInput === 'object' && toolInput !== null && 'file_path' in toolInput
      ? String((toolInput as { file_path: string }).file_path)
      : undefined;
    if (path) {
      const base = path.split('/').pop() ?? path;
      return `${toolName} ${base}`;
    }
  }
  if (toolName === 'Bash') {
    // 'command' must be in DESCRIPTOR_KEYS in src/server/event-projection.ts
    const cmd = typeof toolInput === 'object' && toolInput !== null && 'command' in toolInput
      ? String((toolInput as { command: string }).command)
      : '';
    const short = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
    return short || 'Bash';
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    // 'pattern' must be in DESCRIPTOR_KEYS in src/server/event-projection.ts
    const pattern = typeof toolInput === 'object' && toolInput !== null && 'pattern' in toolInput
      ? String((toolInput as { pattern: string }).pattern)
      : '';
    return pattern ? `${toolName} "${pattern}"` : toolName;
  }
  return toolName;
}

// ── Paste-burst coalescing (issue #357) ──────────────────────────────

/**
 * Minimum number of adjacent single-line `user_prompt` events before the
 * summarizer treats the run as an accidental multiline paste rather than a
 * sequence of deliberate separate messages. Three is low enough to catch
 * small pastes yet high enough that ordinary back-to-back messages — which
 * almost always have agent activity between them — are never merged.
 */
export const PASTE_BURST_MIN_LINES = 3;

/** A prompt is "line-shaped" when it carries no interior newline — exactly
 *  what one physical line of a multiline paste looks like. A deliberate
 *  multiline message is not line-shaped and never joins a burst. */
function isSingleLinePrompt(prompt: string): boolean {
  return !prompt.trim().includes('\n');
}

const JSON_LINE_RE = /^\s*[[{]|^\s*"[^"]*"\s*:/;
const LOG_LINE_RE =
  /\b(?:ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b|^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Classify the content of a paste burst so the panel can label it
 * ("Pasted 43 lines of JSON content"). Best-effort and presentational only —
 * never load-bearing.
 */
export function classifyPasteContent(lines: string[]): PasteContentKind {
  const joined = lines.join('\n').trim();
  if (joined) {
    try {
      const parsed: unknown = JSON.parse(joined);
      if (parsed !== null && typeof parsed === 'object') return 'JSON';
    } catch {
      // Not one JSON blob — fall through to per-line heuristics.
    }
  }
  const meaningful = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (meaningful.length === 0) return 'text';
  let jsonish = 0;
  let logish = 0;
  for (const line of meaningful) {
    if (JSON_LINE_RE.test(line)) jsonish += 1;
    if (LOG_LINE_RE.test(line)) logish += 1;
  }
  if (jsonish / meaningful.length >= 0.6) return 'JSON';
  if (logish / meaningful.length >= 0.4) return 'log';
  return 'text';
}

/** One-line summary label for a coalesced paste burst, e.g.
 *  "Pasted 43 lines of JSON content". */
export function pasteBurstLabel(burst: UserPasteBurst): string {
  const lineWord = burst.lineCount === 1 ? 'line' : 'lines';
  const kind = burst.contentKind === 'text' ? '' : ` of ${burst.contentKind} content`;
  return `Pasted ${burst.lineCount} ${lineWord}${kind}`;
}

// ── Summarization ────────────────────────────────────────────────────

/**
 * Convert a stream of AgentEvents into a conversation-first activity summary.
 * Consecutive tool events are collapsed into a single ToolGroup.
 * User/agent messages and system notices get their own items.
 *
 * Adjacent single-line `user_prompt` events are buffered and, when a run is
 * long enough to be an accidental multiline paste, collapsed into one
 * {@link UserPasteBurst} item. See issue #357.
 */
export function summarizeActivity(events: AgentEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  let pendingTools: Array<{ toolName: string; toolInput?: unknown; toolUseId?: string; isError: boolean }> = [];
  // Adjacent single-line user prompts buffer here: a run long enough to be an
  // accidental multiline paste collapses into one UserPasteBurst. Any other
  // event flushes the buffer (see the loop guard below). See issue #357.
  let pendingUserPrompts: string[] = [];

  /** Emit buffered user prompts — one UserPasteBurst when the run is long
   *  enough to be a paste, otherwise one user_message per prompt so genuinely
   *  separate messages stay distinct. */
  function flushUserPrompts() {
    if (pendingUserPrompts.length === 0) return;
    if (pendingUserPrompts.length >= PASTE_BURST_MIN_LINES) {
      items.push({
        type: 'user_paste_burst',
        lineCount: pendingUserPrompts.length,
        lines: [...pendingUserPrompts],
        contentKind: classifyPasteContent(pendingUserPrompts),
      });
    } else {
      for (const text of pendingUserPrompts) {
        items.push({ type: 'user_message', text });
      }
    }
    pendingUserPrompts = [];
  }

  function flushTools() {
    if (pendingTools.length === 0) return;

    // Group by toolLabel to merge repeated identical calls.
    // Category is computed here while toolInput is still available.
    // For Edit/Write/NotebookEdit entries we also record the most recent
    // toolUseId + full file_path contributed to this group's merged entry —
    // scoping that to a single group prevents a click on an earlier group
    // from silently resolving to a later group's same-file edit.
    type GroupedEntry = {
      toolName: string;
      category: ToolCategory;
      count: number;
      errors: number;
      detail?: string;
      lastEditId?: string;
      lastEditFilePath?: string;
    };
    const grouped = new Map<string, GroupedEntry>();
    for (const t of pendingTools) {
      const label = toolLabel(t.toolName, t.toolInput);
      const isEditTool = t.toolName === 'Edit' || t.toolName === 'Write' || t.toolName === 'NotebookEdit';
      // Pull the full file_path off toolInput for Edit/Write entries — this
      // is the authoritative identifier the diff endpoint needs. Guarded by
      // DESCRIPTOR_KEYS (see event-projection.ts).
      const filePath =
        isEditTool && typeof t.toolInput === 'object' && t.toolInput !== null && 'file_path' in t.toolInput
          ? String((t.toolInput as { file_path: string }).file_path)
          : undefined;

      const existing = grouped.get(label);
      if (existing) {
        existing.count++;
        if (t.isError) existing.errors++;
        // Later events win — last-write semantics for the click target.
        if (isEditTool && t.toolUseId) {
          existing.lastEditId = t.toolUseId;
          if (filePath) existing.lastEditFilePath = filePath;
        }
      } else {
        grouped.set(label, {
          toolName: t.toolName,
          category: categorizeTool(t.toolName, t.toolInput),
          count: 1,
          errors: t.isError ? 1 : 0,
          detail: label !== t.toolName ? label : undefined,
          lastEditId: isEditTool ? t.toolUseId : undefined,
          lastEditFilePath: isEditTool ? filePath : undefined,
        });
      }
    }

    const entries: ToolGroupEntry[] = Array.from(grouped.values()).map(g => ({
      toolName: g.toolName,
      category: g.category,
      count: g.count,
      errors: g.errors,
      detail: g.detail,
      ...(g.lastEditId ? { lastEditId: g.lastEditId } : {}),
      ...(g.lastEditFilePath ? { lastEditFilePath: g.lastEditFilePath } : {}),
    }));

    items.push({
      type: 'tool_group',
      entries,
      totalCalls: pendingTools.length,
      totalErrors: pendingTools.filter(t => t.isError).length,
    });

    pendingTools = [];
  }

  for (const event of events) {
    // Any event other than a user prompt ends a paste run, so flush the
    // buffer before handling it — this also catches a bare tool_result or
    // subagent event that a capped monitor window may surface without its
    // preceding tool_use. The user_prompt branch decides for itself: a
    // multiline prompt flushes, a single-line one buffers.
    if (event.type !== 'user_prompt') {
      flushUserPrompts();
    }
    switch (event.type) {
      case 'user_prompt': {
        flushTools();
        // Defense for events already in memory that still carry provider
        // envelopes (Grok <user_query>, trailing system-reminders). Parsers
        // unwrap at ingest; this keeps the activity panel clean either way.
        const prompt = unwrapProviderUserPrompt(event.prompt);
        if (prompt === null) break;
        if (isSingleLinePrompt(prompt)) {
          // Defer — a long enough run of these is a paste burst.
          pendingUserPrompts.push(prompt);
        } else {
          // A multiline prompt is a deliberate message; it also ends any
          // run of single-line prompts that preceded it.
          flushUserPrompts();
          items.push({ type: 'user_message', text: prompt });
        }
        break;
      }

      case 'input_received': {
        // Synthetic marker — only emit if no recent user_prompt already captured it
        // Skip: the user_prompt event is the authoritative source
        break;
      }

      case 'stop':
      case 'stop_failure': {
        flushTools();
        if (event.lastMessage) {
          items.push({ type: 'agent_message', text: event.lastMessage });
        }
        break;
      }

      case 'tool_use': {
        pendingTools.push({
          toolName: event.toolName,
          toolInput: event.toolInput,
          toolUseId: event.toolUseId,
          isError: false,
        });
        break;
      }

      case 'tool_result': {
        // tool_result follows tool_use — don't double-count, but mark success
        // The tool_use already captured the call; tool_result is informational
        break;
      }

      case 'tool_error': {
        // Mark the most recent matching tool_use as errored, or add standalone
        let matchIdx = -1;
        for (let i = pendingTools.length - 1; i >= 0; i--) {
          if (pendingTools[i].toolName === event.toolName && !pendingTools[i].isError) {
            matchIdx = i;
            break;
          }
        }
        if (matchIdx >= 0) {
          pendingTools[matchIdx].isError = true;
        } else {
          pendingTools.push({
            toolName: event.toolName,
            toolInput: event.toolInput,
            toolUseId: event.toolUseId,
            isError: true,
          });
        }
        break;
      }

      case 'session_start': {
        flushTools();
        items.push({
          type: 'system_notice',
          subType: 'session_start',
          text: 'Session started',
        });
        break;
      }

      case 'session_end': {
        flushTools();
        items.push({
          type: 'system_notice',
          subType: 'session_end',
          text: `Session ended: ${event.reason}`,
        });
        break;
      }

      case 'permission_request': {
        flushTools();
        const tool = event.toolName || 'unknown tool';
        items.push({
          type: 'system_notice',
          subType: 'permission_request',
          text: `Permission requested for ${tool}`,
        });
        break;
      }

      case 'notification': {
        flushTools();
        items.push({
          type: 'system_notice',
          subType: 'notification',
          text: event.message,
        });
        break;
      }

      case 'subagent_start':
      case 'subagent_stop':
      case 'error':
        // These are low-value for the activity view — skip
        break;
    }
  }

  // Flush any remaining buffered prompts / tool events.
  flushUserPrompts();
  flushTools();

  return items;
}

export function buildActivityItems(input: {
  providerEvents: AgentEvent[];
  userInputDeliveries?: UserInputDeliverySnapshot[];
}): ActivityItem[] {
  const deliveries = [...(input.userInputDeliveries ?? [])].sort((a, b) => a.deliverySeq - b.deliverySeq);
  if (deliveries.length === 0) return summarizeActivity(input.providerEvents);

  const deliveryByHookId = new Map<string, UserInputDeliverySnapshot>();
  for (const delivery of deliveries) {
    if (delivery.submittedHookLineId) deliveryByHookId.set(delivery.submittedHookLineId, delivery);
  }

  const items: ActivityItem[] = [];
  const emittedDeliveryIds = new Set<string>();
  let segment: AgentEvent[] = [];

  const flushSegment = () => {
    if (segment.length === 0) return;
    items.push(...summarizeActivity(segment));
    segment = [];
  };

  for (const event of input.providerEvents) {
    const delivery = event.type === 'user_prompt' && event.hookLineId
      ? deliveryByHookId.get(event.hookLineId)
      : undefined;
    if (delivery) {
      flushSegment();
      items.push({ type: 'user_input_delivery', delivery });
      emittedDeliveryIds.add(delivery.deliveryId);
      continue;
    }
    segment.push(event);
  }
  flushSegment();

  for (const delivery of deliveries) {
    if (emittedDeliveryIds.has(delivery.deliveryId)) continue;
    items.push({ type: 'user_input_delivery', delivery });
  }

  return items;
}

// ── Compact summary line ─────────────────────────────────────────────

/** Generate a one-line summary like "Read 5 files, edited 2, ran tests, 1 failure" */
export function compactToolSummary(group: ToolGroup): string {
  const parts: string[] = [];
  let reads = 0;
  let edits = 0;
  let bashCmds = 0;
  let gitOps = 0;
  let searches = 0;
  let agents = 0;
  let other = 0;

  for (const entry of group.entries) {
    switch (entry.category) {
      case 'read': reads += entry.count; break;
      case 'edit': edits += entry.count; break;
      case 'bash': bashCmds += entry.count; break;
      case 'git': gitOps += entry.count; break;
      case 'search': searches += entry.count; break;
      case 'agent': agents += entry.count; break;
      default: other += entry.count; break;
    }
  }

  if (reads > 0) parts.push(`read ${reads} file${reads > 1 ? 's' : ''}`);
  if (edits > 0) parts.push(`edited ${edits} file${edits > 1 ? 's' : ''}`);
  if (bashCmds > 0) parts.push(`ran ${bashCmds} command${bashCmds > 1 ? 's' : ''}`);
  if (gitOps > 0) parts.push(`${gitOps} git op${gitOps > 1 ? 's' : ''}`);
  if (searches > 0) parts.push(`${searches} search${searches > 1 ? 'es' : ''}`);
  if (agents > 0) parts.push(`${agents} subagent${agents > 1 ? 's' : ''}`);
  if (other > 0) parts.push(`${other} other`);

  if (group.totalErrors > 0) {
    parts.push(`${group.totalErrors} failure${group.totalErrors > 1 ? 's' : ''}`);
  }

  return parts.join(', ');
}

// ── Activity panel disclosure (rfc-activity-log-reliability §4) ──────

/**
 * Disclosure rows the activity panel shows above the conversation when the
 * Kookr-side {@link AgentActivityMeta} indicates that what's on screen is
 * not the full story. Each property is set only when there's something to
 * say — when all three are absent, no banner is rendered.
 */
export interface ActivityDisclosure {
  /** "Showing last N of M events" — set when the monitor window is capped. */
  partialWindow?: { eventsShown: number; totalEventsSeen: number };
  /** "Child agent activity: X events" — child sessions wrote to the same
   *  Kookr hook file. */
  childActivity?: { eventCount: number; foreignCount: number };
  /** "Y hook records malformed/dropped" — invites the operator to open
   *  diagnostics. */
  malformed?: { malformedCount: number; droppedCount: number };
}

export function buildActivityDisclosure(
  eventsShown: number,
  activityMeta?: AgentActivityMeta,
): ActivityDisclosure | null {
  if (!activityMeta) return null;
  const out: ActivityDisclosure = {};

  if (activityMeta.totalEventsSeen > eventsShown) {
    out.partialWindow = {
      eventsShown,
      totalEventsSeen: activityMeta.totalEventsSeen,
    };
  }
  if (activityMeta.childEventCount > 0 || activityMeta.foreignEventCount > 0) {
    out.childActivity = {
      eventCount: activityMeta.childEventCount,
      foreignCount: activityMeta.foreignEventCount,
    };
  }
  if (activityMeta.malformedRecordCount > 0 || activityMeta.droppedRecordCount > 0) {
    out.malformed = {
      malformedCount: activityMeta.malformedRecordCount,
      droppedCount: activityMeta.droppedRecordCount,
    };
  }
  return out.partialWindow || out.childActivity || out.malformed ? out : null;
}
