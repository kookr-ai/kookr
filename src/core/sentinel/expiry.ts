/**
 * Expiry (RFC §2.6): ask to renew 1 hour before `--for` ends, and on expiry hand keep-alive
 * back to the lead's own timer. It never tells the lead to signal completion-ready.
 */
import { HOUR_MS, hhmm, minutes, type DutyResult, type SentinelFacts, type SentinelState } from './types.js';

export const RENEW_ASK_BEFORE_MS = HOUR_MS;
export const SENTINEL_ENDED_LINE = '[kookr sentinel] sentinel ended; make sure your own CronCreate tick exists.';

export function expiry(facts: SentinelFacts, state: SentinelState, nowMs: number): DutyResult {
  const at = state.expiresAtMs;
  const result = (decision: string, reason: string, effects: DutyResult['decision']['effects'] = []): DutyResult => ({
    decision: { duty: 'expiry', decision, reason, effects },
    state,
  });
  if (nowMs >= at) {
    return result('expired', `the sentinel expired at ${hhmm(at)}`, [
      ...(facts.lead.live ? [{ kind: 'type-line' as const, trigger: 'expired', text: SENTINEL_ENDED_LINE }] : []),
      { kind: 'end-sentinel', trigger: 'expired', reason: 'the sentinel reached its --for limit' },
    ]);
  }
  if (at - nowMs <= RENEW_ASK_BEFORE_MS) {
    return result('renew-asked', `the sentinel expires at ${hhmm(at)}`, [{
      kind: 'ask',
      trigger: 'renew',
      question: `The sentinel on lead ${facts.lead.name} expires at ${hhmm(at)} UTC. Renew it?`,
      options: [{ id: 'renew-3d', label: 'Renew 3 days' }, { id: 'let-expire', label: 'Let it expire' }],
      allowFreeText: false,
      dedupKey: `renew:${facts.lead.taskId}:${at}`,
    }]);
  }
  return result('active', `expires in ${minutes(at - nowMs)} min`);
}
