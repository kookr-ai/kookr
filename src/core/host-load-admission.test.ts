import { describe, it, expect } from 'vitest';
import { evaluateHostLoadAdmission } from './host-load-admission.js';

describe('evaluateHostLoadAdmission', () => {
  it('admits with the gate disabled (threshold 0), regardless of load', () => {
    const decision = evaluateHostLoadAdmission({ load1m: 999, cpuCount: 4 }, 0);
    expect(decision).toEqual({ admit: true, loadPerCpu: 0, threshold: 0 });
  });

  it('admits with a negative threshold (also disabled)', () => {
    const decision = evaluateHostLoadAdmission({ load1m: 999, cpuCount: 4 }, -1);
    expect(decision.admit).toBe(true);
    expect(decision.threshold).toBe(0);
  });

  it('admits when load-per-core is below the threshold', () => {
    // 24 cores, load 12 -> 0.5 per core, threshold 0.9
    const decision = evaluateHostLoadAdmission({ load1m: 12, cpuCount: 24 }, 0.9);
    expect(decision.admit).toBe(true);
    expect(decision.loadPerCpu).toBeCloseTo(0.5, 5);
    expect(decision.threshold).toBe(0.9);
  });

  it('admits when load-per-core exactly equals the threshold (<=)', () => {
    const decision = evaluateHostLoadAdmission({ load1m: 12, cpuCount: 24 }, 0.5);
    expect(decision.admit).toBe(true);
    expect(decision.loadPerCpu).toBeCloseTo(0.5, 5);
  });

  it('rejects when load-per-core exceeds the threshold', () => {
    // 24 cores, load 40 -> ~1.67 per core, threshold 0.9
    const decision = evaluateHostLoadAdmission({ load1m: 40, cpuCount: 24 }, 0.9);
    expect(decision.admit).toBe(false);
    expect(decision.loadPerCpu).toBeCloseTo(40 / 24, 5);
    expect(decision.threshold).toBe(0.9);
  });

  it('fails open on a non-finite load sample', () => {
    expect(evaluateHostLoadAdmission({ load1m: Number.NaN, cpuCount: 4 }, 0.5).admit).toBe(true);
    expect(evaluateHostLoadAdmission({ load1m: Number.POSITIVE_INFINITY, cpuCount: 4 }, 0.5).admit).toBe(true);
  });

  it('fails open on a non-positive cpu count', () => {
    expect(evaluateHostLoadAdmission({ load1m: 40, cpuCount: 0 }, 0.5).admit).toBe(true);
    expect(evaluateHostLoadAdmission({ load1m: 40, cpuCount: -2 }, 0.5).admit).toBe(true);
  });
});
