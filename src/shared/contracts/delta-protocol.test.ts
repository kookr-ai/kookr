import { describe, expect, test } from 'vitest';

import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  type ClientMessage,
  type DeltaMessage,
  type ServerMessage,
  type SnapshotMessage,
} from './messages.js';
import { ClientMessageSchema } from './client-message-schema.js';
import { ServerMessageSchema } from './server-message-schema.js';

describe('delta protocol contract (#1754 Stage 1)', () => {
  test('the new message types are registered in the exhaustive type arrays', () => {
    expect(SERVER_MESSAGE_TYPES).toContain('delta');
    expect(CLIENT_MESSAGE_TYPES).toContain('requestResync');
  });

  test('SnapshotMessage carries optional (epoch, seq) that validate', () => {
    const snap: SnapshotMessage = {
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      epoch: '2026-08-01T00:00:00.000Z',
      seq: 7,
    };
    const result = ServerMessageSchema.safeParse(snap);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type === 'snapshot' && result.data.seq).toBe(7);
    }
  });

  test('a snapshot without (epoch, seq) still validates (backward compatible)', () => {
    const legacy: SnapshotMessage = { type: 'snapshot', agents: [], serverCwd: '/repo' };
    expect(ServerMessageSchema.safeParse(legacy).success).toBe(true);
  });

  test('a delta envelope validates against the server schema', () => {
    const delta: DeltaMessage = {
      type: 'delta',
      epoch: '2026-08-01T00:00:00.000Z',
      seq: 12,
      agents: { upserts: [], removed: ['a1:t1'] },
      taskRelations: [],
      aggregates: { totalSpendUsd: 3 },
    };
    // Round-trips through the union too (via the ServerMessage type).
    const asServer: ServerMessage = delta;
    expect(ServerMessageSchema.safeParse(asServer).success).toBe(true);
  });

  test('a delta requires epoch and seq', () => {
    expect(ServerMessageSchema.safeParse({ type: 'delta' }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: 'delta', epoch: 'e' }).success).toBe(false);
  });

  describe('requestResync client message', () => {
    test('accepts every valid reason', () => {
      for (const reason of ['seq_gap', 'epoch_change', 'apply_error'] as const) {
        const msg: ClientMessage = { type: 'requestResync', reason, haveSeq: 4 };
        expect(ClientMessageSchema.safeParse(msg).success).toBe(true);
      }
    });

    test('rejects an unknown reason', () => {
      const result = ClientMessageSchema.safeParse({ type: 'requestResync', reason: 'because', haveSeq: 0 });
      expect(result.success).toBe(false);
    });

    test('rejects a non-numeric haveSeq', () => {
      const result = ClientMessageSchema.safeParse({ type: 'requestResync', reason: 'seq_gap', haveSeq: 'x' });
      expect(result.success).toBe(false);
    });
  });
});
