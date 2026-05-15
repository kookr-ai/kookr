import { describe, expect, it } from 'vitest';

import { PRESET_REPLY_TEXT, isPresetReplyId, sendPresetReply } from '../preset-reply.js';

describe('preset replies', () => {
  it('exports the canonical client-preview mapping', () => {
    expect(PRESET_REPLY_TEXT).toEqual({
      continue: 'continue',
      yes: 'yes',
      no: 'no',
      skip: 'skip',
    });
    expect(isPresetReplyId('continue')).toBe(true);
    expect(isPresetReplyId('later')).toBe(false);
  });

  it('sends the canonical preset text to the requested session', async () => {
    const sent: Array<{ sessionId: string; text: string }> = [];
    const adapter = {
      sendInput: async (sessionId: string, text: string) => {
        sent.push({ sessionId, text });
      },
    };

    await expect(sendPresetReply(adapter, 'session-1', 'yes')).resolves.toEqual({ text: 'yes' });
    expect(sent).toEqual([{ sessionId: 'session-1', text: PRESET_REPLY_TEXT.yes }]);
  });
});
