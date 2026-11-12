/**
 * Counters for Lucy's operator conversation, kept apart from the helper-model
 * diagnostics on purpose: the helper model writes short summaries and names in the
 * background, while an operator turn is a question the operator is waiting on, costs
 * more and uses another model. Mixing the two would hide a problem in either.
 *
 * In memory only, since the server started. The interaction log
 * (`lucy-interactions.jsonl`) holds the lasting record of each turn.
 */

import type { LucyOperatorDiagnosticsSnapshot } from '../../shared/contracts/diagnostic.js';
import type { LucyTurnDoneEvent, LucyTurnEnd } from '../../shared/contracts/lucy-turn.js';

interface Counters {
  turns: number;
  byEnd: Partial<Record<LucyTurnEnd, number>>;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turnsWithCost: number;
  totalMs: number;
  maxMs: number;
  firstTextTotalMs: number;
  turnsWithText: number;
}

function empty(): Counters {
  return { turns: 0, byEnd: {}, modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, turnsWithCost: 0, totalMs: 0, maxMs: 0, firstTextTotalMs: 0, turnsWithText: 0 };
}

let counters = empty();

/** Count one finished turn. */
export function recordLucyOperatorTurn(done: LucyTurnDoneEvent): void {
  counters.turns += 1;
  counters.byEnd[done.end] = (counters.byEnd[done.end] ?? 0) + 1;
  counters.modelCalls += done.steps;
  counters.inputTokens += done.inputTokens;
  counters.outputTokens += done.outputTokens;
  if (done.costUsd !== null) {
    counters.costUsd += done.costUsd;
    counters.turnsWithCost += 1;
  }
  counters.totalMs += done.totalMs;
  counters.maxMs = Math.max(counters.maxMs, done.totalMs);
  if (done.firstTextMs !== null) {
    counters.firstTextTotalMs += done.firstTextMs;
    counters.turnsWithText += 1;
  }
}

export function getLucyOperatorDiagnosticsSnapshot(now: number = Date.now()): LucyOperatorDiagnosticsSnapshot {
  return {
    schemaVersion: 'lucy-operator-diagnostics.v1',
    generatedAt: now,
    turns: counters.turns,
    byEnd: { ...counters.byEnd },
    modelCalls: counters.modelCalls,
    inputTokens: counters.inputTokens,
    outputTokens: counters.outputTokens,
    // Rounded to a millionth of a dollar: a turn costs a fraction of a cent.
    costUsd: Math.round(counters.costUsd * 1e6) / 1e6,
    turnsWithCost: counters.turnsWithCost,
    averageTurnMs: counters.turns > 0 ? Math.round(counters.totalMs / counters.turns) : 0,
    maxTurnMs: Math.round(counters.maxMs),
    averageFirstTextMs: counters.turnsWithText > 0 ? Math.round(counters.firstTextTotalMs / counters.turnsWithText) : null,
  };
}

export function resetLucyOperatorDiagnosticsForTest(): void {
  counters = empty();
}
