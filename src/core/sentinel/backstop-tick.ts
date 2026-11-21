/**
 * Backstop tick and the unresponsive check (RFC §2.1).
 *
 * The lead's own timer is the primary keep-alive. This duty types a tick only when the lead
 * has shown no sign of life (an assistant entry or a screen change) for 25 minutes, and asks
 * the operator when 15 more minutes pass without one. It never closes the lead itself.
 * The bounded reap exemption is P1 and is not decided here.
 */
import {
  MINUTE_MS,
  hhmm,
  isKnown,
  latestKnown,
  minutes,
  type AskOption,
  type DutyResult,
  type SentinelFacts,
  type SentinelState,
} from './types.js';

export const BACKSTOP_SILENCE_MS = 25 * MINUTE_MS;
export const UNRESPONSIVE_AFTER_TICK_MS = 15 * MINUTE_MS;

export const BACKSTOP_TICK_LINE =
  '[kookr sentinel] no turn for 25 min. Run your tick now, and re-create it (CronCreate) if CronList shows none.';

export function backstopTick(facts: SentinelFacts, state: SentinelState, nowMs: number): DutyResult {
  const { lead } = facts;
  const done = (decision: string, reason: string, effects: DutyResult['decision']['effects'] = [], next = state): DutyResult => ({
    decision: { duty: 'backstop', decision, reason, effects },
    state: next,
  });

  if (!lead.live) return done('not-live', 'the lead is terminal; crash recovery decides');

  const signOfLife = latestKnown(facts.transcript.lastAssistantAtMs, lead.lastScreenChangeAtMs);
  // Nothing known: count from the sentinel's start, never from "just now" (R3).
  const anchor = isKnown(signOfLife) ? signOfLife : state.startedAtMs;
  const anchorNote = isKnown(signOfLife) ? `last sign of life ${hhmm(anchor)}` : 'sign of life unknown, counting from the sentinel start';
  const lastTick = state.backstop.lastTickAtMs;

  if (lastTick !== undefined && lastTick > anchor) {
    const sinceTick = nowMs - lastTick;
    if (sinceTick < UNRESPONSIVE_AFTER_TICK_MS) {
      return done('awaiting-response', `backstop tick sent ${minutes(sinceTick)} min ago; ${anchorNote}`);
    }
    const silentMin = minutes(nowMs - anchor);
    const options: AskOption[] = [{ id: 'close-reopen', label: 'Close it and reopen' }];
    let processNote = '';
    if (!isKnown(lead.descendants)) {
      processNote = ' Its live processes are unknown: Close it and reopen kills any it started.';
    } else if (lead.descendants.length > 0) {
      const p = lead.descendants[0];
      const more = lead.descendants.length > 1 ? ` and ${lead.descendants.length - 1} more` : '';
      processNote = ` The lead is quiet but ${p.command} (pid ${p.pid}) has been running for ${minutes(nowMs - p.startedAtMs)} min${more}. Close it and reopen kills it.`;
      options.push({ id: 'keep-waiting', label: 'Keep waiting' });
    }
    options.push({ id: 'leave-it', label: 'Leave it (no reopen)' });
    return done('unresponsive', `no sign of life for ${silentMin} min, ${minutes(sinceTick)} min after the backstop tick; ${anchorNote}`, [{
      kind: 'ask',
      trigger: 'unresponsive',
      question: `Lead ${lead.name} unresponsive for ${silentMin} min (last sign of life ${hhmm(anchor)}).${processNote}`,
      options,
      allowFreeText: true,
      dedupKey: `unresponsive:${lead.taskId}:${anchor}`,
    }]);
  }

  const silence = nowMs - anchor;
  if (silence < BACKSTOP_SILENCE_MS) return done('alive', `${anchorNote}, ${minutes(silence)} min ago`);

  return done(
    'tick-due',
    `no sign of life for ${minutes(silence)} min; ${anchorNote}`,
    [{ kind: 'type-line', trigger: 'backstop-tick', text: BACKSTOP_TICK_LINE }],
    { ...state, backstop: { ...state.backstop, lastTickAtMs: nowMs } },
  );
}
