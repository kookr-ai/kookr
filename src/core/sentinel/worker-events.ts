/**
 * Worker events (RFC §2.3): tell the lead within 2 minutes that one of its workers ended.
 *
 * Ends are held for one minute so events close together share one line, and a reclaim adds
 * the warning that its non-detached processes died with it. Two reclaims within 4 hours are a
 * reclaim loop, which raises an operational alert (P1 behaviour; the operator ask is P3).
 */
import {
  HOUR_MS,
  MINUTE_MS,
  hhmm,
  isKnown,
  type ChildFact,
  type DutyResult,
  type SentinelEffect,
  type SentinelFacts,
  type SentinelState,
} from './types.js';
import { RECLAIM_SOURCES } from './crash-recovery.js';

export const WORKER_EVENT_BATCH_MS = MINUTE_MS;
export const RECLAIM_LOOP_WINDOW_MS = 4 * HOUR_MS;
const REPORTED_KEEP = 200;

export const RECLAIM_WARNING =
  'Kookr killed every non-detached process it started. If it owned a run, that run is dead. ' +
  'Relaunch it detached, and tell the new worker to poll in bounded loops instead of waiting silently.';

type EndedChild = ChildFact & { ended: NonNullable<ChildFact['ended']> };

const endKey = (c: EndedChild): string => `${c.taskId}:${c.ended.atMs}`;
const isReclaim = (c: EndedChild): boolean => isKnown(c.ended.source) && RECLAIM_SOURCES.has(c.ended.source);

export function workerEvents(facts: SentinelFacts, state: SentinelState, nowMs: number): DutyResult {
  const result = (decision: string, reason: string, effects: SentinelEffect[] = [], next = state): DutyResult => ({
    decision: { duty: 'worker-events', decision, reason, effects },
    state: next,
  });
  // Held, not dropped: a reopened lead still hears about the ends that happened while it was gone.
  if (!facts.lead.live) return result('not-live', 'the lead is terminal; worker ends are held until it is live again');
  if (!isKnown(facts.children)) return result('children-unknown', "the lead's workers could not be read");

  const reported = new Set(state.workerEvents.reported);
  const ended = facts.children.filter((c): c is EndedChild => c.ended !== undefined && !reported.has(`${c.taskId}:${c.ended.atMs}`));
  // Ends from before the sentinel started are history, not news.
  const old = ended.filter((c) => c.ended.atMs < state.startedAtMs);
  const fresh = ended.filter((c) => c.ended.atMs >= state.startedAtMs).sort((a, b) => a.ended.atMs - b.ended.atMs);

  const markReported = (cs: EndedChild[]): string[] => [...state.workerEvents.reported, ...cs.map(endKey)].slice(-REPORTED_KEEP);

  if (fresh.length === 0) {
    const next = old.length > 0 ? { ...state, workerEvents: { ...state.workerEvents, reported: markReported(old) } } : state;
    return result('none', `no new worker end (${facts.children.length} workers)`, [], next);
  }
  if (nowMs - fresh[0].ended.atMs < WORKER_EVENT_BATCH_MS) {
    return result('batching', `${fresh.length} worker end(s) held to batch with any that follow`);
  }

  const parts = fresh.map((c) => `worker ${c.name} ended at ${hhmm(c.ended.atMs)} (${isKnown(c.ended.source) ? c.ended.source : c.ended.status})`);
  const anyReclaim = fresh.some(isReclaim);
  const text = `[kookr sentinel] ${parts.join('; ')}. ${fresh.length > 1 ? 'Check their jobs.' : 'Check its job.'}${anyReclaim ? ` ${RECLAIM_WARNING}` : ''}`;
  const effects: SentinelEffect[] = [{ kind: 'type-line', trigger: 'worker-events', text }];

  const reclaims = [...state.workerEvents.reclaimsAtMs, ...fresh.filter(isReclaim).map((c) => c.ended.atMs)]
    .filter((t) => nowMs - t <= RECLAIM_LOOP_WINDOW_MS)
    .sort((a, b) => a - b);
  let decision = 'report';
  if (anyReclaim && reclaims.length >= 2) {
    decision = 'report-reclaim-loop';
    effects.push({
      kind: 'alert',
      trigger: 'reclaim-loop',
      severity: 'warning',
      summary: `${reclaims.length} workers of lead ${facts.lead.name} were reclaimed within 4 h (${reclaims.map(hhmm).join(', ')}). Treat it as a stall: their runs likely died.`,
      dedupKey: `reclaim-loop:${facts.lead.taskId}:${reclaims[0]}`,
    });
  }

  return result(decision, `${fresh.length} worker end(s) to report${anyReclaim ? ', including a reclaim' : ''}`, effects, {
    ...state,
    workerEvents: { reported: markReported([...old, ...fresh]), reclaimsAtMs: reclaims },
  });
}
