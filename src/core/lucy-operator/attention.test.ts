import { describe, expect, it } from 'vitest';
import { operatorAttention, permissionToolName } from './attention.js';

const live = { status: 'inProgress' as const, sessions: [{ tmuxSession: 's1' }] };

describe('permissionToolName', () => {
  it('takes the tool from both detectors\' wording', () => {
    expect(permissionToolName('Agent is blocked on permission for tool: Bash')).toBe('Bash');
    expect(permissionToolName('Agent is blocked on permission for tool: Bash and more')).toBeUndefined();
    expect(permissionToolName('Permission request pending for tool: mcp__github__create_issue')).toBe('mcp__github__create_issue');
  });

  it('quotes nothing that does not look like a tool name', () => {
    expect(permissionToolName('Agent is blocked on permission for tool: Bash(rm -rf /tmp/x)')).toBeUndefined();
    expect(permissionToolName('for tool: /home/jean/.ssh/id_rsa')).toBeUndefined();
    expect(permissionToolName(`for tool: ${'A'.repeat(65)}`)).toBeUndefined();
    expect(permissionToolName('blocked on a prompt')).toBeUndefined();
    // A finding read off the screen quotes a screen line: never matched, whatever it says.
    expect(permissionToolName('Pane shows permission dialog: "Allow for tool: Bash Deny"')).toBeUndefined();
    // A hook-derived wording whose "name" looks like a secret is not quoted either.
    expect(permissionToolName('Agent is blocked on permission for tool: ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBeUndefined();
    expect(permissionToolName(undefined)).toBeUndefined();
  });
});

describe('operatorAttention', () => {
  it('reads the finding on one of the task\'s sessions, with since when', () => {
    const at = new Date('2026-11-12T12:00:00Z');
    expect(operatorAttention(live, [{ agentId: 's1', anomaly: { type: 'permission_blocked', explanation: 'Agent is blocked on permission for tool: Bash', detectedAt: at } }]))
      .toEqual({ kind: 'permission_blocked', tool: 'Bash', sinceMs: at.getTime() });
    expect(operatorAttention(live, [{ agentId: 's1', anomaly: { type: 'needs_input', subType: 'ask_user_question' } }])).toEqual({ kind: 'asked_question' });
    expect(operatorAttention(live, [{ agentId: 's1', anomaly: { type: 'stale_agent' } }])).toEqual({ kind: 'stale_agent' });
    expect(operatorAttention(live, [{ agentId: 'other', anomaly: { type: 'stale_agent' } }])).toBeUndefined();
  });

  it('a "finished, please review" signal counts only while the task is live', () => {
    const signal = { kind: 'completion_ready', raisedAt: '2026-11-12T11:00:00Z' };
    expect(operatorAttention({ ...live, pendingSignal: signal }, [])).toEqual({ kind: 'wants_review', sinceMs: Date.parse(signal.raisedAt) });
    expect(operatorAttention({ ...live, status: 'completed', pendingSignal: signal }, [])).toBeUndefined();
  });
});
