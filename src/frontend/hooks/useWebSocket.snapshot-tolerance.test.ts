import { describe, expect, it } from 'vitest';
import { parseServerMessageForClient } from './useWebSocket.js';

describe('parseServerMessageForClient snapshot tolerance', () => {
  it('preserves unknown snapshot fields for additive server-message compatibility', () => {
    const parsed = parseServerMessageForClient(JSON.stringify({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      futureField: { ok: true },
    }));

    expect(parsed).toMatchObject({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      futureField: { ok: true },
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseServerMessageForClient('{not-json')).toBeNull();
  });
});
