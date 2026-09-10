import { describe, expect, it, vi } from 'vitest';
import { createTerminalFitScheduler } from './terminal-fit.js';

function setup() {
  const frames: Array<() => void> = [];
  const options = {
    canFit: vi.fn(() => true),
    getDimensions: vi.fn(() => ({ cols: 100, rows: 30 })),
    getCurrentDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    resize: vi.fn(), refresh: vi.fn(),
    requestFrame: (cb: () => void) => { frames.push(cb); return frames.length; },
    cancelFrame: vi.fn(),
  };
  return { options, fit: createTerminalFitScheduler(options), frame: () => frames.shift()?.(), frames };
}

describe('FR-TERM-005: frame-coalesced fitting', () => {
  it('coalesces resize, font and reveal requests into one frame', () => {
    const { fit, options, frame, frames } = setup();
    fit.request(); fit.request(true); fit.request();
    expect(frames).toHaveLength(1);
    expect(options.resize).not.toHaveBeenCalled();
    frame();
    expect(options.resize).toHaveBeenCalledExactlyOnceWith(100, 30);
    expect(options.refresh).toHaveBeenCalledOnce();
  });
  it('skips unchanged and zero geometry but can repaint a revealed screen', () => {
    const { fit, options, frame } = setup();
    options.getDimensions.mockReturnValue({ cols: 80, rows: 24 });
    fit.request(true); frame();
    expect(options.resize).not.toHaveBeenCalled();
    expect(options.refresh).toHaveBeenCalledOnce();
    options.getDimensions.mockReturnValue({ cols: 0, rows: 0 });
    fit.request(); frame();
    expect(options.resize).not.toHaveBeenCalled();
  });
  it('keeps repaint intent while hidden or awaiting a continuity decision', () => {
    const { fit, options, frame } = setup();
    options.canFit.mockReturnValue(false);
    fit.request(true); frame();
    expect(options.getDimensions).not.toHaveBeenCalled();
    options.canFit.mockReturnValue(true);
    fit.request(); frame();
    expect(options.refresh).toHaveBeenCalledOnce();
  });
  it('supports immediate initial fitting and ignores cancelled or disposed frames', () => {
    const { fit, options, frame } = setup();
    fit.request(); fit.flush();
    expect(options.resize).toHaveBeenCalledOnce();
    frame();
    expect(options.resize).toHaveBeenCalledOnce();
    fit.request(); fit.dispose(); frame();
    expect(options.resize).toHaveBeenCalledOnce();
  });
});
