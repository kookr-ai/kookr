/**
 * Unit tests for the terminal paste-routing helpers (kookr #356).
 *
 * These pin the frontend decision logic that TerminalPanel uses to split a
 * browser paste into the safe (structured WS frame) path vs the raw,
 * byte-transparent path.
 */
import { describe, expect, it } from 'vitest';
import { isMultilinePaste, buildPasteFrame } from './terminal-paste.js';

describe('isMultilinePaste', () => {
  it('is false for single-line text — stays on the raw, byte-transparent path', () => {
    expect(isMultilinePaste('npm run build')).toBe(false);
    expect(isMultilinePaste('')).toBe(false);
    // Length alone does not trigger the safe path: a single line, however
    // long, still submits exactly one prompt.
    expect(isMultilinePaste('a'.repeat(5000))).toBe(false);
  });

  it('is true for text containing a line feed', () => {
    expect(isMultilinePaste('line1\nline2')).toBe(true);
  });

  it('is true for text containing a carriage return or CRLF', () => {
    expect(isMultilinePaste('line1\rline2')).toBe(true);
    expect(isMultilinePaste('line1\r\nline2')).toBe(true);
  });

  it('is true for a single line with a trailing newline', () => {
    // Pasted raw, the trailing newline alone would submit the line.
    expect(isMultilinePaste('one line\n')).toBe(true);
  });

  it('is true for multiline JSON (the issue-356 repro shape)', () => {
    const json = '{\n  "lighthouseVersion": "13.0.2",\n  "details": {}\n}';
    expect(isMultilinePaste(json)).toBe(true);
  });
});

describe('buildPasteFrame', () => {
  it('builds a parseable paste control frame', () => {
    expect(JSON.parse(buildPasteFrame('a\nb'))).toEqual({ type: 'paste', text: 'a\nb' });
  });

  it('round-trips multiline JSON content without corruption', () => {
    const json = '{\n  "lighthouseVersion": "13.0.2",\n  "items": []\n}';
    expect(JSON.parse(buildPasteFrame(json)).text).toBe(json);
  });

  it('escapes embedded quotes and braces so the frame stays valid JSON', () => {
    const tricky = '{"nested":"value"}\n["array"]';
    expect(JSON.parse(buildPasteFrame(tricky)).text).toBe(tricky);
  });
});
