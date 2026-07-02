import { describe, expect, it } from 'vitest';
import { decorateClaim } from './issue-claim-decorator.js';
import type { ClaimOwnerRecord } from '../core/issue-claim-types.js';
import type { AgentEvent } from '../shared/contracts/agent-events.js';

function record(overrides: Partial<ClaimOwnerRecord> = {}): ClaimOwnerRecord {
  return {
    repo: 'github.com/kookr-ai/kookr',
    number: 779,
    taskId: 'task-a',
    claimedAt: '2026-07-02T18:00:00.000Z',
    ownerStatus: 'inProgress',
    ...overrides,
  };
}

function toolUse(toolName: string, toolInput?: unknown): AgentEvent {
  return { type: 'tool_use', sessionId: 's1', toolName, toolInput };
}

function agentMessage(text: string): AgentEvent {
  return { type: 'stop', sessionId: 's1', lastMessage: text };
}

describe('decorateClaim', () => {
  it('computes ageMs from claimedAt and now()', () => {
    const now = new Date('2026-07-02T18:00:40.000Z');
    const decorated = decorateClaim(record(), { getAgentEvents: () => undefined, now: () => now });
    expect(decorated.ageMs).toBe(40_000);
  });

  it('clamps ageMs to 0 for a bad/unparseable claimedAt timestamp', () => {
    const now = new Date('2026-07-02T18:00:40.000Z');
    const decorated = decorateClaim(record({ claimedAt: 'not-a-date' }), {
      getAgentEvents: () => undefined,
      now: () => now,
    });
    expect(decorated.ageMs).toBe(0);
  });

  it('clamps ageMs to 0 when claimedAt is in the future (clock skew)', () => {
    const now = new Date('2026-07-02T18:00:00.000Z');
    const decorated = decorateClaim(record({ claimedAt: '2026-07-02T18:05:00.000Z' }), {
      getAgentEvents: () => undefined,
      now: () => now,
    });
    expect(decorated.ageMs).toBe(0);
  });

  it('leaves doing/lastActivityAt absent when the record has no sessionId', () => {
    const decorated = decorateClaim(record({ sessionId: undefined }), {
      getAgentEvents: () => {
        throw new Error('should not be called without a sessionId');
      },
    });
    expect(decorated.doing).toBeUndefined();
    expect(decorated.lastActivityAt).toBeUndefined();
    expect(decorated.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('leaves doing/lastActivityAt absent when getAgentEvents has no events for the session', () => {
    const decorated = decorateClaim(record({ sessionId: 'kookr-abc' }), {
      getAgentEvents: () => undefined,
    });
    expect(decorated.doing).toBeUndefined();
    expect(decorated.lastActivityAt).toBeUndefined();
  });

  it('leaves doing/lastActivityAt absent for an empty event array', () => {
    const decorated = decorateClaim(record({ sessionId: 'kookr-abc' }), {
      getAgentEvents: () => [],
    });
    expect(decorated.doing).toBeUndefined();
    expect(decorated.lastActivityAt).toBeUndefined();
  });

  it('derives doing from the most recent tool activity via the synchronous summarizer', () => {
    const now = new Date('2026-07-02T18:00:40.000Z');
    const events: AgentEvent[] = [
      toolUse('Read', { file_path: 'src/foo.ts' }),
      toolUse('Edit', { file_path: 'src/foo.ts' }),
    ];
    const decorated = decorateClaim(record({ sessionId: 'kookr-abc' }), {
      getAgentEvents: (sessionId) => (sessionId === 'kookr-abc' ? events : undefined),
      now: () => now,
    });
    expect(decorated.doing).toBeDefined();
    expect(decorated.doing).toContain('activity:');
    expect(decorated.lastActivityAt).toBe(now.toISOString());
  });

  it('derives doing from the most recent agent message when it is the last item', () => {
    const events: AgentEvent[] = [
      toolUse('Read', { file_path: 'src/foo.ts' }),
      agentMessage('Running the control-room test suite'),
    ];
    const decorated = decorateClaim(record({ sessionId: 'kookr-abc' }), {
      getAgentEvents: () => events,
    });
    expect(decorated.doing).toBe('agent: Running the control-room test suite');
  });

  it('never invokes an LLM/speech summary — decoration is purely synchronous', () => {
    // decorateClaim has no async signature; calling it and immediately reading
    // the result (no await, no Promise) is itself the invariant under test.
    const events: AgentEvent[] = [toolUse('Bash', { command: 'pnpm test' })];
    const result: unknown = decorateClaim(record({ sessionId: 'kookr-abc' }), {
      getAgentEvents: () => events,
    });
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('truncates an overly long doing line to a short one-liner', () => {
    const events: AgentEvent[] = [agentMessage('x'.repeat(500))];
    const decorated = decorateClaim(record({ sessionId: 'kookr-abc' }), {
      getAgentEvents: () => events,
    });
    expect(decorated.doing!.length).toBeLessThan(130);
    expect(decorated.doing!.endsWith('…')).toBe(true);
  });

  it('preserves every field from the bare ClaimOwnerRecord', () => {
    const base = record({ sessionId: 'kookr-abc', ownerName: 'batch child', worktreePath: '/wt/779' });
    const decorated = decorateClaim(base, { getAgentEvents: () => undefined });
    expect(decorated).toMatchObject(base);
  });
});
