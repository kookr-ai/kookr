type AttachEndReason = 'superseded' | 'disconnected';

interface AttachMetricsOptions {
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  getMetadata(): Record<string, unknown>;
  emit(event: { type: 'terminal_switch_latency'; [key: string]: unknown }): void;
}

/** One connection's client-clock milestones, including incomplete attaches. */
export function createTerminalAttachMetrics(options: AttachMetricsOptions) {
  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const startedAt = now();
  let openedAt: number | null = null;
  let receivedAt: number | null = null;
  let parsedAt: number | null = null;
  let renderAt: number | null = null;
  let firstByteBytes: number | null = null;
  let frame: number | null = null;
  let disposed = false;
  let emitted = false;
  let flushRequested = false;

  function elapsed(end: number | null, start: number | null = startedAt) {
    return end === null || start === null ? null : Math.round((end - start) * 100) / 100;
  }

  function emit(reason?: AttachEndReason) {
    if (emitted || (renderAt === null && !reason)) return;
    emitted = true;
    options.emit({
      ...options.getMetadata(),
      type: 'terminal_switch_latency',
      measurementVersion: 2,
      selectionToOpenMs: elapsed(openedAt),
      selectionToFirstByteMs: elapsed(receivedAt),
      selectionToFirstParseMs: elapsed(parsedAt),
      selectionToRenderOpportunityMs: elapsed(renderAt),
      receiveToFirstParseMs: elapsed(parsedAt, receivedAt),
      openToFirstByteMs: elapsed(receivedAt, openedAt),
      firstByteBytes,
      outcome: renderAt !== null ? 'render-opportunity' : reason,
    });
  }

  return {
    opened() { if (!disposed && openedAt === null) openedAt = now(); },
    received(bytes: number) {
      if (disposed || receivedAt !== null) return;
      receivedAt = now();
      firstByteBytes = bytes;
    },
    parsed() {
      if (disposed || parsedAt !== null) return;
      parsedAt = now();
      // This is a browser scheduling opportunity after parsing, not a GPU
      // completion signal. Non-visual control sequences need no onRender event.
      frame = requestFrame(() => {
        frame = null;
        if (disposed) return;
        renderAt = now();
        if (flushRequested) emit();
      });
    },
    flush() {
      if (disposed) return;
      flushRequested = true;
      emit();
    },
    dispose(reason: AttachEndReason) {
      if (disposed) return;
      disposed = true;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      emit(reason);
    },
  };
}
