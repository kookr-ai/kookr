import { describe, expect, it, vi } from 'vitest';
import { createTerminalScrollbackGuard } from './terminal-scrollback.js';

function harness() {
  const markers: Array<{ line: number; isDisposed: boolean; dispose(): void; onDispose(cb: () => void): { dispose(): void } }> = [];
  const active = { type: 'normal', baseY: 10, viewportY: 2, cursorY: 3 };
  const terminal = {
    buffer: { active },
    getSelectionPosition: vi.fn((): { start: { y: number }; end: { y: number } } | undefined => undefined),
    clearSelection: vi.fn(),
    registerMarker: vi.fn((offset: number) => {
      let listener = () => {};
      const marker = { line: active.baseY + active.cursorY + offset, isDisposed: false,
        dispose() { if (!marker.isDisposed) { marker.isDisposed = true; listener(); } },
        onDispose(cb: () => void) { listener = cb; return { dispose() { listener = () => {}; } }; },
      };
      markers.push(marker); return marker;
    }),
  };
  const onDiscarded = vi.fn();
  return { terminal, markers, onDiscarded, guard: createTerminalScrollbackGuard(terminal, onDiscarded) };
}

describe('FR-TERM-005: scrollback eviction', () => {
  it('tracks the viewed text and reports its eviction without scrolling to latest', () => {
    const h = harness(); h.guard.viewportChanged();
    expect(h.markers[0].line).toBe(2);
    h.markers[0].line--; h.terminal.buffer.active.viewportY--;
    h.guard.viewportChanged();
    expect(h.markers).toHaveLength(1);
    expect(h.onDiscarded).not.toHaveBeenCalled();
    h.markers[0].dispose();
    expect(h.onDiscarded).toHaveBeenCalledOnce();
    expect(h.terminal.clearSelection).not.toHaveBeenCalled();
  });
  it('clears a selection when its first line is lost, not when another line moves', () => {
    const h = harness();
    h.terminal.getSelectionPosition.mockReturnValue({ start: { y: 1 }, end: { y: 5 } });
    h.guard.selectionChanged();
    expect(h.markers[0].line).toBe(1);
    h.markers[0].dispose();
    expect(h.terminal.clearSelection).toHaveBeenCalledOnce();
    expect(h.onDiscarded).toHaveBeenCalledOnce();
  });
  it('does not report manual scrolling, reset, or disposal as lost history', () => {
    const h = harness(); h.guard.viewportChanged();
    h.terminal.buffer.active.viewportY = 4; h.guard.viewportChanged();
    h.guard.reset(); h.guard.viewportChanged(); h.guard.dispose();
    expect(h.onDiscarded).not.toHaveBeenCalled();
    expect(h.markers.every((marker) => marker.isDisposed)).toBe(true);
  });
  it('does not mark the alternate buffer or the live bottom', () => {
    const h = harness(); h.terminal.buffer.active.type = 'alternate'; h.guard.viewportChanged();
    h.terminal.buffer.active.type = 'normal'; h.terminal.buffer.active.viewportY = 10; h.guard.viewportChanged();
    expect(h.markers).toHaveLength(0);
  });
});
