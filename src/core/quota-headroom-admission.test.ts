import { describe, it, expect } from 'vitest';
import {
  evaluateQuotaHeadroomAdmission,
  QUOTA_NO_HEADROOM_UTILIZATION,
} from './quota-headroom-admission.js';

describe('evaluateQuotaHeadroomAdmission', () => {
  it('admits when sample is null/undefined (fail-open — no live data)', () => {
    expect(evaluateQuotaHeadroomAdmission(null).admit).toBe(true);
    expect(evaluateQuotaHeadroomAdmission(undefined).admit).toBe(true);
    expect(evaluateQuotaHeadroomAdmission(null).maxUtilization).toBe(0);
  });

  it('admits when both windows are under the threshold', () => {
    const decision = evaluateQuotaHeadroomAdmission({
      fiveHour: { utilization: 40, resetsAt: '2026-08-02T12:00:00Z' },
      sevenDay: { utilization: 10, resetsAt: '2026-08-09T12:00:00Z' },
    });
    expect(decision.admit).toBe(true);
    expect(decision.maxUtilization).toBe(40);
    expect(decision.threshold).toBe(QUOTA_NO_HEADROOM_UTILIZATION);
    expect(decision.bindingWindow).toBe('fiveHour');
  });

  it('denies when five-hour utilization is at the threshold', () => {
    const decision = evaluateQuotaHeadroomAdmission({
      fiveHour: { utilization: 90, resetsAt: '2026-08-02T18:00:00Z' },
      sevenDay: { utilization: 10 },
    });
    expect(decision.admit).toBe(false);
    expect(decision.maxUtilization).toBe(90);
    expect(decision.resetsAt).toBe('2026-08-02T18:00:00Z');
    expect(decision.bindingWindow).toBe('fiveHour');
  });

  it('denies when seven-day utilization is exhausted even if five-hour is fine', () => {
    const decision = evaluateQuotaHeadroomAdmission({
      fiveHour: { utilization: 20, resetsAt: 'soon' },
      sevenDay: { utilization: 99, resetsAt: 'later' },
    });
    expect(decision.admit).toBe(false);
    expect(decision.maxUtilization).toBe(99);
    expect(decision.resetsAt).toBe('later');
    expect(decision.bindingWindow).toBe('sevenDay');
  });

  it('admits just under the threshold', () => {
    const decision = evaluateQuotaHeadroomAdmission({
      fiveHour: { utilization: 89.9 },
      sevenDay: null,
    });
    expect(decision.admit).toBe(true);
    expect(decision.maxUtilization).toBe(89.9);
  });

  it('disables the gate when threshold is non-positive', () => {
    const sample = {
      fiveHour: { utilization: 100 },
      sevenDay: null,
    };
    expect(evaluateQuotaHeadroomAdmission(sample, 0).admit).toBe(true);
    expect(evaluateQuotaHeadroomAdmission(sample, -1).admit).toBe(true);
  });

  it('ignores non-finite utilizations (fail-open on bad fields)', () => {
    const decision = evaluateQuotaHeadroomAdmission({
      fiveHour: { utilization: Number.NaN },
      sevenDay: { utilization: Number.POSITIVE_INFINITY },
    });
    expect(decision.admit).toBe(true);
    expect(decision.maxUtilization).toBe(0);
  });

  it('admits when both windows are null', () => {
    expect(
      evaluateQuotaHeadroomAdmission({ fiveHour: null, sevenDay: null }).admit,
    ).toBe(true);
  });
});
