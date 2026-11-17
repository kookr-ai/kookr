/**
 * The divider on the left edge of Lucy's column. Dragging it, or focusing it and pressing the arrow keys,
 * changes the column's width within its limits (320 px up to 560 px, or less where the window cannot spare that much).
 *
 * The column is docked to the right edge of the window, so its left edge is the side that moves: dragging
 * the divider to the left, or pressing ArrowLeft, makes the column wider, and the other way makes it
 * narrower (the opposite of the navigation divider, which sits on the right edge of its panel). Shift makes
 * a key press three times as big, Home and End jump to the narrowest and the widest.
 *
 * Every width it reports is already inside the limits. While a drag is going on it reports the live width
 * (`onResize`); the final width is reported once, when the drag ends or a key moves the divider (`onCommit`),
 * and only then is it worth saving.
 */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AVATAR_COLUMN_MIN_WIDTH, clampAvatarColumnWidth } from '../store/avatar-panel-prefs.js';

/** Pixels one arrow-key press moves the divider; the larger step applies with Shift held. */
const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 48;
/** How far the pointer must travel before a press counts as a drag, so a shaky click changes nothing. */
const DRAG_THRESHOLD_PX = 3;

export interface ColumnResizerProps {
  /** The width the column is drawn at now. */
  width: number;
  /** The widest the column may be in this window (the page keeps at least 1000 px); the drag and the End key stop here. */
  maxWidth: number;
  /** The live width while dragging; not saved yet. */
  onResize: (width: number) => void;
  /** The final width: the drag ended, or a key moved the divider. */
  onCommit: (width: number) => void;
}

export function ColumnResizer({ width, maxWidth, onResize, onCommit }: ColumnResizerProps) {
  const [dragging, setDragging] = useState(false);
  // Ends a drag in progress; kept so the drag is also ended if the divider unmounts in the middle of it.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanup.current?.();
    const { pointerId } = event;
    const startX = event.clientX;
    const startWidth = width;
    // The column grows as the pointer moves to the left.
    const widthAt = (clientX: number): number => clampAvatarColumnWidth(startWidth + (startX - clientX), maxWidth);
    // Stays null until the pointer has travelled far enough to count as a drag.
    let liveWidth: number | null = null;

    const handleMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      // The button is no longer held: the release was missed, so end the drag instead of following a free pointer.
      if ((move.buttons & 1) === 0) {
        finish();
        return;
      }
      if (liveWidth === null && Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) return;
      liveWidth = widthAt(move.clientX);
      onResize(liveWidth);
    };
    const handleUp = (up: PointerEvent): void => {
      if (up.pointerId !== pointerId) return;
      if (liveWidth !== null) liveWidth = widthAt(up.clientX);
      finish();
    };
    const handleCancel = (cancel: PointerEvent): void => {
      if (cancel.pointerId === pointerId) finish();
    };
    // Every way a press ends goes through here. A press that never became a drag saves nothing: saving the
    // current width would turn "default" into a width the operator never chose.
    function finish(): void {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      dragCleanup.current = null;
      setDragging(false);
      document.documentElement.classList.remove('avatar-column-resizing');
      if (liveWidth !== null) onCommit(liveWidth);
    }

    dragCleanup.current = finish;
    setDragging(true);
    // While dragging, the cursor stays a resize cursor and text is not selected, wherever the pointer goes.
    document.documentElement.classList.add('avatar-column-resizing');
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = width + step; break;
      case 'ArrowRight': next = width - step; break;
      case 'Home': next = AVATAR_COLUMN_MIN_WIDTH; break;
      case 'End': next = maxWidth; break;
      default: return;
    }
    event.preventDefault();
    onCommit(clampAvatarColumnWidth(next, maxWidth));
  };

  return (
    <div
      className={`avatar-column-resizer${dragging ? ' dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize Lucy's column"
      aria-valuemin={AVATAR_COLUMN_MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      onPointerDown={beginDrag}
      onKeyDown={onKeyDown}
      data-testid="avatar-column-resizer"
    />
  );
}
