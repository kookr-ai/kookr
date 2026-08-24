import { describe, it, expect } from 'vitest';

import type { QuotaStatus } from './quota-types.js';
import {
  ORCHESTRATION_PAUSE_REL_PATH,
  SOFT_QUOTA_PAUSE_AT,
  SOFT_QUOTA_RESUME_AT,
  buildPauseRecord,
  buildPauseProvenance,
  closePauseRecord,
  evaluateSoftQuotaPause,
  isOrchestrationPaused,
  orchestratorShouldSpawn,
  parsePauseRecord,
  pauseRecordCreatedByKillSwitch,
  resolveDefaultAgentQuotaSample,
  resolveOrchestrationPausePath,
  type PauseLifecycle,
  type OrchestrationPauseRecord,
} from './orchestration-pause.js';

describe('pause record path', () => {
  it('resolves under playbook-state/orchestrator/quota-pause.json', () => {
    expect(ORCHESTRATION_PAUSE_REL_PATH).toBe('playbook-state/orchestrator/quota-pause.json');
    expect(resolveOrchestrationPausePath('/srv/kookr-data')).toBe(
      '/srv/kookr-data/playbook-state/orchestrator/quota-pause.json',
    );
  });
});

describe('parsePauseRecord', () => {
  it('returns null for non-objects', () => {
    expect(parsePauseRecord(null)).toBeNull();
    expect(parsePauseRecord('nope')).toBeNull();
    expect(parsePauseRecord(42)).toBeNull();
  });

  it('reads a v1 operator file (no source) as a human pause', () => {
    const v1 = {
      schemaVersion: 1,
      paused: true,
      reason: 'operator: pause until quotas reset',
      pausedAt: '2026-08-18T08:05:04.931Z',
      pausedBy: 'jean',
      mechanism: 'automationKillSwitch / SAFE MODE',
      notes: ['aborted unused PIB'],
    };
    const rec = parsePauseRecord(v1);
    expect(rec).not.toBeNull();
    expect(rec!.source).toBe('human');
    expect(rec!.paused).toBe(true);
    expect(rec!.schemaVersion).toBe(3);
    expect(rec!.lifecycle).toBe('unresolved');
    expect(rec!.pausedBy).toBe('jean');
    expect(rec!.notes).toEqual(['aborted unused PIB']);
    expect(rec!.mechanism).toBe('automationKillSwitch / SAFE MODE');
    expect(pauseRecordCreatedByKillSwitch(rec)).toBe(true);
  });

  it('preserves a non-kill-switch mechanism from disk', () => {
    const rec = parsePauseRecord({
      paused: true,
      source: 'human',
      mechanism: 'external-hold',
    });
    expect(rec!.mechanism).toBe('external-hold');
    expect(pauseRecordCreatedByKillSwitch(rec)).toBe(false);
  });

  it('reads a soft-quota record', () => {
    const rec = parsePauseRecord({ paused: true, source: 'soft-quota', pausedBy: 'orchestrator' });
    expect(rec!.source).toBe('soft-quota');
  });

  it('preserves paused:false records', () => {
    const rec = parsePauseRecord({ paused: false, source: 'soft-quota' });
    expect(rec!.paused).toBe(false);
  });

  it('marks a legacy record without an end as unresolved instead of active', () => {
    const rec = parsePauseRecord({
      schemaVersion: 2,
      paused: true,
      source: 'soft-quota',
      pausedAt: '2026-08-22T14:14:00.000Z',
    });
    expect(rec).toMatchObject({ lifecycle: 'unresolved', paused: true, source: 'soft-quota' });
  });
});

describe('pauseRecordCreatedByKillSwitch', () => {
  it('is true for a v2 kill-switch record', () => {
    const rec = buildPauseRecord({
      source: 'human',
      reason: 'r',
      by: 'jean',
      atIso: '2026-08-19T00:00:00.000Z',
    });
    expect(rec.mechanism).toBe('automationKillSwitch');
    expect(pauseRecordCreatedByKillSwitch(rec)).toBe(true);
  });

  it('is true for a soft-quota record (same kill-switch lever)', () => {
    const rec = buildPauseRecord({
      source: 'soft-quota',
      reason: 'r',
      by: 'orchestrator',
      atIso: '2026-08-19T00:00:00.000Z',
    });
    expect(pauseRecordCreatedByKillSwitch(rec)).toBe(true);
  });

  it('is false when paused is false, even on the kill-switch lever', () => {
    const rec = parsePauseRecord({ paused: false, mechanism: 'automationKillSwitch' });
    expect(pauseRecordCreatedByKillSwitch(rec)).toBe(false);
  });

  it('is false for null', () => {
    expect(pauseRecordCreatedByKillSwitch(null)).toBe(false);
  });
});

