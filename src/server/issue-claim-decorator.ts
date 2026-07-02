import type { AgentEvent } from '../shared/contracts/agent-events.js';
import {
  compactToolSummary,
  pasteBurstLabel,
  summarizeActivity,
  type ActivityItem,
} from '../core/activity-summary.js';
import type { ClaimOwnerRecord } from '../core/issue-claim-types.js';

/**
 * Live fields layered onto the registry's bare `ClaimOwnerRecord` (RFC
 * rfc-issue-ownership-lock R22): `doing`/`lastActivityAt` for the refusal
 * block (R15) and the read surface (R23), `ageMs` for both.
 */
export interface DecoratedClaim extends ClaimOwnerRecord {
  doing?: string;
  lastActivityAt?: string;
  ageMs: number;
}

export interface ClaimDecoratorDeps {
  getAgentEvents: (sessionId: string) => AgentEvent[] | undefined;
  now?: () => Date;
}

const MAX_DOING_LENGTH = 120;

/**
 * The single place `doing`/`lastActivityAt`/`ageMs` are computed (R22),
 * shared by the HTTP list (`GET /api/issue-claims`) and the launch-time
 * refusal body. Synchronous only — `summarizeActivity` over already-captured
 * `Monitor` events — never an LLM/speech-summary call, and never reaches into
 * `Monitor`/`TerminalBackend` itself (that stays server-side, injected via
 * `getAgentEvents`).
 *
 * `AgentEvent` carries no per-event timestamp (see
 * `src/shared/contracts/agent-events.ts`), so `lastActivityAt` is stamped at
 * decoration time when there is a most-recent activity line to report, not
 * parsed out of the event stream itself.
 */
export function decorateClaim(record: ClaimOwnerRecord, deps: ClaimDecoratorDeps): DecoratedClaim {
  const nowFn = deps.now ?? (() => new Date());
  const nowDate = nowFn();
  const ageMs = computeAgeMs(record.claimedAt, nowDate);

  if (!record.sessionId) return { ...record, ageMs };

  const events = deps.getAgentEvents(record.sessionId);
  if (!events || events.length === 0) return { ...record, ageMs };

  const doing = summarizeMostRecentActivity(events);
  if (!doing) return { ...record, ageMs };

  return { ...record, ageMs, doing, lastActivityAt: nowDate.toISOString() };
}

function computeAgeMs(claimedAt: string, now: Date): number {
  const claimedMs = Date.parse(claimedAt);
  if (Number.isNaN(claimedMs)) return 0;
  const age = now.getTime() - claimedMs;
  return age > 0 ? age : 0;
}

function summarizeMostRecentActivity(events: AgentEvent[]): string | undefined {
  let items: ActivityItem[];
  try {
    items = summarizeActivity(events);
  } catch {
    return undefined;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const line = describeActivityItem(items[i]);
    if (line) return truncate(line, MAX_DOING_LENGTH);
  }
  return undefined;
}

function describeActivityItem(item: ActivityItem): string | undefined {
  switch (item.type) {
    case 'user_message':
      return item.text ? `user: ${item.text}` : undefined;
    case 'user_paste_burst':
      return `user: [${pasteBurstLabel(item)}]`;
    case 'agent_message':
      return item.text ? `agent: ${item.text}` : undefined;
    case 'tool_group': {
      const summary = compactToolSummary(item);
      return summary ? `activity: ${summary}` : 'activity: tool activity';
    }
    case 'system_notice':
      return item.text || undefined;
    case 'user_input_delivery':
      // summarizeActivity() never emits this variant (only buildActivityItems()
      // does, when fed userInputDeliveries, which the decorator doesn't have).
      return undefined;
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
