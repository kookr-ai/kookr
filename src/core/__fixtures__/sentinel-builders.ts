/** Test builders for the sentinel's pure duties (issue #4239). */
import { MINUTE_MS, initialSentinelState, type SentinelFacts, type SentinelState } from '../sentinel/types.js';

export const T0 = Date.parse('2026-11-21T10:00:00.000Z');
export const at = (min: number): number => T0 + min * MINUTE_MS;

export function sentinelState(over: Partial<SentinelState> = {}): SentinelState {
  return {
    ...initialSentinelState({
      sentinelId: 'abcdef12-3456-7890-abcd-ef1234567890',
      leadTaskId: 'lead-1',
      startedAtMs: T0,
      expiresAtMs: at(3 * 24 * 60),
      handoffDir: '/runs/lead',
    }),
    ...over,
  };
}

/** A healthy live lead: just spoke, quiet operator, small context, no workers. */
export function sentinelFacts(over: {
  lead?: Partial<SentinelFacts['lead']>;
  transcript?: Partial<SentinelFacts['transcript']>;
  children?: SentinelFacts['children'];
  operator?: Partial<SentinelFacts['operator']>;
  handoff?: Partial<SentinelFacts['handoff']>;
} = {}): SentinelFacts {
  return {
    lead: {
      taskId: 'lead-1',
      name: 'LFM3 lead',
      live: true,
      lastScreenChangeAtMs: T0,
      descendants: [],
      completionReadyAtMs: null,
      ...over.lead,
    },
    transcript: {
      contextTokens: 100_000,
      lastTurnEndAtMs: T0,
      lastAssistantAtMs: T0,
      compactBoundariesAtMs: [],
      markers: [],
      ...over.transcript,
    },
    children: over.children ?? [],
    operator: { lastOperatorInputAtMs: null, ...over.operator },
    handoff: { handoffMtimeMs: null, fleetStateMtimeMs: null, declaredJobs: [], ...over.handoff },
  };
}
