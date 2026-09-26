import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';

describe('microphone worklet final audio drain', () => {
  function createProcessor() {
    const messages: unknown[] = [];
    let Processor!: new () => { process: (inputs: Float32Array[][]) => boolean; port: { onmessage?: (event: { data: unknown }) => void } };
    runInNewContext(readFileSync('src/frontend/public/pcm-processor.js', 'utf8'), {
      Float32Array,
      AudioWorkletProcessor: class { port = { postMessage: (message: unknown) => messages.push(message) }; },
      registerProcessor: (_name: string, processor: typeof Processor) => { Processor = processor; },
    });
    return { processor: new Processor(), messages };
  }

  test('delivers the short final audio buffer before acknowledging stop exactly once', () => {
    const { processor, messages } = createProcessor();
    const samples = Float32Array.from({ length: 513 }, (_, index) => index / 1000);
    processor.process([[samples]]);
    expect(messages).toEqual([]);
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(messages).toEqual([samples, { type: 'flushed' }]);
    processor.process([[new Float32Array(128).fill(0.5)]]);
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(messages).toHaveLength(2);
  });

  test('preserves the full sample sequence across a full buffer and final remainder', () => {
    const { processor, messages } = createProcessor();
    const samples = Float32Array.from({ length: 4_601 }, (_, index) => index / 10_000);
    for (let offset = 0; offset < samples.length; offset += 128) processor.process([[samples.slice(offset, offset + 128)]]);
    processor.port.onmessage?.({ data: { type: 'flush' } });
    const received = messages.filter((message): message is Float32Array => message instanceof Float32Array);
    expect(received.map(chunk => chunk.length)).toEqual([4096, 505]);
    expect(Array.from(received[0]).concat(Array.from(received[1]))).toEqual(Array.from(samples));
    expect(messages.at(-1)).toEqual({ type: 'flushed' });
  });
});
