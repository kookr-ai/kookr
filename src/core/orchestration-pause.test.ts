import { describe, it, expect } from 'vitest';

import type { QuotaStatus } from './quota-types.js';
import {
  ORCHESTRATION_PAUSE_REL_PATH,
  SOFT_QUOTA_PAUSE_AT,
  SOFT_QUOTA_RESUME_AT,
  buildPauseRecord,
  evaluateSoftQuotaPause,
  isOrchestrationPaused,
  orchestratorShouldSpawn,
  parsePauseRecord,
  pauseRecordCreatedByKillSwitch,
  resolveDefaultAgentQuotaSample,
  resolveOrchestrationPausePath,
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
    expect(rec!.schemaVersion).toBe(2);
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
  it('builds a v2 record with the given fields', () => {
    const rec = buildPauseRecord({
      source: 'human',
      reason: 'quota reset window',
      by: 'jean',
      atIso: '2026-08-19T00:00:00.000Z',
    });
    expect(rec).toEqual<OrchestrationPauseRecord>({
      schemaVersion: 2,
      paused: true,
      source: 'human',
      reason: 'quota reset window',
      pausedAt: '2026-08-19T00:00:00.000Z',
      pausedBy: 'jean',
      mechanism: 'automationKillSwitch',
    });
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

  it('is paused when the record says paused even without SAFE MODE', () => {
    // Leftover paused records still gate spawn until they are cleared. The
    // settings path that turns the kill switch off must therefore delete
    // kill-switch-created records (issue #2743); this predicate stays OR-based
    // so an uncleared file cannot be ignored.
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
