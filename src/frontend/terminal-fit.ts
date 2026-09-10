interface Dimensions { cols: number; rows: number }

interface FitOptions {
  canFit(): boolean;
  getDimensions(): Dimensions | null | undefined;
  getCurrentDimensions(): Dimensions;
  resize(cols: number, rows: number): void;
  refresh(): void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
}

/** Shares layout work across ResizeObserver, font changes and pane reveals. */
export function createTerminalFitScheduler(options: FitOptions) {
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  let frame: number | null = null;
  let generation = 0;
  let repaint = false;
  let disposed = false;

  function fit() {
    if (disposed || !options.canFit()) return;
    const size = options.getDimensions();
    if (!size || !Number.isInteger(size.cols) || !Number.isInteger(size.rows)
      || size.cols <= 0 || size.rows <= 0 || size.cols > 1000 || size.rows > 1000) return;
    const current = options.getCurrentDimensions();
    if (current.cols !== size.cols || current.rows !== size.rows) options.resize(size.cols, size.rows);
    if (repaint) options.refresh();
    repaint = false;
  }

  return {
    request(refresh = false) {
      if (disposed) return;
      repaint ||= refresh;
      if (frame !== null) return;
      const scheduledGeneration = ++generation;
      // The placeholder also makes synchronous test schedulers safe.
      frame = -1;
      const id = requestFrame(() => {
        if (disposed || scheduledGeneration !== generation) return;
        frame = null;
        fit();
      });
      if (frame !== null) frame = id;
    },
    flush() {
      generation++;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      fit();
    },
    dispose() {
      disposed = true;
      generation++;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}
