/**
 * Progress (RFC §2.5): notice when the fleet stops moving.
 *
 * The fingerprint uses Kookr-native facts only: workers that ended with a delivered result.
 * Worker churn (starts, reclaims, crashes) and the lead's own messages never count as
 * progress, and an unknown fact counts as "no change observed" (R3). PR head changes join the
 * fingerprint once per-lead PR attribution exists (RFC O7).
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
} from './types.js';

export const STALL_NOTICE_MS = 90 * MINUTE_MS;
export const STALL_ASK_AFTER_NOTICE_MS = 30 * MINUTE_MS;
export const OPERATOR_RECENT_MS = 30 * MINUTE_MS;
export const DECLARED_JOB_GRACE_MS = 30 * MINUTE_MS;
export const WAITING_REMINDER_MS = 4 * HOUR_MS;

export function progressFingerprint(facts: SentinelFacts): string | undefined {
  if (!isKnown(facts.children)) return undefined;
  return facts.children
    .filter((c) => c.ended?.delivered === true)
    .map((c) => `${c.taskId}@${c.ended!.atMs}`)
    .sort()
    .join(',');
}

export function progress(facts: SentinelFacts, state: SentinelState, nowMs: number): DutyResult {
  const lead = facts.lead;
  const p = state.progress;
  const result = (decision: string, reason: string, effects: SentinelEffect[] = [], next = state): DutyResult => ({
    decision: { duty: 'progress', decision, reason, effects },
    state: next,
  });
  if (!lead.live) return result('not-live', 'the lead is terminal');

  const fp = progressFingerprint(facts);
  let next = state;
  const changedAt = p.changedAtMs ?? state.startedAtMs;
  if (fp !== undefined && p.fingerprint === undefined) {
    next = { ...state, progress: { ...p, fingerprint: fp, changedAtMs: changedAt } };
  } else if (fp !== undefined && fp !== p.fingerprint) {
    return result('moved', 'a worker delivered a result', [], { ...state, progress: { fingerprint: fp, changedAtMs: nowMs } });
  }
  const fpNote = fp === undefined ? ' (workers unknown: no change observed)' : '';
  const stale = nowMs - changedAt;

  if (isKnown(facts.handoff.declaredJobs)) {
    const job = facts.handoff.declaredJobs.find((j) => j.alive && (j.expectedEndAtMs === undefined || nowMs <= j.expectedEndAtMs + DECLARED_JOB_GRACE_MS));
    if (job) return result('explained-declared-job', `unchanged for ${minutes(stale)} min, explained by declared job pid ${job.pid}${fpNote}`, [], next);
  }

  if (isKnown(facts.transcript.markers)) {
    const waiting = facts.transcript.markers.filter((m) => m.kind === 'WAITING ON OPERATOR' && m.atMs > changedAt).pop();
    if (waiting) {
      const bucket = Math.floor((nowMs - waiting.atMs) / WAITING_REMINDER_MS);
      return result('explained-waiting-on-operator', `the lead said WAITING ON OPERATOR at ${hhmm(waiting.atMs)}`, [{
        kind: 'alert',
        trigger: 'waiting-on-operator',
        severity: 'info',
        summary: `Lead ${lead.name} is waiting on you${waiting.detail ? `: ${waiting.detail}` : ''} (since ${hhmm(waiting.atMs)}).`,
        dedupKey: `waiting-on-operator:${lead.taskId}:${waiting.atMs}:${bucket}`,
      }], next);
    }
  }

  if (stale < STALL_NOTICE_MS) return result('unchanged', `no delivered result for ${minutes(stale)} min${fpNote}`, [], next);

  if (p.noticeAtMs === undefined || p.noticeAtMs < changedAt) {
    return result('stall-notice', `no delivered result for ${minutes(stale)} min${fpNote}`, [{
      kind: 'type-line',
      trigger: 'stall-notice',
      text: `[kookr sentinel] no progress for ${minutes(stale)} min: no worker delivered a result since ${hhmm(changedAt)}. ` +
        'Say what you are waiting on (a line WAITING ON OPERATOR: <what>), or act.',
      dedupKey: `stall-notice:${lead.taskId}:${changedAt}`,
    }], { ...next, progress: { ...next.progress, noticeAtMs: nowMs } });
  }

  const sinceNotice = nowMs - p.noticeAtMs;
  if (sinceNotice < STALL_ASK_AFTER_NOTICE_MS) {
    return result('stall-noticed', `lead told at ${hhmm(p.noticeAtMs)}; waiting ${minutes(STALL_ASK_AFTER_NOTICE_MS - sinceNotice)} more min before asking`, [], next);
  }
  const op = facts.operator.lastOperatorInputAtMs;
  if (isKnown(op) && op !== null && nowMs - op < OPERATOR_RECENT_MS) {
    return result('ask-held-operator-active', `stalled ${minutes(stale)} min, but the operator wrote ${minutes(nowMs - op)} min ago`, [], next);
  }
  return result('stall-ask', `no delivered result for ${minutes(stale)} min, unexplained 30 min after the notice${isKnown(op) ? '' : ' (operator activity unknown)'}`, [{
    kind: 'ask',
    trigger: 'no-progress',
    question: `Lead ${lead.name}: no progress for ${minutes(stale)} min (no worker delivered since ${hhmm(changedAt)}); the lead was told at ${hhmm(p.noticeAtMs)}.`,
    options: [
      { id: 'send-facts', label: 'Send me the facts' },
      { id: 'nudge', label: 'Nudge the lead' },
      { id: 'snooze-3h', label: 'Snooze 3 h' },
    ],
    allowFreeText: true,
    dedupKey: `no-progress:${lead.taskId}:${changedAt}`,
  }], next);
}
