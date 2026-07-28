import { describe, it, expect } from 'vitest';
import { LaunchPhaseTracker, LAUNCH_PHASES } from './launch-phase-timings.js';

/** A controllable monotonic clock so phase durations are deterministic. */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe('LaunchPhaseTracker', () => {
  it('records each phase duration in order for a completed launch', () => {
    const clock = fakeClock();
    const tracker = new LaunchPhaseTracker(clock.now);

    tracker.enter('preflight');
    clock.advance(30);
    tracker.enter('reserve');
    clock.advance(1);
    tracker.enter('session-create');
    clock.advance(200);
    tracker.enter('agent-boot');
    clock.advance(400);
    tracker.enter('ack');
    clock.advance(20);
    tracker.complete();

    const snap = tracker.snapshot();
    expect(snap.phases.map((p) => p.phase)).toEqual([
      'preflight', 'reserve', 'session-create', 'agent-boot', 'ack',
    ]);
    expect(snap.phases.map((p) => p.durationMs)).toEqual([30, 1, 200, 400, 20]);
    expect(snap.phases.every((p) => p.completed)).toBe(true);
    expect(snap.incompletePhase).toBeUndefined();
    expect(snap.totalMs).toBe(651);
  });

  it('flags the in-flight phase as incomplete when the launch is aborted mid-phase', () => {
    const clock = fakeClock();
    const tracker = new LaunchPhaseTracker(clock.now);

    tracker.enter('preflight');
    clock.advance(10);
    tracker.enter('reserve');
    clock.advance(2);
    tracker.enter('session-create');
    clock.advance(180_000); // hung here — the 180s launch_timeout class
    tracker.abort();

    const snap = tracker.snapshot();
    expect(snap.incompletePhase).toBe('session-create');
    const sessionCreate = snap.phases.find((p) => p.phase === 'session-create');
    expect(sessionCreate).toBeDefined();
    expect(sessionCreate!.completed).toBe(false);
    expect(sessionCreate!.durationMs).toBe(180_000);
    // Earlier phases still record as completed handoffs.
    expect(snap.phases.find((p) => p.phase === 'reserve')!.completed).toBe(true);
  });

  it('identifies a hang in agent-boot (adapter-reported phase)', () => {
    const clock = fakeClock();
    const tracker = new LaunchPhaseTracker(clock.now);
    tracker.enter('preflight');
    tracker.enter('reserve');
    tracker.enter('session-create');
    clock.advance(50);
    tracker.enter('agent-boot');
    clock.advance(90_000); // grok-build POST >90s hang localized to boot
    tracker.abort();

    const snap = tracker.snapshot();
    expect(snap.incompletePhase).toBe('agent-boot');
    expect(snap.phases.find((p) => p.phase === 'agent-boot')!.durationMs).toBe(90_000);
  });

  it('snapshot() before finalization reflects the still-open phase as in-flight', () => {
    const clock = fakeClock();
    const tracker = new LaunchPhaseTracker(clock.now);
    tracker.enter('preflight');
    clock.advance(5);
    tracker.enter('session-create');
    clock.advance(15);

    const snap = tracker.snapshot();
    expect(snap.incompletePhase).toBe('session-create');
    expect(snap.phases.map((p) => p.phase)).toEqual(['preflight', 'session-create']);
    expect(snap.phases.find((p) => p.phase === 'session-create')!.completed).toBe(false);
  });

  it('is inert after finalization — enter()/complete()/abort() are no-ops', () => {
    const clock = fakeClock();
    const tracker = new LaunchPhaseTracker(clock.now);
    tracker.enter('preflight');
    tracker.complete();
    const before = tracker.snapshot();

    tracker.enter('session-create');
    tracker.abort();
    const after = tracker.snapshot();
    expect(after.phases).toEqual(before.phases);
    expect(after.incompletePhase).toBeUndefined();
  });

  it('exposes the canonical phase order', () => {
    expect(LAUNCH_PHASES).toEqual([
      'preflight', 'reserve', 'session-create', 'agent-boot', 'ack',
    ]);
  });
});
