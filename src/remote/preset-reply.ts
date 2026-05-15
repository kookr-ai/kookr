import type { AgentAdapter } from '../adapters/agent-adapter.js';

export type PresetReplyId = 'continue' | 'yes' | 'no' | 'skip';

export const PRESET_REPLY_TEXT: Readonly<Record<PresetReplyId, string>> = {
  continue: 'continue',
  yes: 'yes',
  no: 'no',
  skip: 'skip',
};

export function isPresetReplyId(value: unknown): value is PresetReplyId {
  return value === 'continue' || value === 'yes' || value === 'no' || value === 'skip';
}

export async function sendPresetReply(
  adapter: Pick<AgentAdapter, 'sendInput'>,
  sessionId: string,
  presetId: PresetReplyId,
): Promise<{ text: string }> {
  const text = PRESET_REPLY_TEXT[presetId];
  await adapter.sendInput(sessionId, text);
  return { text };
}
