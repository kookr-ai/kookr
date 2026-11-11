import { useEffect, useRef, useState } from 'react';
import { clampNavWidth, MAX_NAV_WIDTH, MIN_NAV_WIDTH } from '../store/dashboard-layout-prefs.js';

/** Pixels one arrow-key press moves the divider; the larger step applies with Shift held. */
const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 48;
/**
 * How far the pointer must travel before a press counts as a drag. Below this
 * it is a click with a shaky hand (or a touch tap, which often reports a tiny
 * move), and must not change or store a width.
 */
const DRAG_THRESHOLD_PX = 3;

interface Props {
  /** Width the navigation is currently drawn at: the stored preference, or the default. */
  width: number;
  /** A drag started (`true`) or ended (`false`), so the parent can lock the cursor. */
  onResizeStateChange: (active: boolean) => void;
  /** Live width while dragging. Not yet persisted. */
  onResize: (width: number) => void;
  /** Final width: the drag ended, or a key moved the divider. The parent persists it. */
  onCommit: (width: number) => void;
  /** Go back to the default width and forget the stored one. */
  onReset: () => void;
}

/**
 * Divider on the right edge of the left navigation (the queues and named
 * projects shown at 1280 px and wider while "All projects" is selected).
 * Dragging it, or focusing it and pressing the arrow keys, changes the
 * navigation's width; a double-click puts the default width back.
 *
 * Every width it reports is already clamped to the navigation's bounds, so the
 * parent can apply and store the value as is. The stylesheet shows this
 * divider only next to the labelled navigation: beside the 52 px icon rail,
 * which has no adjustable width, it is not rendered at all.
 */
export function NavResizer({ width, onResizeStateChange, onResize, onCommit, onReset }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Ends a drag in progress (see `finish` below). Kept so the drag is also
  // ended if the divider unmounts mid-drag: terminal focus hides the navigation.
  const dragCleanup = useRef<(() => void) | null>(null);
  // Whether each of the last two presses became a drag. Two short drags in
  // quick succession look like a double-click to the browser; this is how the
  // reset tells them apart from two plain clicks.
  const recentPressWasDrag = useRef<[boolean, boolean]>([false, false]);

  useEffect(() => () => dragCleanup.current?.(), []);

  // The navigation is the element just before the divider. Measuring it gives
  // the width actually on screen even if it ever differs from the `width` prop.
  const renderedWidth = (): number => {
    const nav = ref.current?.previousElementSibling;
    return nav instanceof HTMLElement ? nav.getBoundingClientRect().width : width;
  };

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanup.current?.();
    const startX = event.clientX;
    const startWidth = renderedWidth();
    const widthAt = (clientX: number) => clampNavWidth(startWidth + (clientX - startX));
    // Width last shown during this press. Stays `null` until the pointer has
    // travelled far enough to count as a drag.
    let liveWidth: number | null = null;

    const handleMove = (moveEvent: PointerEvent) => {
      // The button is no longer held, so the release was missed (it can happen
      // over an embedded frame). End the drag instead of following a free pointer.
      if ((moveEvent.buttons & 1) === 0) {
        finish();
        return;
      }
      if (liveWidth === null && Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD_PX) return;
      liveWidth = widthAt(moveEvent.clientX);
      onResize(liveWidth);
    };
    const handleUp = (upEvent: PointerEvent) => {
      if (liveWidth !== null) liveWidth = widthAt(upEvent.clientX);
      finish();
    };
    // Every way a press ends goes through here: release, the browser cancelling
    // the gesture, a missed release, a new press, or the divider unmounting.
    // A drag always stores the last width it showed, so the screen and the
    // stored value never disagree. A press that never became a drag stores
    // nothing: storing the current width would turn "default" into a pinned
    // preference the user never chose.
    function finish() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', finish);
      dragCleanup.current = null;
      setDragging(false);
      onResizeStateChange(false);
      recentPressWasDrag.current = [recentPressWasDrag.current[1], liveWidth !== null];
      if (liveWidth !== null) onCommit(liveWidth);
    }

    dragCleanup.current = finish;
    setDragging(true);
    onResizeStateChange(true);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', finish);
  };

  const handleDoubleClick = () => {
    if (recentPressWasDrag.current.some(Boolean)) return;
    onReset();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = renderedWidth() - step; break;
      case 'ArrowRight': next = renderedWidth() + step; break;
      case 'Home': next = MIN_NAV_WIDTH; break;
      case 'End': next = MAX_NAV_WIDTH; break;
      default: return;
    }
    event.preventDefault();
    onCommit(clampNavWidth(next));
  };

  return (
    <div
      ref={ref}
      className={`nav-resizer${dragging ? ' dragging' : ''}`}
      data-testid="nav-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize navigation"
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)} pixels`}
      aria-valuemin={MIN_NAV_WIDTH}
      aria-valuemax={MAX_NAV_WIDTH}
      title="Drag to resize the navigation. Double-click to reset its width."
      onPointerDown={beginDrag}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    />
  );
}
