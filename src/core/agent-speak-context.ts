import type { AgentState } from '../shared/contracts/agent-state.js';
import type { ActivityItem, ToolGroup } from '../shared/contracts/activity-summary.js';
import {
  compactToolSummary,
  summarizeActivity,
} from '../shared/contracts/activity-summary.js';
import type { AgentSpeakContext } from '../shared/contracts/speech.js';

const DESCRIPTION_MAX_CHARS = 200;
const MESSAGE_MAX_CHARS = 200;
const ANOMALY_EXPLANATION_MAX_CHARS = 250;
const RECENT_TOOL_GROUPS = 3;

const DELIMITER_REGEX = /<{3,}\s*(END|TASK_NAME|DESCRIPTION|RECENT_ACTIVITY|RECENT_MESSAGES|ANOMALY_EXPLANATION|CWD|AGENT_TYPE)\s*>{3,}/i;
const DELIMITER_REPLACEMENT = '(content removed: contains delimiter sequence)';

export type StripDelimitersLogger = (sectionName: string, agentId: string | undefined) => void;

const defaultLogger: StripDelimitersLogger = (sectionName, agentId) => {
  console.warn(
    `[agent-speak] delimiter sequence detected; section "${sectionName}" replaced (agentId=${agentId ?? 'unknown'})`,
  );
};

/**
 * Trim {@link text} so its length does not exceed {@link max}, preferring the
 * last whitespace boundary at-or-before that index. Falls back to a hard cut
 * when there is no whitespace to use. Empty / undefined inputs collapse to an
 * empty string.
 */
export function truncateAtWord(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastWs = slice.search(/\s\S*$/);
  if (lastWs > 0) return slice.slice(0, lastWs).trimEnd();
  return slice.trimEnd();
}

/**
 * Reject sections that contain a delimiter sequence so an injected prompt
 * cannot escape its `<<<SECTION>>>` envelope. NFKC-normalizes the input first
 * so Unicode lookalikes (e.g. fullwidth `＜＜＜END＞＞＞`) are caught by the
 * ASCII regex. Returns either the original text or the placeholder; on match
 * emits a warn log via {@link logger} so an operator can audit the rejection.
 *
 * `sectionName` and `agentId` are surfaced only in the log line; they do not
 * influence the regex.
 */
// Format / control / combining marks must be stripped before the regex test
// because NFKC alone does not collapse zero-width characters (U+200B ZWSP,
// U+200C ZWNJ, U+FEFF). An attacker can otherwise insert ZWSPs between the
// keyword letters (e.g. `<<<E​ND>>>`) and evade the keyword match.
const INVISIBLE_CHARS_REGEX = /[\p{Cf}\p{Mn}]/gu;

export function stripDelimiters(
  text: string,
  sectionName: string,
  agentId: string | undefined,
  logger: StripDelimitersLogger = defaultLogger,
): string {
  if (!text) return '';
  const normalized = text.normalize('NFKC').replace(INVISIBLE_CHARS_REGEX, '');
  if (DELIMITER_REGEX.test(normalized)) {
    logger(sectionName, agentId);
    return DELIMITER_REPLACEMENT;
  }
  return text;
}

function pickRecentToolGroups(items: ActivityItem[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (let i = items.length - 1; i >= 0 && groups.length < RECENT_TOOL_GROUPS; i -= 1) {
    const item = items[i];
    if (item.type === 'tool_group') groups.push(item);
  }
  return groups.reverse();
}

function renderToolGroup(group: ToolGroup, includeDetail: boolean): string {
  const summary = compactToolSummary(group);
  if (!includeDetail) return summary;
  const lastEntry = group.entries[group.entries.length - 1];
  if (!lastEntry?.detail) return summary;
  return `${summary} (${lastEntry.detail})`;
}

function buildRecentActivity(items: ActivityItem[]): string {
  const groups = pickRecentToolGroups(items);
  if (groups.length === 0) return '(no recent activity)';
  const lastItemIsGroup = items[items.length - 1]?.type === 'tool_group';
  return groups
    .map((group, idx) => {
      const isLast = idx === groups.length - 1;
      return renderToolGroup(group, isLast && lastItemIsGroup);
    })
    .join('; ');
}

function findLastByType(items: ActivityItem[], type: 'agent_message' | 'user_message'): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === type) return item.text;
  }
  return null;
}

function buildRecentMessages(items: ActivityItem[]): string {
  const lastAgent = findLastByType(items, 'agent_message');
  const lastUser = findLastByType(items, 'user_message');
  const parts: string[] = [];
  if (lastAgent) parts.push(`Agent: ${truncateAtWord(lastAgent, MESSAGE_MAX_CHARS)}`);
  if (lastUser) parts.push(`User: ${truncateAtWord(lastUser, MESSAGE_MAX_CHARS)}`);
  if (parts.length === 0) return '(no recent messages)';
  return parts.join(' | ');
}

export interface BuildAgentSpeakContextOptions {
  /**
   * Override the warn log emitter used when {@link stripDelimiters} rejects a
   * section. Tests pass a vi.fn() to assert rejection without polluting stderr.
   */
  logger?: StripDelimitersLogger;
}

/**
 * Assemble the structured context the LLM summarizer receives. Pure: takes the
 * raw `AgentState` (NOT a frontend-projected snapshot, which truncates
 * `toolInput`) and returns an {@link AgentSpeakContext}. Every string passes
 * through {@link stripDelimiters} so an injected `<<<END>>>` cannot escape the
 * prompt envelope.
 */
export function buildAgentSpeakContext(
  agent: AgentState,
  options: BuildAgentSpeakContextOptions = {},
): AgentSpeakContext {
  const logger = options.logger ?? defaultLogger;
  const agentId = agent.agentId;
  const items = summarizeActivity(agent.events);

  const taskName = stripDelimiters((agent.taskName ?? '').trim() || 'Untitled task', 'taskName', agentId, logger);
  const agentType = stripDelimiters(String(agent.agentType ?? 'unknown'), 'agentType', agentId, logger);
  const cwd = stripDelimiters(agent.cwd ?? '', 'cwd', agentId, logger);

  const description = (agent.description ?? '').trim();
  const descriptionExcerpt = stripDelimiters(
    truncateAtWord(description, DESCRIPTION_MAX_CHARS),
    'descriptionExcerpt',
    agentId,
    logger,
  );

  const recentActivity = stripDelimiters(buildRecentActivity(items), 'recentActivity', agentId, logger);
  const recentMessages = stripDelimiters(buildRecentMessages(items), 'recentMessages', agentId, logger);

  const context: AgentSpeakContext = {
    taskName,
    agentType,
    cwd,
    descriptionExcerpt,
    recentActivity,
    recentMessages,
  };

  if (agent.anomaly) {
    context.anomaly = {
      type: stripDelimiters(agent.anomaly.type, 'anomaly.type', agentId, logger),
      severity: stripDelimiters(agent.anomaly.severity, 'anomaly.severity', agentId, logger),
      explanation: stripDelimiters(
        truncateAtWord(agent.anomaly.explanation, ANOMALY_EXPLANATION_MAX_CHARS),
        'anomaly.explanation',
        agentId,
        logger,
      ),
    };
  }

  return context;
}