describe('buildPauseRecord', () => {
  it('builds an active v3 record with the given fields', () => {
    const rec = buildPauseRecord({
      source: 'human',
      reason: 'quota reset window',
      by: 'jean',
      atIso: '2026-08-19T00:00:00.000Z',
    });
    expect(rec).toMatchObject<Partial<OrchestrationPauseRecord>>({
      schemaVersion: 3,
      lifecycle: 'active',
      paused: true,
      source: 'human',
      reason: 'quota reset window',
      pausedAt: '2026-08-19T00:00:00.000Z',
      pausedBy: 'jean',
      mechanism: 'automationKillSwitch',
    });
    expect(rec.id).toBe('pause-2026-08-19T00:00:00.000Z');
  });
});

describe('pause lifecycle and provenance', () => {
  const active = buildPauseRecord({
    id: 'active-1',
    source: 'human',
    reason: 'current hold',
    by: 'jean',
    atIso: '2026-08-23T10:00:00.000Z',
  });

  it.each(['ended', 'cancelled'] satisfies PauseLifecycle[])('closes a pause as %s with source and timestamps', (lifecycle) => {
    const closed = closePauseRecord(active, {
      lifecycle,
      atIso: '2026-08-23T12:00:00.000Z',
      by: 'operator',
      source: `test-${lifecycle}`,
    });
    expect(closed).toMatchObject({
      id: 'active-1',
      lifecycle,
      paused: false,
      endedAt: '2026-08-23T12:00:00.000Z',
      endedBy: 'operator',
      endSource: `test-${lifecycle}`,
    });
  });

  it('keeps current state separate and excludes unresolved history from known overlap', () => {
    const ended = closePauseRecord(active, {
      lifecycle: 'ended',
      atIso: '2026-08-23T12:00:00.000Z',
      by: 'operator',
      source: 'explicit-resume',
    });
    const unresolved = parsePauseRecord({
      id: 'unknown-1',
      paused: true,
      source: 'soft-quota',
      pausedAt: '2026-08-22T14:14:00.000Z',
    })!;
    const provenance = buildPauseProvenance([ended, unresolved], {
      windowStartMs: Date.parse('2026-08-22T12:00:00.000Z'),
      windowEndMs: Date.parse('2026-08-23T12:00:00.000Z'),
    });
    expect(provenance.currentPause).toBeNull();
    expect(provenance.historicalOverlap.overlapMs).toBe(2 * 60 * 60 * 1000);
    expect(provenance.historicalOverlap.incompleteRecordCount).toBe(1);
    expect(provenance.incompleteRecords).toEqual([
      expect.objectContaining({ id: 'unknown-1', source: 'soft-quota' }),
    ]);
  });

  it('counts an explicitly active record through the requested window', () => {
    const provenance = buildPauseProvenance([active], {
      windowStartMs: Date.parse('2026-08-23T00:00:00.000Z'),
      windowEndMs: Date.parse('2026-08-23T12:00:00.000Z'),
    });
    expect(provenance.currentPause).toBe(active);
    expect(provenance.historicalOverlap.overlapMs).toBe(2 * 60 * 60 * 1000);
    expect(provenance.historicalOverlap.incompleteRecordCount).toBe(0);
  });

  it('keeps the 2026-08-23 quota-drain fixture measurable without inventing an active pause', () => {
    const historical = closePauseRecord(buildPauseRecord({
      id: 'quota-drain-2026-08-23',
      source: 'soft-quota',
      reason: 'near quota',
      by: 'orchestrator',
      atIso: '2026-08-22T14:14:00.000Z',
    }), {
      lifecycle: 'ended',
      atIso: '2026-08-23T09:32:00.000Z',
      by: 'orchestrator',
      source: 'auto-resume',
    });
    const unresolved = parsePauseRecord({
      id: 'quota-drain-incomplete',
      paused: true,
      source: 'soft-quota',
      pausedAt: '2026-08-22T14:14:00.000Z',
    })!;
    const provenance = buildPauseProvenance([historical, unresolved], {
      windowStartMs: Date.parse('2026-08-22T09:32:00.000Z'),
      windowEndMs: Date.parse('2026-08-23T09:32:00.000Z'),
    });
    expect(provenance.currentPause).toBeNull();
    expect(provenance.historicalOverlap.overlapMs).toBe(19.3 * 60 * 60 * 1000);
    expect(provenance.historicalOverlap.overlapFraction).toBeCloseTo(19.3 / 24, 5);
    expect(provenance.historicalOverlap.incompleteRecordCount).toBe(1);
  });

  it('unions overlapping known windows instead of double-counting quota drain', () => {
    const first = closePauseRecord(buildPauseRecord({
      id: 'overlap-1', source: 'soft-quota', reason: 'r', by: 'orchestrator', atIso: '2026-08-23T00:00:00.000Z',
    }), { lifecycle: 'ended', atIso: '2026-08-23T02:00:00.000Z', by: 'orchestrator', source: 'auto-resume' });
    const second = closePauseRecord(buildPauseRecord({
      id: 'overlap-2', source: 'human', reason: 'r', by: 'jean', atIso: '2026-08-23T01:00:00.000Z',
    }), { lifecycle: 'ended', atIso: '2026-08-23T03:00:00.000Z', by: 'jean', source: 'explicit-resume' });
    const provenance = buildPauseProvenance([first, second], {
      windowStartMs: Date.parse('2026-08-23T00:00:00.000Z'),
      windowEndMs: Date.parse('2026-08-23T04:00:00.000Z'),
    });
    expect(provenance.historicalOverlap.overlapMs).toBe(3 * 60 * 60 * 1000);
  });
});

