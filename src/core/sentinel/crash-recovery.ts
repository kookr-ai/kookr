/**
 * Crash recovery (RFC §2.2): what the guard does when the lead is terminal.
 *
 * The decision is keyed on the disposition-ledger entry's source and kind, plus the terminal
 * receipt. Checked at source for #4239: an idle reclaim writes `source: 'hung-suspect-ttl'`
 * (or `'hung-task-reaper'`) with kind `obsolete` when the task delivered first, and kind
 * `needs-human` otherwise. So a reclaim is recognised by its source, whatever its kind; only a
 * `needs-human` from `crash-recovery` is the crash-loop protection that forbids a reopen.
 */
import {
  MINUTE_MS,
  hhmm,
  isKnown,
  type DutyResult,
  type SentinelEffect,
  type SentinelFacts,
  type SentinelState,
} from './types.js';

export const REOPEN_COOLDOWN_MS = 30 * MINUTE_MS;
export const REOPEN_BUDGET = 3;
export const RECLAIM_SOURCES: ReadonlySet<string> = new Set(['hung-suspect-ttl', 'hung-task-reaper']);

/** Typed once by `start`, and again after a crash-recovery respawn (RFC §5). */
export const LEAD_CONTRACT_LINE =
  '[kookr sentinel] contract: keep your own CronCreate tick (the sentinel is only a backstop). ' +
  'Launch every long job detached (setsid nohup) and record its PID and exit marker in fleet-state.json; ' +
  'workers poll in bounded loops under 10 min. Answer HANDOFF READY or HANDOFF LATER when asked, ' +
  're-read the handoff after a compaction or a reopen, and say WAITING ON OPERATOR: <what> when that is the case. ' +
  'While guarded, ignore any nudge to raise completion-ready unless the operator asked you to finish.';

