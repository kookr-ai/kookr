import React, { useRef, useEffect, useCallback } from 'react';
import {
  MIN_BOTTOM_SECTIONS_HEIGHT,
  clampBottomSectionsHeight,
} from '../../store/bottom-sections-height-prefs.js';
import { maxBottomSectionsHeightFor } from './shared.js';

/**
 * Drag handle that sets the height of the `.bottom-sections` scroll box so the
 * user can grow the Healthy/Pending/Completed area (to see more at once) or
 * shrink it (to give the findings list more room), replacing the old fixed
 * `max-height: 30%` cap. Dragging up grows the area; the height is clamped to
 * the live panel height (keeping the findings list usable) and, on release,
 * persisted so it survives reloads. Mirrors the findings-panel width resizer.
 */
export function BottomSectionsResizer({
  panelRef,
  getHeight,
  onResize,
  onCommit,
  onReset,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  getHeight: () => number;
  onResize: (height: number) => void;
  onCommit: (height: number) => void;
  /** Double-click / Escape: drop the explicit height and revert to the CSS default. */
  onReset: () => void;
}): React.ReactElement {
  const dragCleanup = useRef<(() => void) | null>(null);

  const maxAvailable = useCallback((): number => maxBottomSectionsHeightFor(panelRef.current), [panelRef]);

  // Tear down any in-flight drag on unmount (e.g. the sections empty out while
  // the user is dragging), so window listeners never leak.
  useEffect(() => () => dragCleanup.current?.(), []);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = getHeight();
    // The handle sits above the bottom sections, so dragging it UP (smaller y)
    // should grow them.
    const computeNext = (clientY: number) =>
      clampBottomSectionsHeight(startHeight + (startY - clientY), maxAvailable());
    const handleMove = (moveEvent: PointerEvent) => onResize(computeNext(moveEvent.clientY));
    const teardown = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      dragCleanup.current = null;
    };
    function handleUp(upEvent: PointerEvent) {
      const next = computeNext(upEvent.clientY);
      teardown();
      onCommit(next);
    }
    dragCleanup.current = teardown;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    let next: number;
    switch (event.key) {
      case 'ArrowUp': next = getHeight() + step; break;
      case 'ArrowDown': next = getHeight() - step; break;
      case 'Home': next = MIN_BOTTOM_SECTIONS_HEIGHT; break;
      case 'End': next = maxAvailable(); break;
      case 'Escape': event.preventDefault(); onReset(); return;
      default: return;
    }
    event.preventDefault();
    const clamped = clampBottomSectionsHeight(next, maxAvailable());
    onResize(clamped);
    onCommit(clamped);
  };

  return (
    <div
      className="bottom-sections-resizer"
      data-testid="bottom-sections-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize the healthy and completed task sections (double-click to reset)"
      aria-valuenow={Math.round(getHeight())}
      aria-valuemin={MIN_BOTTOM_SECTIONS_HEIGHT}
      aria-valuemax={Math.round(maxAvailable())}
      title="Drag to resize · double-click to reset"
      onPointerDown={beginDrag}
      onDoubleClick={(e) => { e.preventDefault(); onReset(); }}
      onKeyDown={handleKeyDown}
    >
      <span className="bottom-sections-grip" aria-hidden="true" />
    </div>
  );
}
