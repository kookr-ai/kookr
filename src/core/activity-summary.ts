import type { AgentActivityMeta, AgentEvent } from './types.js';

// ── Activity item types ──────────────────────────────────────────────

export interface UserMessage {
  type: 'user_message';
  text: string;
  timestamp?: string;
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

export type ActivityItem = UserMessage | AgentMessage | ToolGroup | SystemNotice;

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

// ── Summarization ────────────────────────────────────────────────────

/**
 * Convert a stream of AgentEvents into a conversation-first activity summary.
 * Consecutive tool events are collapsed into a single ToolGroup.
 * User/agent messages and system notices get their own items.
 */
export function summarizeActivity(events: AgentEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  let pendingTools: Array<{ toolName: string; toolInput?: unknown; toolUseId?: string; isError: boolean }> = [];

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
    switch (event.type) {
      case 'user_prompt': {
        flushTools();
        items.push({ type: 'user_message', text: event.prompt });
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

  // Flush any remaining tool events
  flushTools();

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
