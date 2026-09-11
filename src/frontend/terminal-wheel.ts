/** Preserve trackpad movement while keeping wheel events out of agent input. */
interface WheelViewport {
  rows: number;
  viewportY: number;
  baseY: number;
}

interface WheelScrollerOptions {
  getViewport(): WheelViewport;
  scrollLines(lines: number): void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

export interface TerminalWheelScroller {
  handleWheel(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): void;
  reset(): void;
  dispose(): void;
}

/** Keep the existing wheel scale; unlike per-event rounding, no fraction is lost. */
const PIXELS_PER_LINE = 40;

export function createTerminalWheelScroller(options: WheelScrollerOptions): TerminalWheelScroller {
  const requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  let pendingLines = 0;
  let frame: number | null = null;
  let generation = 0;
  let disposed = false;

  function clampToViewport(viewport: WheelViewport): void {
    // Include not-yet-applied movement, so reversing within one frame remains
    // symmetric even at a boundary. Pressure beyond retained history is lost.
    pendingLines = Math.max(-viewport.viewportY, Math.min(viewport.baseY - viewport.viewportY, pendingLines));
  }

  function reset(): void {
    generation++;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    pendingLines = 0;
  }

  return {
    handleWheel({ deltaY, deltaMode }) {
      if (disposed || !Number.isFinite(deltaY) || deltaY === 0) return;
      const viewport = options.getViewport();
      if (viewport.rows <= 0) { reset(); return; }
      const lines = deltaMode === 0 ? deltaY / PIXELS_PER_LINE
        : deltaMode === 1 ? deltaY
          : deltaMode === 2 ? deltaY * viewport.rows : 0;
      if (!Number.isFinite(lines) || lines === 0) return;
      pendingLines += lines;
      clampToViewport(viewport);
      if (frame !== null || pendingLines === 0) return;
      const scheduledGeneration = generation;
      frame = requestFrame(() => {
        if (disposed || scheduledGeneration !== generation) return;
        frame = null;
        const current = options.getViewport();
        if (current.rows <= 0) { reset(); return; }
        clampToViewport(current);
        const wholeLines = Math.trunc(pendingLines);
        pendingLines -= wholeLines;
        if (wholeLines !== 0) options.scrollLines(wholeLines);
        clampToViewport(options.getViewport());
      });
    },
    reset,
    dispose() { reset(); disposed = true; },
  };
}