describe('isOrchestrationPaused / orchestratorShouldSpawn', () => {
  const softRecord: OrchestrationPauseRecord = buildPauseRecord({
    source: 'soft-quota',
    reason: 'r',
    by: 'orchestrator',
    atIso: '2026-08-19T00:00:00.000Z',
  });

  it('is paused when SAFE MODE engaged even with no record', () => {
    expect(isOrchestrationPaused({ safeModeEngaged: true, record: null })).toBe(true);
    expect(orchestratorShouldSpawn({ safeModeEngaged: true, record: null })).toBe(false);
  });

  it('is paused when the record is explicitly active even without SAFE MODE', () => {
    // A lifecycle-active record remains a real spawn gate until it is closed.
    expect(isOrchestrationPaused({ safeModeEngaged: false, record: softRecord })).toBe(true);
    expect(orchestratorShouldSpawn({ safeModeEngaged: false, record: softRecord })).toBe(false);
  });

  it('spawns when neither SAFE MODE nor a paused record is present', () => {
    expect(orchestratorShouldSpawn({ safeModeEngaged: false, record: null })).toBe(true);
  });
});

describe('resolveDefaultAgentQuotaSample', () => {
  it('reports grok-build unsupported without leaking XAI_API_KEY guidance', () => {
    const s = resolveDefaultAgentQuotaSample('grok-build', null);
    expect(s.supported).toBe(false);
    expect(s.utilization).toBeUndefined();
    expect(s.reason).toContain('XAI_API_KEY is disallowed');
  });

  it('reports other agents unsupported', () => {
    expect(resolveDefaultAgentQuotaSample('codex-cli', null).supported).toBe(false);
  });

  it('samples claude-code from the more-constrained window', () => {
    const quota: QuotaStatus = {
      fiveHour: { utilization: 40, resetsAt: '2026-08-19T05:00:00.000Z' },
      sevenDay: { utilization: 96, resetsAt: '2026-08-25T00:00:00.000Z' },
      updatedAt: 0,
    };
    const s = resolveDefaultAgentQuotaSample('claude-code', quota);
    expect(s.supported).toBe(true);
    expect(s.utilization).toBe(96);
    expect(s.window).toBe('seven-day');
    expect(s.resetsAt).toBe('2026-08-25T00:00:00.000Z');
  });

  it('reports claude-code supported-but-unsampled when no snapshot', () => {
    const s = resolveDefaultAgentQuotaSample('claude-code', null);
    expect(s.supported).toBe(true);
    expect(s.utilization).toBeUndefined();
  });
});

