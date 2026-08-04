import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIRST_HOOK_DEADLINE_MS,
  evaluateFirstHookMiss,
  type FirstHookMissEvidence,
} from './first-hook-deadline.js';

const REG = 1_000_000;

function evidence(overrides: Partial<FirstHookMissEvidence> = {}): FirstHookMissEvidence {
  return {
    registeredAt: REG,
    firstHookAt: 0,
    mcpStartupAt: 0,
    ...overrides,
  };
}

describe('evaluateFirstHookMiss (issue #2036)', () => {
  it('reaps a synthetic session with no hooks after the deadline', () => {
    const verdict = evaluateFirstHookMiss(evidence(), {
      now: REG + DEFAULT_FIRST_HOOK_DEADLINE_MS,
    });
    expect(verdict).toEqual({
      eligible: true,
      waitedMs: DEFAULT_FIRST_HOOK_DEADLINE_MS,
    });
  });

  it('leaves sessions with SessionStart / first hook within the deadline untouched', () => {
    const withHook = evaluateFirstHookMiss(
      evidence({ firstHookAt: REG + 5_000 }),
      { now: REG + DEFAULT_FIRST_HOOK_DEADLINE_MS + 60_000 },
    );
    expect(withHook).toEqual({ eligible: false, reason: 'first_hook_received' });

    const underDeadline = evaluateFirstHookMiss(evidence(), {
      now: REG + DEFAULT_FIRST_HOOK_DEADLINE_MS - 1,
    });
    expect(underDeadline).toEqual({ eligible: false, reason: 'under_deadline' });
  });

  it('respects MCP startup grace when mcp_startup_starting was observed', () => {
    const mcpAt = REG + 10_000;
    const withinGrace = evaluateFirstHookMiss(
      evidence({ mcpStartupAt: mcpAt }),
      {
        now: mcpAt + 60_000, // still inside 120s grace, past default 180s registration deadline
        deadlineMs: 30_000,
        mcpStartupGracePeriodMs: 120_000,
      },
    );
    expect(withinGrace).toEqual({ eligible: false, reason: 'mcp_startup_grace' });

    const afterGrace = evaluateFirstHookMiss(
      evidence({ mcpStartupAt: mcpAt }),
      {
        now: mcpAt + 120_000,
        deadlineMs: 30_000,
        mcpStartupGracePeriodMs: 120_000,
      },
    );
    expect(afterGrace).toEqual({ eligible: true, waitedMs: mcpAt + 120_000 - REG });
  });

  it('uses a custom deadline when provided', () => {
    const verdict = evaluateFirstHookMiss(evidence(), {
      now: REG + 45_000,
      deadlineMs: 45_000,
    });
    expect(verdict.eligible).toBe(true);
    if (verdict.eligible) expect(verdict.waitedMs).toBe(45_000);
  });
});
