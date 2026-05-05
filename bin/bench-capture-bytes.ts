import { performance } from 'node:perf_hooks';

const RING_BUFFER_BYTES = 1 * 1024 * 1024;
const ITERATIONS = 1_000;
const APPEND_BYTES = 64 * 1024;

interface RingState {
  head: number;
  buffer: Buffer;
}

function fillWrappedRing(): RingState {
  const head = RING_BUFFER_BYTES + Math.floor(RING_BUFFER_BYTES / 2) + 7;
  const buffer = Buffer.alloc(RING_BUFFER_BYTES);
  for (let logical = head - RING_BUFFER_BYTES; logical < head; logical += 1) {
    buffer[logical % RING_BUFFER_BYTES] = logical & 0xff;
  }
  return { head, buffer };
}

function capturePerByte(state: RingState): Buffer {
  const size = Math.min(state.head, RING_BUFFER_BYTES);
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    const logical = state.head - size + i;
    out[i] = state.buffer[logical % RING_BUFFER_BYTES];
  }
  return out;
}

function captureSplitCopy(state: RingState): Buffer {
  const size = Math.min(state.head, RING_BUFFER_BYTES);
  const out = Buffer.alloc(size);
  const firstLogical = state.head - size;
  const startSlot = firstLogical % RING_BUFFER_BYTES;
  const tail = Math.min(size, RING_BUFFER_BYTES - startSlot);
  state.buffer.copy(out, 0, startSlot, startSlot + tail);
  if (tail < size) {
    state.buffer.copy(out, tail, 0, size - tail);
  }
  return out;
}

function appendPerByte(state: RingState, source: Buffer): void {
  for (let i = 0; i < source.length; i += 1) {
    state.buffer[state.head % RING_BUFFER_BYTES] = source[i];
    state.head += 1;
  }
}

function appendSplitCopy(state: RingState, source: Buffer): void {
  let retained = source;
  let firstLogical = state.head;
  if (source.length > RING_BUFFER_BYTES) {
    retained = source.subarray(source.length - RING_BUFFER_BYTES);
    firstLogical += source.length - RING_BUFFER_BYTES;
  }

  const startSlot = firstLogical % RING_BUFFER_BYTES;
  const tail = Math.min(retained.length, RING_BUFFER_BYTES - startSlot);
  retained.copy(state.buffer, startSlot, 0, tail);
  if (tail < retained.length) {
    retained.copy(state.buffer, 0, tail);
  }
  state.head += source.length;
}

function time(label: string, fn: () => void): number {
  for (let i = 0; i < 25; i += 1) fn();
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) fn();
  const elapsed = performance.now() - start;
  console.log(`${label}: ${elapsed.toFixed(1)} ms (${(elapsed / ITERATIONS).toFixed(3)} ms/op)`);
  return elapsed;
}

const captureState = fillWrappedRing();
const legacyCapture = capturePerByte(captureState);
const splitCapture = captureSplitCopy(captureState);
if (!legacyCapture.equals(splitCapture)) {
  throw new Error('capture implementations produced different bytes');
}

const appendSource = Buffer.alloc(APPEND_BYTES, 0x5a);
const legacyAppendState = fillWrappedRing();
const splitAppendState = fillWrappedRing();
appendPerByte(legacyAppendState, appendSource);
appendSplitCopy(splitAppendState, appendSource);
if (
  legacyAppendState.head !== splitAppendState.head ||
  !legacyAppendState.buffer.equals(splitAppendState.buffer)
) {
  throw new Error('append implementations produced different ring state');
}

console.log(`capture: ${ITERATIONS} x ${RING_BUFFER_BYTES} B from wrapped ring`);
const captureLegacyMs = time('legacy per-byte capture', () => {
  capturePerByte(captureState);
});
const captureSplitMs = time('split Buffer.copy capture', () => {
  captureSplitCopy(captureState);
});
console.log(`capture speedup: ${(captureLegacyMs / captureSplitMs).toFixed(1)}x`);

console.log(`append: ${ITERATIONS} x ${APPEND_BYTES} B into wrapped ring`);
const appendLegacyState = fillWrappedRing();
const appendLegacyMs = time('legacy per-byte append', () => {
  appendPerByte(appendLegacyState, appendSource);
});
const appendSplitState = fillWrappedRing();
const appendSplitMs = time('split Buffer.copy append', () => {
  appendSplitCopy(appendSplitState, appendSource);
});
console.log(`append speedup: ${(appendLegacyMs / appendSplitMs).toFixed(1)}x`);
