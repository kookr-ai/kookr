import { describe, expect, test, vi } from 'vitest';
import { createTerminalAttachMetrics } from './terminal-attach-metrics.js';

function setup() {
  let now = 100;
  let render: (() => void) | undefined;
  const emit = vi.fn();
  const metrics = createTerminalAttachMetrics({
    now: () => now,
    requestFrame: (callback) => { render = callback; return 1; },
    cancelFrame: vi.fn(),
    emit,
    getMetadata: () => ({ renderer: 'dom', rendererFallback: 'automation' }),
  });
  return { metrics, emit, advance: (ms: number) => { now += ms; }, render: () => render?.() };
}

describe('FR-TERM-002: terminal attach measurements', () => {
  test('separates received, parsed, and render-opportunity times', () => {
    const h = setup();
    h.advance(10);
    h.metrics.opened();
    h.advance(20);
    h.metrics.received(4);
    h.metrics.flush();
    expect(h.emit).not.toHaveBeenCalled();
    h.advance(30);
    h.metrics.parsed();
    expect(h.emit).not.toHaveBeenCalled();
    h.advance(16);
    h.render();
    h.metrics.flush();
    expect(h.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'terminal_switch_latency', measurementVersion: 2,
      selectionToOpenMs: 10, selectionToFirstByteMs: 30,
      selectionToFirstParseMs: 60, selectionToRenderOpportunityMs: 76,
      receiveToFirstParseMs: 30, firstByteBytes: 4,
      outcome: 'render-opportunity', renderer: 'dom', rendererFallback: 'automation',
    }));
    expect(h.emit.mock.calls[0][0]).not.toHaveProperty('selectionToFirstPaintMs');
  });

  test('keeps incomplete samples and ignores late parsing and render callbacks', () => {
    const h = setup();
    h.metrics.received(20);
    h.advance(7);
    h.metrics.parsed();
    h.metrics.dispose('superseded');
    h.advance(1000);
    h.render();
    h.metrics.parsed();
    h.metrics.flush();
    expect(h.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      outcome: 'superseded', selectionToFirstParseMs: 7,
      selectionToRenderOpportunityMs: null,
    }));
  });

  test('records connections with no data and emits only once', () => {
    const h = setup();
    h.metrics.opened();
    h.metrics.dispose('disconnected');
    h.metrics.dispose('superseded');
    expect(h.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      outcome: 'disconnected', selectionToFirstByteMs: null,
      selectionToFirstParseMs: null, firstByteBytes: null,
    }));
  });

  test('does not overwrite first-byte or first-parse markers on later writes', () => {
    const h = setup();
    h.metrics.received(2);
    h.advance(1);
    h.metrics.parsed();
    h.advance(10);
    h.metrics.received(80);
    h.metrics.parsed();
    h.render();
    h.metrics.dispose('superseded');
    expect(h.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      selectionToFirstByteMs: 0, selectionToFirstParseMs: 1,
      firstByteBytes: 2, outcome: 'render-opportunity',
    }));
  });
});
