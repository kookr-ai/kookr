import { describe, expect, it } from 'vitest';
import {
  describeLaunchQuotaWarning,
  formatQuotaResetPhrase,
  selectionMayLaunchClaudeCode,
  QUOTA_STATUS_STALE_MS,
} from './launch-quota-warning.js';
import { QUOTA_NO_HEADROOM_UTILIZATION } from './quota-headroom-admission.js';
import type { AgentType } from '../shared/contracts/agent-types.js';

const ALL: readonly AgentType[] = ['claude-code', 'codex-cli', 'grok-build'];
const NOW = Date.parse('2026-08-17T12:00:00.000Z');

function quota(overrides: {
  fiveHour?: { utilization: number; resetsAt?: string } | null;
  sevenDay?: { utilization: number; resetsAt?: string } | null;
  updatedAt?: number;
} = {}) {
  return {
    fiveHour: overrides.fiveHour === undefined
      ? { utilization: 92, resetsAt: '2026-08-17T14:00:00.000Z' }
      : overrides.fiveHour,
    sevenDay: overrides.sevenDay === undefined
      ? { utilization: 10, resetsAt: '2026-08-20T12:00:00.000Z' }
      : overrides.sevenDay,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

describe('selectionMayLaunchClaudeCode', () => {
  it('is true for an explicit Claude Code pick', () => {
    expect(selectionMayLaunchClaudeCode('claude-code', ALL, 2)).toBe(true);
  });

  it('is true for round-robin only when the next pick is Claude Code', () => {
    expect(selectionMayLaunchClaudeCode('round-robin', ALL, 0)).toBe(true);
    expect(selectionMayLaunchClaudeCode('round-robin', ALL, 1)).toBe(false);
  });

  it('is false when the picker cannot land on Claude Code', () => {
    expect(selectionMayLaunchClaudeCode('codex-cli', ALL, 0)).toBe(false);
    expect(selectionMayLaunchClaudeCode('grok-build', ALL, 0)).toBe(false);
    expect(selectionMayLaunchClaudeCode('round-robin', ['codex-cli', 'grok-build'], 0)).toBe(false);
  });
});

describe('describeLaunchQuotaWarning', () => {
  it('warns when five-hour utilization is at the configured threshold', () => {
    const warning = describeLaunchQuotaWarning({
      selection: 'claude-code',
      available: ALL,
      quota: quota({
        fiveHour: { utilization: 90, resetsAt: '2026-08-17T14:00:00.000Z' },
      }),
      threshold: QUOTA_NO_HEADROOM_UTILIZATION,
      nowMs: NOW,
    });
    expect(warning).not.toBeNull();
    expect(warning?.bindingWindow).toBe('fiveHour');
    expect(warning?.utilization).toBe(90);
    expect(warning?.message).toContain('90%');
    expect(warning?.message).toContain('5-hour');
    expect(warning?.message).toContain('resets in 2h');
    expect(warning?.message).toContain('configured fallback');
    expect(warning?.stale).toBe(false);
  });

  it('names the 7-day window when that window is the one that binds', () => {
    const warning = describeLaunchQuotaWarning({
      selection: 'claude-code',
      available: ALL,
      quota: quota({
        fiveHour: { utilization: 20, resetsAt: '2026-08-17T14:00:00.000Z' },
        sevenDay: { utilization: 99, resetsAt: '2026-08-20T12:00:00.000Z' },
      }),
      nowMs: NOW,
    });
    expect(warning?.bindingWindow).toBe('sevenDay');
    expect(warning?.message).toContain('99%');
    expect(warning?.message).toContain('7-day');
    expect(warning?.message).toContain('resets in 3d');
  });

  it('warns for round-robin when the next pick is Claude Code', () => {
    const warning = describeLaunchQuotaWarning({
      selection: 'round-robin',
      available: ALL,
      roundRobinIndex: 0,
      quota: quota(),
      nowMs: NOW,
    });
    expect(warning).not.toBeNull();
  });

  it('is hidden when the evaluator would admit', () => {
    expect(describeLaunchQuotaWarning({
      selection: 'claude-code',
      available: ALL,
      quota: quota({
        fiveHour: { utilization: 89.9 },
        sevenDay: { utilization: 10 },
      }),
      nowMs: NOW,
    })).toBeNull();
  });

  it('is hidden when quota data is missing', () => {
    expect(describeLaunchQuotaWarning({
      selection: 'claude-code',
      available: ALL,
      quota: null,
      nowMs: NOW,
    })).toBeNull();
    expect(describeLaunchQuotaWarning({
      selection: 'claude-code',
      available: ALL,
      quota: undefined,
      nowMs: NOW,
    })).toBeNull();
  });

  it('is hidden when the chosen agent cannot be Claude Code', () => {
    expect(describeLaunchQuotaWarning({
      selection: 'codex-cli',
      available: ALL,
      quota: quota(),
      nowMs: NOW,
    })).toBeNull();
    expect(describeLaunchQuotaWarning({
      selection: 'round-robin',
      available: ALL,
      roundRobinIndex: 1,
      quota: quota(),
      nowMs: NOW,
    })).toBeNull();
  });

  it('is hidden when the threshold disables the gate', () => {
    expect(describeLaunchQuotaWarning({
      selection: 'claude-code',
      available: ALL,
      quota: quota({ fiveHour: { utilization: 100 } }),
      threshold: 0,
      nowMs: NOW,
    })).toBeNull();
  });

  it('mentions staleness when the sample is older than five minutes', () => {
    const warning = describeLaunchQuotaWarning({
      selection: 'claude-code',
      available: ALL,
      quota: quota({ updatedAt: NOW - QUOTA_STATUS_STALE_MS - 60_000 }),
      nowMs: NOW,
    });
    expect(warning?.stale).toBe(true);
    expect(warning?.message).toContain('6 minutes old');
  });
});

describe('formatQuotaResetPhrase', () => {
  it('returns null for an unparseable timestamp', () => {
    expect(formatQuotaResetPhrase('later', NOW)).toBeNull();
  });
});
