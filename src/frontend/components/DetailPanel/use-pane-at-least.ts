import { useLayoutEffect, useState } from 'react';
import type React from 'react';

/**
 * The facts column docks beside the conversation only when the reading pane is
 * at least this wide (issue #3561 slice 4b). Measured on main: the pane is
 * 839 px at a 1180 px window and 939 px at 1280 px, so 820 keeps the column
 * docked from about 1160 px up and leaves the conversation at least ~590 px.
 */
export const FACTS_DOCK_MIN_PANE_PX = 820;

/**
 * Whether the element behind `ref` is at least `minPx` wide, kept current with
 * a ResizeObserver. It changes state only when the answer flips, so resizing
 * the window does not re-render the pane (and its terminal) on every pixel.
 * True until measured, and always where ResizeObserver is missing (jsdom), so
 * callers fall back to their wide layout. A container query would be simpler,
 * but it makes the pane the containing block of every fixed dialog inside it.
 */
export function usePaneAtLeast(ref: React.RefObject<HTMLElement | null>, minPx: number, remountKey: unknown): boolean {
  const [wide, setWide] = useState(true);
  // Layout effect: a narrow pane must not paint one frame with the column docked.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = (width: number) => setWide(width >= minPx);
    update(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      update(entries[0]?.contentRect.width ?? el.getBoundingClientRect().width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, minPx, remountKey]);
  return wide;
}
