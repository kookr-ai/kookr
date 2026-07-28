import { describe, expect, test } from 'vitest';
import {
  DEFAULT_HUNG_TASK_REAP_MS,
  buildReapDisposition,
  classifyReapOutcome,
  evaluateHungTaskReap,
  isTaskHungSuspect,
} from './hung-task-reaper.js';
import type { MergedPrAttribution } from './delivered-task-completion.js';
import { Watchdog } from './watchdog.js';

const THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3h, matches the default
const NOW = Date.parse('2026-06-21T00:00:00.000Z');

function silentSince(ms: number) {
  return { lastHookEventAt: ms, lastPaneChangeAt: ms, lastTokenActivityAt: ms };
}

describe('evaluateHungTaskReap', () => {
  test('all channels silent past the threshold is eligible', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - THRESHOLD_MS - 1),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: true, silentForMs: THRESHOLD_MS + 1 });
  });

  test('treats the boundary (silent for exactly thresholdMs) as eligible', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - THRESHOLD_MS),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: true, silentForMs: THRESHOLD_MS });
  });

  test('any single live channel (hook events) keeps the task NOT reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: NOW - 60_000, lastPaneChangeAt: NOW - THRESHOLD_MS - 1, lastTokenActivityAt: NOW - THRESHOLD_MS - 1 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_silent_enough' });
  });

  test('any single live channel (pane change) keeps the task NOT reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: NOW - THRESHOLD_MS - 1, lastPaneChangeAt: NOW - 60_000, lastTokenActivityAt: NOW - THRESHOLD_MS - 1 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_silent_enough' });
  });

  test('any single live channel (token activity) keeps the task NOT reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: NOW - THRESHOLD_MS - 1, lastPaneChangeAt: NOW - THRESHOLD_MS - 1, lastTokenActivityAt: NOW - 60_000 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_silent_enough' });
  });

  test('a task with a pending signal is NEVER reaped, even if fully silent', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress', pendingSignal: { kind: 'completion_ready', raisedAt: '2026-06-20T00:00:00.000Z' } },
      silentSince(0),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'has_pending_signal' });
  });

  test('a task that has not launched yet (pending) is never reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'pending' },
      silentSince(0),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_in_progress' });
  });

  test('a terminal task is never reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'completed' },
      silentSince(0),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_in_progress' });
  });

  test('defaults thresholdMs to DEFAULT_HUNG_TASK_REAP_MS when omitted', () => {
    const justUnderDefault = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - DEFAULT_HUNG_TASK_REAP_MS + 1_000),
      { now: NOW },
    );
    expect(justUnderDefault.eligible).toBe(false);

    const pastDefault = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - DEFAULT_HUNG_TASK_REAP_MS - 1_000),
      { now: NOW },
    );
    expect(pastDefault.eligible).toBe(true);
  });

  test('zero (never recorded) activity timestamps count as silent since epoch', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: 0, lastPaneChangeAt: 0, lastTokenActivityAt: 0 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict.eligible).toBe(true);
  });

  // `stale_agent` does NOT mean "no tool in progress" — watchdog.tick also
  // returns it for a tool left unmatched (PreToolUse with no PostToolUse)
  // once it's been silent past the watchdog's own maxToolExecutionTimeMs
  // (10 min default). These two tests document what actually decides the
  // reap outcome in that case: this function's OWN, much larger threshold
  // against `lastHookEventAt` — completely independent of "tool in progress"
  // as a concept, which this function never looks at.
  describe('tool-in-progress does not bypass the hook-event channel (issue #1526 Phase A)', () => {
    const agentId = 'kookr-tool-in-progress';

    test('a tool started 1h ago (3h threshold) is watchdog stale_agent but NOT reaped — the hook channel is still live', () => {
      const watchdog = new Watchdog(); // default config: maxToolExecutionTimeMs = 10min
      const toolStartedAt = NOW - 60 * 60_000; // 1h ago
      watchdog.registerAgent(agentId, toolStartedAt, toolStartedAt);
      watchdog.recordEvents(agentId, [{ type: 'tool_use', sessionId: agentId, toolName: 'Bash', toolUseId: 'tu-1' }], toolStartedAt);

      // 1h of total silence far exceeds the watchdog's own 10-minute
      // maxToolExecutionTimeMs override, so the watchdog itself already
      // reports stale_agent — this is the exact ambiguity the comment warns
      // about: stale_agent here does NOT mean the tool call went away.
      const verdict = watchdog.tick(agentId, 'frozen pane', [], NOW);
      expect(verdict.status).toBe('stale_agent');
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      // The reaper's OWN threshold (3h) is what actually protects this task:
      // the hook channel (PreToolUse 1h ago) isn't silent long enough yet.
      const state = watchdog.getState(agentId)!;
      const reapVerdict = evaluateHungTaskReap(
        { status: 'inProgress' },
        { lastHookEventAt: state.lastEventAt, lastPaneChangeAt: state.lastPaneChangeAt, lastTokenActivityAt: state.lastTokenActivityAt },
        { now: NOW, thresholdMs: THRESHOLD_MS },
      );
      expect(reapVerdict).toEqual({ eligible: false, reason: 'not_silent_enough' });
    });

    test('a tool started 4h ago (3h threshold), all channels silent, IS reaped — this is the incident case', () => {
      const watchdog = new Watchdog();
      const toolStartedAt = NOW - 4 * 60 * 60_000; // 4h ago — past the 3h reap threshold
      watchdog.registerAgent(agentId, toolStartedAt, toolStartedAt);
      watchdog.recordEvents(agentId, [{ type: 'tool_use', sessionId: agentId, toolName: 'Write', toolUseId: 'tu-2' }], toolStartedAt);

      const verdict = watchdog.tick(agentId, 'frozen pane', [], NOW);
      expect(verdict.status).toBe('stale_agent');
      expect(watchdog.hasToolInProgress(agentId)).toBe(true);

      const state = watchdog.getState(agentId)!;
      const reapVerdict = evaluateHungTaskReap(
        { status: 'inProgress' },
        { lastHookEventAt: state.lastEventAt, lastPaneChangeAt: state.lastPaneChangeAt, lastTokenActivityAt: state.lastTokenActivityAt },
        { now: NOW, thresholdMs: THRESHOLD_MS },
      );
      expect(reapVerdict.eligible).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // isTaskHungSuspect (issue #1526 Phase B) — the cheap, in-memory-only "is
  // this task's agent hung right now" check shared by the capacity ledger and
  // the per-task stuckReason projection. Deliberately a much shorter fuse than
  // the reaper above (early warning vs. actual kill).
  // ---------------------------------------------------------------------------
  describe('isTaskHungSuspect', () => {
    const SUSPECT_THRESHOLD_MS = 60_000; // matches Watchdog's default unconditionalStaleThresholdMs

    test('a queued stale_agent verdict is trusted directly, even with fresh liveness', () => {
      const suspect = isTaskHungSuspect(
        { status: 'inProgress' },
        {
          queuedAnomalyType: 'stale_agent',
          liveness: silentSince(NOW), // "now" — not silent at all
          toolInProgress: false,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(true);
    });

    test('a queued verdict of a different type is not trusted, falls through to the liveness fallback', () => {
      const suspect = isTaskHungSuspect(
        { status: 'inProgress' },
        {
          queuedAnomalyType: 'needs_input',
          liveness: silentSince(NOW), // fresh — fallback says not suspect
          toolInProgress: false,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(false);
    });

    test('watchdog state absent (no liveness) → not hung suspect, even with no queued verdict', () => {
      const suspect = isTaskHungSuspect(
        { status: 'inProgress' },
        {
          queuedAnomalyType: null,
          liveness: undefined,
          toolInProgress: false,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(false);
    });

    test('all channels silent past the watchdog stale threshold, no queued verdict → hung suspect (fallback)', () => {
      const suspect = isTaskHungSuspect(
        { status: 'inProgress' },
        {
          queuedAnomalyType: null,
          liveness: silentSince(NOW - SUSPECT_THRESHOLD_MS - 1),
          toolInProgress: false,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(true);
    });

    test('silent but NOT past the threshold yet → not hung suspect', () => {
      const suspect = isTaskHungSuspect(
        { status: 'inProgress' },
        {
          queuedAnomalyType: null,
          liveness: silentSince(NOW - SUSPECT_THRESHOLD_MS + 1_000),
          toolInProgress: false,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(false);
    });

    test('a tool left in progress suppresses the liveness fallback — mirrors tick()\'s own toolInProgress gate', () => {
      // Without this gate, any tool call running longer than the watchdog's
      // short unconditionalStaleThresholdMs (60s default) would falsely read
      // as hung — evaluateHungTaskReap alone does not know about tool state.
      const suspect = isTaskHungSuspect(
        { status: 'inProgress' },
        {
          queuedAnomalyType: null,
          liveness: silentSince(NOW - SUSPECT_THRESHOLD_MS - 1),
          toolInProgress: true,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(false);
    });

    test('a queued stale_agent verdict still wins even while a tool is in progress (the 10-min tool-override case)', () => {
      const suspect = isTaskHungSuspect(
        { status: 'inProgress' },
        {
          queuedAnomalyType: 'stale_agent',
          liveness: undefined,
          toolInProgress: true,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(true);
    });

    test('a task with a pending signal is never hung suspect via the fallback, even fully silent', () => {
      const suspect = isTaskHungSuspect(
        { status: 'inProgress', pendingSignal: { kind: 'completion_ready', raisedAt: '2026-06-20T00:00:00.000Z' } },
        {
          queuedAnomalyType: null,
          liveness: silentSince(0),
          toolInProgress: false,
          unconditionalStaleThresholdMs: SUSPECT_THRESHOLD_MS,
        },
        { now: NOW },
      );
      expect(suspect).toBe(false);
    });
  });
});

describe('classifyReapOutcome / buildReapDisposition (issue #1559)', () => {
  const MERGED: MergedPrAttribution = { prNumber: 1542, prUrl: 'https://github.com/kookr-ai/kookr/pull/1542' };
  const AT = '2026-07-25T21:13:18.000Z';

  // Invariant: outcome is delivered_then_hung IFF an attributable merged PR is
  // present — sampled across the presence (with/without url) and absence
  // (null/undefined) cases.
  test('outcome is delivered_then_hung exactly when a merged PR is present', () => {
    for (const merged of [MERGED, { prNumber: 7 }] as (MergedPrAttribution | null | undefined)[]) {
      expect(classifyReapOutcome(merged)).toBe('delivered_then_hung');
    }
    for (const empty of [null, undefined] as (MergedPrAttribution | null | undefined)[]) {
      expect(classifyReapOutcome(empty)).toBe('terminated');
    }
  });

  test('delivered disposition carries the outcome, PR identity, and reaper source', () => {
    expect(buildReapDisposition(MERGED, AT)).toEqual({
      reason: 'hung_reap',
      at: AT,
      source: 'hung-task-reaper',
      outcome: 'delivered_then_hung',
      detail: 'Delivered PR #1542 before hanging; reaped after prolonged silence.',
      deliveredPr: { number: 1542, url: 'https://github.com/kookr-ai/kookr/pull/1542' },
    });
  });

  test('a merged PR without a URL omits the url field', () => {
    const d = buildReapDisposition({ prNumber: 99 }, AT);
    expect(d.deliveredPr).toEqual({ number: 99 });
    expect(d.outcome).toBe('delivered_then_hung');
  });

  test('no attribution yields a plain terminated disposition with no deliveredPr', () => {
    expect(buildReapDisposition(null, AT)).toEqual({
      reason: 'hung_reap',
      at: AT,
      source: 'hung-task-reaper',
      outcome: 'terminated',
    });
  });
});
