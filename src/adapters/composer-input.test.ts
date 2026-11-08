import { describe, expect, it, vi } from 'vitest';
import { writeComposerInput } from './composer-input.js';
import { CLEAR_LINE_BYTES, ENTER_BYTES } from './keystroke.js';

function fakeWriter() {
  return {
    writeInput: vi.fn().mockResolvedValue({ sessionId: 's', readinessVersion: 0 }),
    writeInputSequence: vi.fn().mockResolvedValue({ sessionId: 's', readinessVersion: 0 }),
  };
}

describe('writeComposerInput', () => {
  it('writes clear + paste + Enter as one paced sequence', async () => {
    const writer = fakeWriter();

    await writeComposerInput(writer, 's', 'hi', 500);

    expect(writer.writeInputSequence).toHaveBeenCalledTimes(1);
    const [, payloads, meta] = writer.writeInputSequence.mock.calls[0];
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toEqual(CLEAR_LINE_BYTES);
    expect(payloads[2]).toEqual(ENTER_BYTES);
    expect(meta).toEqual({ reason: 'adapter-send-input', interPayloadDelayMs: 500 });
  });

  it('hands beforeSubmit to the writer as the in-queue pre-Enter check (issue #3513)', async () => {
    const writer = fakeWriter();
    const beforeSubmit = () => false;

    await writeComposerInput(writer, 's', 'hi', 500, { beforeSubmit });

    const [, , meta] = writer.writeInputSequence.mock.calls[0];
    expect(meta.beforeFinalPayload).toBe(beforeSubmit);
  });
});
