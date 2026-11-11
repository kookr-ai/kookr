import { useEffect, useRef, useState } from 'react';
import { clampNavWidth, MAX_NAV_WIDTH, MIN_NAV_WIDTH } from '../store/dashboard-layout-prefs.js';

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
  // Removes the window listeners of a drag in progress, so they do not outlive
  // the divider if it unmounts mid-drag (terminal focus hides the navigation).
  const dragCleanup = useRef<(() => void) | null>(null);

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
    let moved = false;

    const handleMove = (moveEvent: PointerEvent) => {
      moved = true;
      onResize(widthAt(moveEvent.clientX));
    };
    const teardown = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', teardown);
      setDragging(false);
      onResizeStateChange(false);
      dragCleanup.current = null;
    };
    function handleUp(upEvent: PointerEvent) {
      teardown();
      // A press without movement is a click (or half of a double-click), not a
      // resize: storing the current width here would turn "default" into a
      // pinned preference the user never chose.
      if (moved) onCommit(widthAt(upEvent.clientX));
    }

    dragCleanup.current = teardown;
    setDragging(true);
    onResizeStateChange(true);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', teardown);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
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
      aria-valuemin={MIN_NAV_WIDTH}
      aria-valuemax={MAX_NAV_WIDTH}
      title="Drag to resize the navigation. Double-click to reset its width."
      onPointerDown={beginDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
