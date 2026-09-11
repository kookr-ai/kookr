import { describe, expect, test } from 'vitest';
import { parseTerminalClientControl, parseTerminalServerControl, TERMINAL_V2_PROTOCOL } from './terminal-protocol.js';

describe('NFR-TERM-001: negotiated terminal protocol', () => {
  test('requires a schema-valid hello, not just an echoed subprotocol', () => {
    expect(TERMINAL_V2_PROTOCOL).toBe('kookr-terminal.v2');
    expect(parseTerminalServerControl('{"type":"hello"}')).toBeNull();
    expect(parseTerminalServerControl('{"type":"hello","version":1,"generation":"g"}')).toBeNull();
    expect(parseTerminalServerControl(JSON.stringify({
      type: 'hello', version: 2, generation: 'g', creditBytes: 131072, frameBytes: 8192,
    }))).toMatchObject({ type: 'hello', generation: 'g' });
  });

  test('typed input preserves literal JSON instead of interpreting it as control', () => {
    const text = '{"type":"resize","cols":50,"rows":10}';
    expect(parseTerminalClientControl(JSON.stringify({ type: 'input', generation: 'g', text })))
      .toEqual({ type: 'input', generation: 'g', text });
    expect(parseTerminalClientControl(text)).toBeNull();
  });

  test('accepts a multi-megabyte raw paste without exhausting the validator stack', () => {
    const base64 = Buffer.alloc(4 * 1024 * 1024, 65).toString('base64');
    expect(parseTerminalClientControl(JSON.stringify({ type: 'input-bytes', generation: 'g', base64 })))
      .toMatchObject({ type: 'input-bytes', base64 });
  });

  test('validates base64 alphabet, group length, and trailing padding', () => {
    for (const base64 of ['', 'YQ==', 'YWI=', 'YWJj', 'YWJjZA==']) {
      expect(parseTerminalClientControl(JSON.stringify({ type: 'input-bytes', generation: 'g', base64 })))
        .toMatchObject({ base64 });
    }
    for (const base64 of ['A', 'AAAAA', '====', 'A===', '=AAA', 'AA=A', 'AAA\n', 'AA_=', 'AAA ', 'AAA\u2028']) {
      expect(parseTerminalClientControl(JSON.stringify({ type: 'input-bytes', generation: 'g', base64 })))
        .toBeNull();
    }
  });

  test('rejects malformed credit, unsupported types, and oversized controls', () => {
    for (const processed of [-1, 0.5, null, '10', Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseTerminalClientControl(JSON.stringify({ type: 'ack', generation: 'g', processed }))).toBeNull();
    }
    expect(parseTerminalClientControl('{"type":"unknown","generation":"g"}')).toBeNull();
    expect(parseTerminalClientControl(JSON.stringify({ type: 'ack', generation: 'g'.repeat(4096), processed: 1 }))).toBeNull();
    expect(parseTerminalClientControl('{')).toBeNull();
  });
});
