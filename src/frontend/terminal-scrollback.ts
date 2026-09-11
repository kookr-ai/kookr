interface Marker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
  onDispose(callback: () => void): { dispose(): void };
}
interface ScrollbackTerminal {
  buffer: { active: { type: string; baseY: number; viewportY: number; cursorY: number } };
  registerMarker(offset: number): Marker | undefined;
  getSelectionPosition(): { start: { y: number }; end: { y: number } } | undefined;
  clearSelection(): void;
}

/**
 * xterm already anchors scrolling while its ring trims. Public line markers tell
 * us when that anchor or a selection is lost, without copying screen contents.
 */
export function createTerminalScrollbackGuard(terminal: ScrollbackTerminal, onDiscarded: () => void) {
  let viewport: Marker | undefined;
  let selection: Marker | undefined;
  let disposed = false;

  function clear(kind: 'viewport' | 'selection') {
    const marker = kind === 'viewport' ? viewport : selection;
    if (kind === 'viewport') viewport = undefined;
    else selection = undefined;
    // Disposing our own marker is not evidence that xterm discarded its line.
    marker?.dispose();
  }

  function mark(kind: 'viewport' | 'selection', line: number | undefined) {
    if (disposed) return;
    const current = kind === 'viewport' ? viewport : selection;
    if (line !== undefined && current && !current.isDisposed && current.line === line) return;
    clear(kind);
    if (line === undefined || terminal.buffer.active.type !== 'normal') return;
    const buffer = terminal.buffer.active;
    const marker = terminal.registerMarker(line - buffer.baseY - buffer.cursorY);
    if (!marker) return;
    if (kind === 'viewport') viewport = marker;
    else selection = marker;
    marker.onDispose(() => {
      if (disposed || (kind === 'viewport' ? viewport : selection) !== marker) return;
      if (kind === 'viewport') viewport = undefined;
      else {
        selection = undefined;
        // xterm otherwise clips a partially evicted selection. Clear it so
        // copying cannot silently return only a suffix of the selected text.
        terminal.clearSelection();
      }
      onDiscarded();
    });
  }

  function reset() { clear('viewport'); clear('selection'); }
  return {
    viewportChanged() {
      const buffer = terminal.buffer.active;
      mark('viewport', buffer.viewportY < buffer.baseY ? buffer.viewportY : undefined);
    },
    selectionChanged() {
      const range = terminal.getSelectionPosition();
      mark('selection', range ? Math.min(range.start.y, range.end.y) : undefined);
    },
    reset,
    dispose() { disposed = true; reset(); },
  };
}
