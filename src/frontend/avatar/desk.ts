/**
 * The words and the small decisions of the desk (Lucy's room, `AvatarDock.tsx`): what a finding is called, the
 * "Next:" line over the Decisions column, the header's summary, and which closed questions and finished tasks
 * count as "today". Pure functions, so the wording is tested without rendering anything.
 */
import type { AgentState } from '../../shared/protocol.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { findingTypeLabel } from '../presentation.js';
import { needsYouActionText, needsYouTimeLeftText, type NeedsYouItem } from '../store/needs-you.js';

/** Closed questions listed under "Decided today", and finished tasks under "Finished today". */
export const DESK_DECIDED_LIMIT = 5;
export const DESK_FINISHED_LIMIT = 8;

/** How a finding reads on its card ("Says it is finished") and in the "Next:" line ("it says it is finished"). */
interface FindingWords {
  kind: string;
  /** What follows "review NAME, " or "look at NAME, " in the "Next:" line. */
  because: string;
  /** The verb phrase before the name: "review" for a finished task, "look at" for the others. */
  verb: 'review' | 'look at';
}

const FINDING_WORDS: Record<string, FindingWords> = {
  permission_blocked: { kind: 'Waiting for permission', because: 'it waits for your permission', verb: 'look at' },
  repeated_error: { kind: 'Repeating an error', because: 'it keeps hitting the same error', verb: 'look at' },
  merge_conflict: { kind: 'Merge conflict', because: 'it has a merge conflict', verb: 'look at' },
  stale_agent: { kind: 'Gone quiet', because: 'it has gone quiet', verb: 'look at' },
  hook_disconnected: { kind: 'Lost contact', because: 'Kookr lost contact with it', verb: 'look at' },
  hook_missing: { kind: 'Not reporting', because: 'it is not reporting to Kookr', verb: 'look at' },
  hook_parse_degraded: { kind: 'Reports unreadable', because: 'Kookr cannot read all its reports', verb: 'look at' },
  backend_unreachable: { kind: 'Backend unreachable', because: 'its backend cannot be reached', verb: 'look at' },
  api_error: { kind: 'API error', because: 'it hit an API error', verb: 'look at' },
  budget_exceeded: { kind: 'Over budget', because: 'it is over budget', verb: 'look at' },
  needs_input: { kind: 'Asks for input', because: 'it asks for your input', verb: 'look at' },
};
const FINISHED_WORDS: FindingWords = { kind: 'Says it is finished', because: 'it says it is finished', verb: 'review' };

/** The finding's kind in words; a kind Kookr has no sentence for falls back to the dashboard's own label. */
export function findingWords(agent: AgentState): FindingWords {
  const type = agent.anomaly?.type;
  if (type === 'needs_input' && agent.turnState === 'completed_turn') return FINISHED_WORDS;
  const known = type ? FINDING_WORDS[type] : undefined;
  if (known) return known;
  const label = findingTypeLabel(agent) || 'Needs a look';
  return { kind: label, because: `it is flagged as ${label.toLowerCase()}`, verb: 'look at' };
}

/** The first non-empty line of a finding's own explanation; empty when the data has none. */
export function findingExplanationLine(agent: AgentState): string {
  const text = agent.anomaly?.explanation;
  if (typeof text !== 'string') return '';
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/**
 * The line over the Decisions column that names the first thing that waits, in words:
 * "Next: answer Earnings Watch UX review, 117 min left", "Next: Billing migration wants your permission to use
 * Bash", "Next: review Package release, it says it is finished". `findings` is looked up by task id.
 */
export function nextDecisionText(item: NeedsYouItem, nowMs: number, findingFor: (item: NeedsYouItem) => AgentState | undefined): string {
  const name = item.taskName ?? 'A task';
  if (item.kind === 'question') {
    return `Next: answer ${name}${item.expiresAt !== undefined ? `, ${needsYouTimeLeftText(item.expiresAt, nowMs)}` : ''}`;
  }
  if (item.kind === 'permission') return `Next: ${name} ${needsYouActionText(item)}`;
  const agent = findingFor(item);
  const words = agent ? findingWords(agent) : FINISHED_WORDS;
  return `Next: ${agent ? words.verb : 'look at'} ${name}${agent ? `, ${words.because}` : ''}`;
}

/** The header's one plain summary, from the same data as the columns: "7 running · 2 need you". */
export function deskSummaryText(running: number, needYou: number): string {
  return [
    `${running} running`,
    needYou > 0 ? `${needYou} ${needYou === 1 ? 'needs' : 'need'} you` : null,
  ].filter(Boolean).join(' · ');
}

/** The Fleet column's title count: "7 running". */
export function fleetTitleCount(running: number): string {
  return `${running} running`;
}

/** Local midnight that starts the day `nowMs` is in. */
export function startOfLocalDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Questions that closed today (not pending), newest first, at most {@link DESK_DECIDED_LIMIT}. */
export function decidedToday(asks: readonly OperatorAskView[], nowMs: number): OperatorAskView[] {
  const since = startOfLocalDay(nowMs);
  return asks
    .filter((ask) => ask.state !== 'pending')
    .map((ask) => ({ ask, closedAt: ask.resolvedAt ?? ask.expiresAt }))
    .filter(({ closedAt }) => closedAt >= since)
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, DESK_DECIDED_LIMIT)
    .map(({ ask }) => ask);
}

/** Tasks that finished today, in the order given (the dashboard's newest-first), at most {@link DESK_FINISHED_LIMIT}. */
export function finishedToday(completed: readonly AgentState[], nowMs: number): AgentState[] {
  const since = startOfLocalDay(nowMs);
  return completed
    .filter((agent) => {
      const finished = agent.finishedAt ? Date.parse(agent.finishedAt) : Number.NaN;
      return Number.isFinite(finished) && finished >= since;
    })
    .slice(0, DESK_FINISHED_LIMIT);
}
