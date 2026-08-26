import { describe, expect, test } from 'vitest';
import { LaunchDependencyAdmission } from './launch-dependency-admission.js';

const failure = {
  dependency: 'kb',
  category: 'provider_api',
  summary: 'KB provider is unavailable',
};

describe('LaunchDependencyAdmission', () => {
  test('transitions healthy → degraded → half_open → healthy', () => {
    let now = 100;
    const admission = new LaunchDependencyAdmission(() => now);

    admission.observe(['kb'], [failure]);
    const degraded = admission.evaluate(['kb']);
    expect(degraded).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
      dependencies: [{ dependency: 'kb', state: 'degraded' }],
    });
    expect(admission.snapshot()).toEqual([
      expect.objectContaining({ dependency: 'kb', state: 'degraded', lastChangedAt: 100 }),
    ]);

    now = 200;
    admission.observe(['kb'], []);
    const probe = admission.evaluate(['kb']);
    expect(probe).toMatchObject({
      admit: true,
      probe: { dependencies: ['kb'] },
    });

    const busy = admission.evaluate(['kb']);
    expect(busy).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
      dependencies: [{ dependency: 'kb', state: 'half_open' }],
    });

    if (!probe.admit || !probe.probe) throw new Error('expected a recovery probe');
    now = 300;
    admission.completeProbe(probe.probe, true);
    expect(admission.snapshot()).toEqual([
      expect.objectContaining({ dependency: 'kb', state: 'healthy', lastChangedAt: 300 }),
    ]);
    expect(admission.evaluate(['kb'])).toMatchObject({ admit: true });
  });

  test('keeps unknown health fail-open and distinct from confirmed degradation', () => {
    const admission = new LaunchDependencyAdmission(() => 100);

    admission.observe(['kb'], [{ dependency: 'kb', category: 'unknown', summary: 'probe timed out' }]);

    expect(admission.evaluate(['kb'])).toMatchObject({ admit: true });
    expect(admission.snapshot()).toEqual([
      expect.objectContaining({ dependency: 'kb', state: 'unknown', reason: 'probe timed out' }),
    ]);
  });

  test('does not erase confirmed degradation when a later collection is unknown', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.observe(['kb'], [failure]);

    admission.observe(['kb'], [{
      dependency: 'kb',
      category: 'unknown',
      summary: 'later probe timed out',
    }]);

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
    });
    expect(admission.snapshot()[0]).toMatchObject({ dependency: 'kb', state: 'degraded' });
  });

  test('failed recovery probe returns the circuit to degraded', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.observe(['kb'], [failure]);
    admission.observe(['kb'], []);
    const probe = admission.evaluate(['kb']);
    if (!probe.admit || !probe.probe) throw new Error('expected a recovery probe');

    admission.completeProbe(probe.probe, false);

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
    });
  });

  test('keeps a probe invalidated by confirmed failure fenced until its owner settles', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.observe(['kb'], [failure]);
    admission.observe(['kb'], []);
    const decision = admission.evaluate(['kb']);
    if (!decision.admit || !decision.probe) throw new Error('expected a recovery probe');

    expect(admission.isProbeActive(decision.probe)).toBe(true);

    admission.observe(['kb'], [failure]);
    expect(admission.isProbeActive(decision.probe)).toBe(false);
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
    });

    admission.observe(['kb'], []);
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });

    admission.completeProbe(decision.probe, true);
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
    });

    admission.observe(['kb'], []);
    const replacement = admission.evaluate(['kb']);
    if (!replacement.admit || !replacement.probe) throw new Error('expected a replacement probe');
    admission.releaseProbe(replacement.probe);
    expect(admission.isProbeActive(replacement.probe)).toBe(false);
  });

  test('keeps an active half-open probe claimed when a concurrent health check is unknown', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.observe(['kb'], [failure]);
    admission.observe(['kb'], []);
    const probe = admission.evaluate(['kb']);
    if (!probe.admit || !probe.probe) throw new Error('expected a recovery probe');

    admission.observe(['kb'], [{
      dependency: 'kb',
      category: 'unknown',
      summary: 'concurrent health check timed out',
    }]);

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
    admission.completeProbe(probe.probe, true);
    expect(admission.evaluate(['kb'])).toMatchObject({ admit: true });
  });

  test('restores persisted parked state through a bounded recovery probe', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.restoreParked([{
      dependency: 'kb',
      state: 'degraded',
      reason: 'KB provider was unavailable before restart',
    }]);

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
    });

    admission.observe(['kb'], []);
    const probe = admission.evaluate(['kb']);
    expect(probe).toMatchObject({
      admit: true,
      probe: { dependencies: ['kb'] },
    });
  });

  test('keeps an interrupted startup probe busy through changing provider evidence', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.restoreInterruptedProbe([{
      dependency: 'kb',
      state: 'half_open',
    }], 'task-1');

    admission.observe(['kb'], [failure]);
    admission.observe(['kb'], []);

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  test('releases interrupted cleanup to one unclaimed half-open probe', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    const dependencies = [{ dependency: 'kb', state: 'half_open' as const }];
    admission.restoreInterruptedProbe(dependencies, 'task-1');

    admission.releaseInterruptedProbe(dependencies);

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: true,
      probe: { dependencies: ['kb'] },
    });
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  test('settles a reconciled live probe token only after physical absence', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    admission.observe(['kb'], []);
    const active = admission.evaluate(['kb']);
    expect(active).toMatchObject({ admit: true, probe: { dependencies: ['kb'] } });
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });

    admission.settleReconciledProbe([{
      dependency: 'kb',
      state: 'degraded',
      reason: 'Recovery probe was interrupted',
    }], 'parked');

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
    });
  });

  test('preserves confirmed degradation observed through cleanup settlement', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    const dependencies = [{ dependency: 'kb', state: 'half_open' as const }];
    admission.observe(['kb'], [failure]);
    admission.observe(['kb'], []);
    const probe = admission.evaluate(['kb']);
    if (!probe.admit || !probe.probe) throw new Error('expected recovery probe');

    admission.observe(['kb'], [failure]);
    admission.retainProbeCleanup(dependencies, 'task-1');
    admission.observe(['kb'], [failure]);
    admission.settleReconciledProbe(dependencies, 'released');
    admission.observe(['kb'], [{ dependency: 'kb', category: 'unknown' }]);

    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'dependency_degraded',
    });
  });

  test('restores reconciled live-probe success after stale parked waiters', () => {
    const admission = new LaunchDependencyAdmission(() => 100);
    admission.restoreParked([{
      dependency: 'kb',
      state: 'half_open',
      reason: 'A recovery probe was already in flight',
    }]);

    admission.restoreSuccessfulProbe(['kb'], 200, new Map());

    expect(admission.snapshot()).toEqual([
      expect.objectContaining({ dependency: 'kb', state: 'healthy' }),
    ]);
    expect(admission.evaluate(['kb'])).toEqual({ admit: true });
  });

  test('does not let an old reconciled probe erase newer confirmed degradation', () => {
    const admission = new LaunchDependencyAdmission(() => 300);
    admission.restoreParked([{
      dependency: 'kb',
      state: 'degraded',
      reason: 'Provider failed after the probe began',
    }]);

    admission.restoreSuccessfulProbe(['kb'], 100, new Map([['kb', 200]]));

    expect(admission.snapshot()).toEqual([
      expect.objectContaining({ dependency: 'kb', state: 'degraded' }),
    ]);
  });
});