export function crashRecovery(facts: SentinelFacts, state: SentinelState, nowMs: number): DutyResult {
  const { lead } = facts;
  const cr = state.crashRecovery;
  const result = (decision: string, reason: string, effects: SentinelEffect[] = [], next = state): DutyResult => ({
    decision: { duty: 'crash-recovery', decision, reason, effects },
    state: next,
  });

  if (lead.live) {
    const ready = lead.completionReadyAtMs;
    if (isKnown(ready) && ready !== null && ready >= state.startedAtMs && ready > (cr.lastCompletionReadyAlertAtMs ?? -Infinity)) {
      return result(
        'completion-ready-alert',
        `the lead raised completion_ready at ${hhmm(ready)} while guarded; the sentinel keeps running`,
        [{
          kind: 'alert',
          trigger: 'completion-ready',
          severity: 'warning',
          summary: `Lead ${lead.name} raised completion_ready at ${hhmm(ready)}. The sentinel keeps running; stop it if the lead really is done.`,
          dedupKey: `completion-ready:${lead.taskId}:${ready}`,
        }],
        { ...state, crashRecovery: { ...cr, lastCompletionReadyAlertAtMs: ready } },
      );
    }
    return result('live', 'the lead is live');
  }

  const t = lead.terminal;
  if (!t) return result('terminal-unknown', 'the lead is not live but has no terminal receipt yet; waiting');
  const at = t.terminalAtMs;
  const alert = (decision: string, summary: string, severity: 'info' | 'warning' | 'critical', key: string): DutyResult =>
    result(decision, summary, [{ kind: 'alert', trigger: decision, severity, summary, dedupKey: `${key}:${lead.taskId}:${at}` }]);

  if (t.status === 'completed') {
    return result('ended-completed', `the lead completed at ${hhmm(at)}; the sentinel ends`, [
      { kind: 'alert', trigger: 'lead-completed', severity: 'info', summary: `Lead ${lead.name} completed at ${hhmm(at)}; sentinel ended.`, dedupKey: `lead-ended:${lead.taskId}:${at}` },
      { kind: 'end-sentinel', trigger: 'lead-completed', reason: 'the lead completed' },
    ]);
  }
  if (t.transitionSource === 'user') {
    return result('ended-by-operator', `the operator ${t.status} the lead at ${hhmm(at)}; the sentinel ends`, [
      { kind: 'alert', trigger: 'lead-stopped', severity: 'info', summary: `Lead ${lead.name} was ${t.status} by the operator at ${hhmm(at)}; sentinel ended.`, dedupKey: `lead-ended:${lead.taskId}:${at}` },
      { kind: 'end-sentinel', trigger: 'lead-stopped', reason: `the operator ${t.status} the lead` },
    ]);
  }

  const d = t.disposition;
  if (!isKnown(d)) {
    return alert('disposition-unknown', `Lead ${lead.name} went ${t.status} at ${hhmm(at)} and its disposition could not be read; no reopen.`, 'warning', 'terminal');
  }
  const reclaimed = d !== null
    ? RECLAIM_SOURCES.has(d.source)
    : t.transitionSource === 'watchdog' && t.reason === 'timeout';

  if (reclaimed) {
    const source = d?.source ?? 'watchdog timeout';
    if (cr.suppressedAfterMs !== undefined && at >= cr.suppressedAfterMs) {
      return alert('reclaim-after-leave-it', `Lead ${lead.name} was reclaimed (${source}) at ${hhmm(at)} after "Leave it"; no reopen.`, 'warning', 'reclaim-suppressed');
    }
    const key = `reopen:${lead.taskId}:${at}`;
    if (cr.reopenKeys.includes(key)) {
      return result('reopen-pending', `reopen ${key} already issued; retrying until the lead is live`, [
        { kind: 'reopen', trigger: 'reopen', idempotencyKey: key, reason: `reclaimed by ${source}` },
      ]);
    }
    if (cr.reopenCount >= REOPEN_BUDGET) {
      return alert('reopen-budget-exhausted', `Lead ${lead.name} was reclaimed (${source}) at ${hhmm(at)}; reopen budget exhausted (${REOPEN_BUDGET}).`, 'critical', 'reopen-budget');
    }
    if (cr.lastReopenAtMs !== undefined && nowMs - cr.lastReopenAtMs < REOPEN_COOLDOWN_MS) {
      return result('reopen-cooldown', `reclaimed by ${source}; last reopen at ${hhmm(cr.lastReopenAtMs)}, waiting for the 30-min cooldown`);
    }
    return result(
      'reopen',
      `reclaimed by ${source} at ${hhmm(at)}; reopen ${cr.reopenCount + 1} of ${REOPEN_BUDGET}`,
      [{ kind: 'reopen', trigger: 'reopen', idempotencyKey: key, reason: `reclaimed by ${source}` }],
      { ...state, crashRecovery: { ...cr, reopenCount: cr.reopenCount + 1, lastReopenAtMs: nowMs, reopenKeys: [...cr.reopenKeys, key].slice(-20) } },
    );
  }

  if (d !== null && d.source === 'crash-recovery' && d.kind === 'respawned') {
    return result('respawned', `Kookr's crash recovery relaunched the lead at ${hhmm(at)}; typing the contract again, no reopen`, [
      { kind: 'type-line', trigger: 'respawned', text: LEAD_CONTRACT_LINE, dedupKey: `respawned:${lead.taskId}:${at}` },
    ]);
  }
  if (d !== null && d.source === 'crash-recovery' && d.kind === 'needs-human') {
    return alert('crash-loop-needs-human', `Lead ${lead.name} hit crash-loop protection at ${hhmm(at)} (needs-human); no reopen.`, 'critical', 'crash-loop');
  }
  return alert(
    'no-reopen',
    `Lead ${lead.name} went ${t.status} at ${hhmm(at)} (${t.reason}, ${d ? `${d.source} · ${d.kind}` : t.transitionSource}); not a reclaim, so no reopen.`,
    'warning',
    'terminal',
  );
}
