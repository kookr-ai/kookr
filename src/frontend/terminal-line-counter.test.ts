import { describe, expect, it } from 'vitest';
import { createTerminalLineCounter } from './terminal-line-counter.js';

describe('FR-TERM-005: inexpensive line indicators', () => {
  it('counts separators, not chunks or UTF-8 characters', () => {
    const counter = createTerminalLineCounter();
    const bytes = new TextEncoder().encode('hello 😀\r\nworld\nnext\rlast');
    expect(counter.count(bytes)).toBe(3);
    expect(counter.count(new TextEncoder().encode('spinner'))).toBe(0);
  });
  it('carries a split CR/LF pair across empty and nonempty chunks', () => {
    const counter = createTerminalLineCounter();
    expect(counter.count(Uint8Array.of(13))).toBe(1);
    expect(counter.count(new Uint8Array())).toBe(0);
    expect(counter.count(Uint8Array.of(10, 13, 13, 10))).toBe(2);
  });
  it('forgets the previous stream on reset', () => {
    const counter = createTerminalLineCounter();
    counter.count(Uint8Array.of(13));
    counter.reset();
    expect(counter.count(Uint8Array.of(10))).toBe(1);
  });
});
