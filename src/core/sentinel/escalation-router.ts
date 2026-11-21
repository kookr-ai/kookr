/**
 * The escalation router (RFC §3): the only path from the sentinel to the lead and to the
 * operator. It takes every duty's decision for one tick and returns the routed actions plus one
 * guard-log line per decision (R5).
 *
 * - **Dedup (R6).** An effect with a dedup key is routed once; the key is kept for 7 days, so it
 *   outlives an ask's 2-hour timeout. A refused ask gives its key back with {@link releaseDedupKey} (R10).
 * - **Dry run.** An effect of a duty not in `liveDuties` is routed with `dryRun: true`: it is
 *   logged as "would have done" and never carried out. In P0, `liveDuties` is always empty.
 * - **Format.** Asks and alerts start `[sentinel · <lead> · <trigger>]`; in dry run they carry
 *   `DRY RUN: no action will be taken`. After a `compact_boundary` newer than the last guard
 *   line, the next typed line starts "compacted: re-read <dir>/handoff.md first."
 */
import {
  HOUR_MS,
  isKnown,
  type DutyDecision,
  type SentinelDuty,
  type SentinelEffect,
  type SentinelFacts,
  type SentinelState,
} from './types.js';

export const DEDUP_RETENTION_MS = 7 * 24 * HOUR_MS;
export const ASK_TIMEOUT_MS = 2 * HOUR_MS;
export const DRY_RUN_TAG = 'DRY RUN: no action will be taken';
export const GUARD_LOG_SCHEMA_VERSION = 1;

/** `AskService.createSystem` accepts `[a-z0-9-]{1,40}`: the first 8 characters of the id. */
export function sentinelAskSystemId(sentinelId: string): string {
  return `sentinel-${sentinelId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}`;
}

export type RouteChannel = 'lead-line' | 'system-ask' | 'alert' | 'reopen' | 'end-sentinel';

export interface RoutedAction {
  duty: SentinelDuty;
  channel: RouteChannel;
  dryRun: boolean;
  /** The text to type, ask or alert, fully formatted. */
  text: string;
  effect: SentinelEffect;
}

export interface GuardLogLine {
  schemaVersion: typeof GUARD_LOG_SCHEMA_VERSION;
  at: string;
  sentinelId: string;
  leadTaskId: string;
  duty: SentinelDuty;
  decision: string;
  reason: string;
  dryRun: boolean;
  actions: Array<{ channel: RouteChannel; text: string; dedupKey?: string; suppressed?: 'dedup' }>;
}

export interface RouteResult {
  actions: RoutedAction[];
  log: GuardLogLine[];
  state: SentinelState;
}

const CHANNEL: Record<SentinelEffect['kind'], RouteChannel> = {
  'type-line': 'lead-line',
  ask: 'system-ask',
  alert: 'alert',
  reopen: 'reopen',
  'end-sentinel': 'end-sentinel',
};

function dedupKeyOf(effect: SentinelEffect): string | undefined {
  return 'dedupKey' in effect ? effect.dedupKey : undefined;
}

export function releaseDedupKey(state: SentinelState, key: string): SentinelState {
  if (!(key in state.dedup)) return state;
  const dedup = { ...state.dedup };
  delete dedup[key];
  return { ...state, dedup };
}

export function routeDecisions(input: {
  decisions: DutyDecision[];
  facts: SentinelFacts;
  state: SentinelState;
  nowMs: number;
}): RouteResult {
  const { decisions, facts, nowMs } = input;
  const live = new Set(input.state.liveDuties);
  const dedup: Record<string, number> = {};
  for (const [key, until] of Object.entries(input.state.dedup)) if (until > nowMs) dedup[key] = until;

  const boundaries = facts.transcript.compactBoundariesAtMs;
  const latestBoundary = isKnown(boundaries) && boundaries.length > 0 ? Math.max(...boundaries) : undefined;
  // A boundary from before the sentinel started predates any handoff it asked for.
  let resumePending = latestBoundary !== undefined
    && latestBoundary > Math.max(input.state.lastGuardLineAtMs ?? -Infinity, input.state.startedAtMs);
  let typed = false;

  const actions: RoutedAction[] = [];
  const log: GuardLogLine[] = [];
  const header = (trigger: string): string => `[sentinel · ${facts.lead.name} · ${trigger}]`;

  for (const d of decisions) {
    const dryRun = !live.has(d.duty);
    const entry: GuardLogLine = {
      schemaVersion: GUARD_LOG_SCHEMA_VERSION,
      at: new Date(nowMs).toISOString(),
      sentinelId: input.state.sentinelId,
      leadTaskId: input.state.leadTaskId,
      duty: d.duty,
      decision: d.decision,
      reason: d.reason,
      dryRun,
      actions: [],
    };
    for (const effect of d.effects) {
      const channel = CHANNEL[effect.kind];
      const key = dedupKeyOf(effect);
      let text: string;
      switch (effect.kind) {
        case 'type-line':
          text = effect.text;
          // A `/compact` must stay a slash command, so the resume prefix waits for the next line.
          if (resumePending && !text.startsWith('/')) {
            text = text.startsWith('[kookr sentinel] ')
              ? `[kookr sentinel] compacted: re-read ${input.state.handoffDir}/handoff.md first. ${text.slice('[kookr sentinel] '.length)}`
              : `compacted: re-read ${input.state.handoffDir}/handoff.md first. ${text}`;
          }
          break;
        case 'ask':
          text = `${header(effect.trigger)} ${effect.question}${dryRun ? ` ${DRY_RUN_TAG}` : ''}`;
          break;
        case 'alert':
          text = `${header(effect.trigger)} ${effect.summary}${dryRun ? ` ${DRY_RUN_TAG}` : ''}`;
          break;
        case 'reopen':
          text = `reopen lead ${facts.lead.taskId} (${effect.reason}) · key ${effect.idempotencyKey}`;
          break;
        case 'end-sentinel':
          text = `end sentinel: ${effect.reason}`;
          break;
      }
      if (key !== undefined && key in dedup) {
        entry.actions.push({ channel, text, dedupKey: key, suppressed: 'dedup' });
        continue;
      }
      if (key !== undefined) dedup[key] = nowMs + DEDUP_RETENTION_MS;
      if (effect.kind === 'type-line') {
        if (!effect.text.startsWith('/')) resumePending = false;
        typed = true;
      }
      entry.actions.push({ channel, text, ...(key !== undefined ? { dedupKey: key } : {}) });
      actions.push({ duty: d.duty, channel, dryRun, text, effect });
    }
    log.push(entry);
  }

  const state: SentinelState = {
    ...input.state,
    dedup,
    ...(typed ? { lastGuardLineAtMs: nowMs } : {}),
  };
  return { actions, log, state };
}
