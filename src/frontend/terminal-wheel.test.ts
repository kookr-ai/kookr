import { describe, expect, it, vi } from 'vitest';
import { createTerminalWheelScroller } from './terminal-wheel.js';

function fixture() {
  const viewport = { rows: 24, viewportY: 50, baseY: 100 };
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const scrollLines = vi.fn((lines: number) => {
    viewport.viewportY = Math.max(0, Math.min(viewport.baseY, viewport.viewportY + lines));
  });
  const wheel = createTerminalWheelScroller({
    getViewport: () => viewport,
    scrollLines,
    requestFrame: (cb) => { frames.set(++nextId, cb); return nextId; },
    cancelFrame: (id) => { frames.delete(id); },
  });
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((cb) => cb(0));
  };
  const move = (deltaY: number, deltaMode = 0) => wheel.handleWheel({ deltaY, deltaMode });
  return { viewport, frames, scrollLines, wheel, flush, move };
}

describe('FR-TERM-001: responsive terminal wheel scrolling', () => {
  it.each([1, -1])('preserves eight five-pixel movements in direction %s', (sign) => {
    const f = fixture();
    for (let i = 0; i < 8; i++) f.move(sign * 5);
    expect(f.scrollLines).not.toHaveBeenCalled();
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.scrollLines).toHaveBeenCalledExactlyOnceWith(sign);
  });

  it('retains fractional movement across frames', () => {
    const f = fixture();
    f.move(15); f.flush();
    f.move(15); f.flush();
    expect(f.scrollLines).not.toHaveBeenCalled();
    f.move(15); f.flush();
    expect(f.scrollLines).toHaveBeenLastCalledWith(1);
    f.move(35); f.flush();
    expect(f.scrollLines).toHaveBeenCalledTimes(2);
  });

  it('normalizes line and page units before accumulating', () => {
    const f = fixture();
    f.move(3, 1); f.move(1, 2); f.flush();
    expect(f.scrollLines).toHaveBeenCalledExactlyOnceWith(27);
    f.viewport.rows = 10;
    f.move(-1, 2); f.flush();
    expect(f.scrollLines).toHaveBeenLastCalledWith(-10);
  });

  it('preserves signed movement when direction reverses within a frame', () => {
    const f = fixture();
    f.move(100); f.move(-60); f.flush();
    expect(f.scrollLines).toHaveBeenCalledExactlyOnceWith(1);
    f.move(-20); f.flush();
    expect(f.scrollLines).toHaveBeenCalledTimes(1);
    f.move(-20); f.flush();
    expect(f.scrollLines).toHaveBeenLastCalledWith(-1);
  });

  it.each([0, 100])('discards overscroll at boundary %s before reversing', (boundary) => {
    const f = fixture();
    f.viewport.viewportY = boundary;
    const out = boundary === 0 ? -1 : 1;
    f.move(out * 10_000);
    f.move(-out * 40);
    f.flush();
    expect(f.scrollLines).toHaveBeenCalledExactlyOnceWith(-out);
  });

  it('clears leftover pressure after a movement hits the boundary', () => {
    const f = fixture();
    f.viewport.viewportY = 99;
    f.move(10_020); f.flush();
    f.move(-40); f.flush();
    expect(f.viewport.viewportY).toBe(99);
    expect(f.scrollLines).toHaveBeenLastCalledWith(-1);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'ignores invalid or horizontal-only delta %s', (delta) => {
      const f = fixture(); f.move(delta); f.flush();
      expect(f.scrollLines).not.toHaveBeenCalled();
      expect(f.frames.size).toBe(0);
    },
  );

  it('ignores invalid modes and zero-size terminals', () => {
    const f = fixture();
    f.move(80, 99);
    f.viewport.rows = 0;
    f.move(80); f.move(1, 2); f.flush();
    expect(f.scrollLines).not.toHaveBeenCalled();
  });

  it('cancels pending frames and fractional state on reset, including stale callbacks', () => {
    const f = fixture();
    f.move(60);
    const stale = [...f.frames.values()][0]!;
    f.wheel.reset();
    expect(f.frames.size).toBe(0);
    f.move(20);
    stale(0);
    expect(f.scrollLines).not.toHaveBeenCalled();
    f.flush();
    expect(f.scrollLines).not.toHaveBeenCalled();
    f.move(20); f.flush();
    expect(f.scrollLines).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not schedule or scroll after disposal', () => {
    const f = fixture();
    f.move(80);
    f.wheel.dispose();
    f.move(80); f.flush();
    expect(f.frames.size).toBe(0);
    expect(f.scrollLines).not.toHaveBeenCalled();
  });
});
