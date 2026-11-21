/**
 * Planned compaction (RFC §2.4): request a handoff at about 300k tokens when the operator is
 * quiet, send `/compact` only after an assistant `HANDOFF READY` dated after the request with
 * both handoff files newer than it (R2), and confirm by a later `compact_boundary`.
 */
import {
  HOUR_MS,
  MINUTE_MS,
  hhmm,
  isKnown,
  minutes,
  type DutyResult,
  type SentinelEffect,
  type SentinelFacts,
  type SentinelState,
  type TranscriptMarkerKind,
} from './types.js';

export const COMPACTION_THRESHOLD_TOKENS = 300_000;
export const COMPACTION_ESCALATE_TOKENS = 850_000;
export const OPERATOR_QUIET_MS = 20 * MINUTE_MS;
export const HANDOFF_READY_TIMEOUT_MS = HOUR_MS;
export const COMPACT_CONFIRM_TIMEOUT_MS = 15 * MINUTE_MS;
export const HANDOFF_LATER_DEFER_MS = HOUR_MS;
export const ESCALATE_NO_SEND_MS = 2 * HOUR_MS;

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

export function compactionRequestLine(contextTokens: number, dir: string): string {
  return `[kookr sentinel] context ${k(contextTokens)}. When nothing needs you for the next 5 min, write ${dir}/handoff.md ` +
    'and fleet-state.json, checking each entry against gh, ps and the run folders, then answer with a line ' +
    'containing only HANDOFF READY. If now is a bad moment, answer HANDOFF LATER.';
}

export function compactCommand(dir: string): string {
  return `/compact The authoritative state is ${dir}/handoff.md and fleet-state.json. Keep standing rules and pending decisions verbatim.`;
}

function latestMarkerAfter(facts: SentinelFacts, kind: TranscriptMarkerKind, afterMs: number): number | undefined {
  if (!isKnown(facts.transcript.markers)) return undefined;
  let best: number | undefined;
  for (const m of facts.transcript.markers) {
    if (m.kind === kind && m.atMs > afterMs && (best === undefined || m.atMs > best)) best = m.atMs;
  }
  return best;
}