describe('evaluateSoftQuotaPause (hysteresis + stickiness)', () => {
  const now = Date.parse('2026-08-19T00:00:00.000Z');
  const soft: OrchestrationPauseRecord = buildPauseRecord({
    source: 'soft-quota',
    reason: 'r',
    by: 'orchestrator',
    atIso: '2026-08-18T00:00:00.000Z',
  });
  const human: OrchestrationPauseRecord = buildPauseRecord({
    source: 'human',
    reason: 'r',
    by: 'jean',
    atIso: '2026-08-18T00:00:00.000Z',
  });

  it('pauses at/above the 95% stop line when not paused', () => {
    const d = evaluateSoftQuotaPause({
      utilization: SOFT_QUOTA_PAUSE_AT,
      resetsAt: null,
      nowMs: now,
      record: null,
      safeModeEngaged: false,
    });
    expect(d.action).toBe('pause');
  });

  it('does not pause just below the stop line', () => {
    const d = evaluateSoftQuotaPause({
      utilization: SOFT_QUOTA_PAUSE_AT - 1,
      resetsAt: null,
      nowMs: now,
      record: null,
      safeModeEngaged: false,
    });
    expect(d.action).toBe('none');
  });

  it('holds a soft pause in the hysteresis band (81%..94%) — no flap', () => {
    for (const utilization of [SOFT_QUOTA_RESUME_AT + 1, 90, SOFT_QUOTA_PAUSE_AT - 1]) {
      const d = evaluateSoftQuotaPause({
        utilization,
        resetsAt: '2026-08-25T00:00:00.000Z',
        nowMs: now,
        record: soft,
        safeModeEngaged: true,
      });
      expect(d.action).toBe('none');
    }
  });

  it('holds a soft pause above the resume line when resetsAt is unparseable', () => {
    const d = evaluateSoftQuotaPause({
      utilization: 90,
      resetsAt: 'not-a-date',
      nowMs: now,
      record: soft,
      safeModeEngaged: true,
    });
    expect(d.action).toBe('none');
  });

  it('auto-resumes a soft pause at/below the 80% resume line', () => {
    const d = evaluateSoftQuotaPause({
      utilization: SOFT_QUOTA_RESUME_AT,
      resetsAt: '2026-08-25T00:00:00.000Z',
      nowMs: now,
      record: soft,
      safeModeEngaged: true,
    });
    expect(d.action).toBe('resume');
  });

  it('auto-resumes a soft pause once the window reset time has passed', () => {
    const d = evaluateSoftQuotaPause({
      utilization: 99,
      resetsAt: '2026-08-18T00:00:00.000Z', // in the past relative to `now`
      nowMs: now,
      record: soft,
      safeModeEngaged: true,
    });
    expect(d.action).toBe('resume');
  });

  it('never auto-resumes a human pause (sticky), even at 0% utilization', () => {
    const d = evaluateSoftQuotaPause({
      utilization: 0,
      resetsAt: '2026-08-18T00:00:00.000Z',
      nowMs: now,
      record: human,
      safeModeEngaged: true,
    });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('human pause is sticky');
  });

  it('never soft-pauses over a human pause', () => {
    const d = evaluateSoftQuotaPause({
      utilization: 99,
      resetsAt: null,
      nowMs: now,
      record: human,
      safeModeEngaged: true,
    });
    expect(d.action).toBe('none');
  });

  it('makes no decision when there is no sample (e.g. Grok default)', () => {
    const d = evaluateSoftQuotaPause({
      utilization: null,
      resetsAt: null,
      nowMs: now,
      record: null,
      safeModeEngaged: false,
    });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('no default-agent quota sample');
  });

  it('does not auto-resume a pause engaged outside the soft-quota rule', () => {
    // SAFE MODE engaged with no record — treat like a manual flip, do not lift.
    const d = evaluateSoftQuotaPause({
      utilization: 10,
      resetsAt: null,
      nowMs: now,
      record: null,
      safeModeEngaged: true,
    });
    expect(d.action).toBe('none');
  });
});
