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
      states: [{ dependency: 'kb', state: 'half_open' }],
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
});
