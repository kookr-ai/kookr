import { describe, expect, test } from 'vitest';
import { ralphStopFingerprint } from './ralph-stop.js';
import type { AgentEvent } from '../core/types.js';

describe('ralphStopFingerprint', () => {
  test('uses hook line id so same-message Stops in long turns remain distinct', () => {
    const first: AgentEvent = {
      type: 'stop',
      sessionId: 'main-runtime',
      hookLineId: '100',
      lastMessage: 'done',
    };
    const second: AgentEvent = {
      type: 'stop',
      sessionId: 'main-runtime',
      hookLineId: '200',
      lastMessage: 'done',
    };

    expect(ralphStopFingerprint('agent-1', [first], first)).not.toBe(
      ralphStopFingerprint('agent-1', [second], second),
    );
  });

  test('uses turn id when the hook payload provides one', () => {
    const first: AgentEvent = {
      type: 'stop',
      sessionId: 'main-runtime',
      turnId: 'turn-1',
      hookLineId: '100',
      lastMessage: 'done',
    };
    const replay: AgentEvent = {
      ...first,
      hookLineId: '999',
    };

    expect(ralphStopFingerprint('agent-1', [first], first)).toBe(
      ralphStopFingerprint('agent-1', [replay], replay),
    );
  });
});
