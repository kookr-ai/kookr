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

  test('rejects malformed credit, unsupported types, and oversized controls', () => {
    for (const processed of [-1, 0.5, null, '10', Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseTerminalClientControl(JSON.stringify({ type: 'ack', generation: 'g', processed }))).toBeNull();
    }
    expect(parseTerminalClientControl('{"type":"unknown","generation":"g"}')).toBeNull();
    expect(parseTerminalClientControl(JSON.stringify({ type: 'ack', generation: 'g'.repeat(4096), processed: 1 }))).toBeNull();
    expect(parseTerminalClientControl('{')).toBeNull();
  });
});