export function compaction(facts: SentinelFacts, state: SentinelState, nowMs: number): DutyResult {
  const c = state.compaction;
  const lead = facts.lead;
  const result = (decision: string, reason: string, effects: SentinelEffect[] = [], next = state): DutyResult => ({
    decision: { duty: 'compaction', decision, reason, effects },
    state: next,
  });
  const withCompaction = (patch: Partial<SentinelState['compaction']>): SentinelState => ({ ...state, compaction: { ...c, ...patch } });
  const failure = (decision: string, reason: string, at: number): DutyResult => {
    const failures = c.failures + 1;
    const next = withCompaction({ requestedAtMs: undefined, sentAtMs: undefined, failures });
    const effects: SentinelEffect[] = failures >= 2
      ? [{ kind: 'alert', trigger: 'compaction-failed', severity: 'warning', summary: `Planned compaction of lead ${lead.name} failed ${failures} times in a row (last: ${decision}).`, dedupKey: `compaction-failed:${lead.taskId}:${at}` }]
      : [];
    return result(decision, reason, effects, next);
  };

  if (!lead.live) return result('not-live', 'the lead is terminal');

  // Step 3: confirm.
  if (c.sentAtMs !== undefined) {
    const sentAt = c.sentAtMs;
    const boundaries = facts.transcript.compactBoundariesAtMs;
    if (isKnown(boundaries) && boundaries.some((b) => b > sentAt)) {
      return result('confirmed', `compact_boundary after the /compact sent at ${hhmm(sentAt)}`, [], withCompaction({
        requestedAtMs: undefined, sentAtMs: undefined, lastSentAtMs: sentAt, over850kSinceMs: undefined, failures: 0,
      }));
    }
    if (nowMs - sentAt >= COMPACT_CONFIRM_TIMEOUT_MS) {
      return failure('confirm-timeout', `no compact_boundary within 15 min of the /compact sent at ${hhmm(sentAt)}${isKnown(boundaries) ? '' : ' (boundaries unknown)'}`, sentAt);
    }
    return result('awaiting-boundary', `/compact sent at ${hhmm(sentAt)}, waiting for compact_boundary`);
  }

  // Step 2: send.
  if (c.requestedAtMs !== undefined) {
    const req = c.requestedAtMs;
    const ready = latestMarkerAfter(facts, 'HANDOFF READY', req);
    const later = latestMarkerAfter(facts, 'HANDOFF LATER', req);
    if (ready !== undefined && (later === undefined || ready >= later)) {
      const h = facts.handoff;
      const fresh = (m: typeof h.handoffMtimeMs): boolean => isKnown(m) && m !== null && m > req;
      if (fresh(h.handoffMtimeMs) && fresh(h.fleetStateMtimeMs)) {
        return result('compact-sent', `HANDOFF READY at ${hhmm(ready)} and both handoff files are newer than the request`, [
          { kind: 'type-line', trigger: 'compact', text: compactCommand(state.handoffDir) },
        ], withCompaction({ sentAtMs: nowMs }));
      }
      if (nowMs - req < HANDOFF_READY_TIMEOUT_MS) {
        return result('ready-files-stale', `HANDOFF READY at ${hhmm(ready)}, but handoff.md or fleet-state.json is missing, unknown or older than the request`);
      }
    } else if (later !== undefined) {
      return result('handoff-later', `HANDOFF LATER at ${hhmm(later)}; asking again at ${hhmm(later + HANDOFF_LATER_DEFER_MS)}`, [],
        withCompaction({ requestedAtMs: undefined, deferredUntilMs: later + HANDOFF_LATER_DEFER_MS }));
    }
    if (nowMs - req >= HANDOFF_READY_TIMEOUT_MS) {
      return failure('ready-timeout', `no usable HANDOFF READY within 1 h of the request at ${hhmm(req)}`, req);
    }
    return result('awaiting-handoff', `handoff requested at ${hhmm(req)}`);
  }

  // Step 1: request.
  const ctx = facts.transcript.contextTokens;
  if (!isKnown(ctx)) return result('context-unknown', 'context size unknown; no request');
  if (ctx < COMPACTION_THRESHOLD_TOKENS) {
    return result('below-threshold', `context ${k(ctx)} < ${k(COMPACTION_THRESHOLD_TOKENS)}`, [],
      c.over850kSinceMs !== undefined ? withCompaction({ over850kSinceMs: undefined }) : state);
  }

  let next = state;
  const effects: SentinelEffect[] = [];
  let escalation = '';
  if (ctx >= COMPACTION_ESCALATE_TOKENS) {
    const since = c.over850kSinceMs ?? nowMs;
    if (c.over850kSinceMs === undefined) next = withCompaction({ over850kSinceMs: since });
    const lastSendRef = Math.max(c.lastSentAtMs ?? -Infinity, state.startedAtMs);
    if (nowMs - lastSendRef >= ESCALATE_NO_SEND_MS) {
      escalation = `; ${k(ctx)} with nothing sent for ${minutes(nowMs - lastSendRef)} min, asking the operator`;
      effects.push({
        kind: 'ask',
        trigger: 'compact-now',
        question: `Lead ${lead.name} is at ${k(ctx)} tokens and has not been compacted for ${minutes(nowMs - lastSendRef)} min. Compact now?`,
        options: [{ id: 'compact-now', label: 'Compact now' }, { id: 'wait-1h', label: 'Wait 1 h' }],
        allowFreeText: false,
        dedupKey: `compact-now:${lead.taskId}:${since}`,
      });
    }
  }

  if (c.deferredUntilMs !== undefined && nowMs < c.deferredUntilMs) {
    return result('deferred', `context ${k(ctx)}; HANDOFF LATER defers the request until ${hhmm(c.deferredUntilMs)}${escalation}`, effects, next);
  }
  const op = facts.operator.lastOperatorInputAtMs;
  if (!isKnown(op)) {
    return result('blocked-operator-unknown', `context ${k(ctx)}; compaction blocked: operator activity unknown${escalation}`, effects, next);
  }
  if (op !== null && nowMs - op < OPERATOR_QUIET_MS) {
    return result('blocked-operator-active', `context ${k(ctx)}; operator active ${minutes(nowMs - op)} min ago${escalation}`, effects, next);
  }
  effects.unshift({ kind: 'type-line', trigger: 'handoff-request', text: compactionRequestLine(ctx, state.handoffDir) });
  return result('handoff-requested', `context ${k(ctx)} ≥ ${k(COMPACTION_THRESHOLD_TOKENS)} and the operator is quiet${escalation}`, effects, {
    ...next,
    compaction: { ...next.compaction, requestedAtMs: nowMs, deferredUntilMs: undefined },
  });
}
