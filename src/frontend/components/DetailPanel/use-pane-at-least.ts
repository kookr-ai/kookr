import { useLayoutEffect, useState } from 'react';
import type React from 'react';

/**
 * The facts column docks beside the conversation only when the reading pane is
 * at least this wide (issue #3561 slice 4b; lowered from 820 in issue #4024).
 * The column is 232 px, so 760 leaves the conversation at least ~530 px.
 *
 * Measured with a task selected (window width: pane width with all projects /
 * pane width with a project's drawer open):
 *   1180: 788 / 508   1279: 869 / 589   1280: 710 / 590   1360: 767 / 647
 *   1400: 796 / 676   1440: 825 / 705   1520: 888 / 768   1600: 968 / 848
 * The pane narrows at 1280 because the navigation gains its labels there
 * (#3561 slice 5a). With 760, the column docks from about 1350 px with all
 * projects (820 waited until about 1435 px) and from about 1515 px with a
 * project's drawer open. At 1280 to about 1350 px it stays behind the Details
 * button: docking there would leave the conversation under 480 px.
 */
export const FACTS_DOCK_MIN_PANE_PX = 760;

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
