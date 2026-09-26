import { expect, test, vi } from 'vitest';
import { BrowserCorpusCapture } from './browser-corpus.js';

test('omits oversized recordings entirely and can capture the next recording', () => {
  const writer = { enabled: true, write: vi.fn().mockResolvedValue(null) };
  const capture = new BrowserCorpusCapture(writer, { name: 'qwen' }, {}, { warn: vi.fn() });
  capture.append(Buffer.alloc(16000 * 2 * 300));
  capture.append(Buffer.alloc(2));
  capture.finish('Whole transcript', 'fr');
  expect(writer.write).not.toHaveBeenCalled();
  capture.append(Buffer.from([0, 1]));
  capture.finish('Next recording', 'fr');
  expect(writer.write).toHaveBeenCalledOnce();
  expect(writer.write.mock.calls[0][0].audio.subarray(44)).toEqual(Buffer.from([0, 1]));
});

test('late inference from a discarded recording cannot supply new-recording provenance', async () => {
  let resolve;
  const writer = { enabled: true, write: vi.fn().mockResolvedValue(null) };
  const backend = { name: 'qwen', transcribe: () => new Promise((done) => { resolve = done; }) };
  const capture = new BrowserCorpusCapture(writer, backend, {});
  capture.append(Buffer.alloc(2));
  const old = capture.transcribe(new Float32Array(1), { language: 'en' });
  capture.discard();
  capture.append(Buffer.alloc(2));
  resolve({ text: 'Old text', recognition: { vocabulary: 'old' } });
  await old;
  capture.finish('', 'fr');
  expect(writer.write.mock.calls[0][0].metadata.model.recognition).toBeNull();
});
