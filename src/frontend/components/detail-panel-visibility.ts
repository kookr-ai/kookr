/**
 * Whether the terminal slot inside the detail panel is actually visible.
 *
 * In narrow mode the right pane is tab-switched via `narrowTab`, so the
 * terminal is only visible when `rightPane` selects it AND the narrow tab
 * is on terminal. In wide mode `narrowTab` is ignored.
 *
 * Kept as a pure function so the wiring that replaces the old
 * IntersectionObserver path (TerminalPanel's `visible` prop) is covered by
 * a direct truth-table test instead of only indirect component tests.
 */
export function computeTerminalVisible(params: {
  rightPane: string;
  isNarrowViewport: boolean;
  narrowTab: string;
}): boolean {
  const { rightPane, isNarrowViewport, narrowTab } = params;
  if (rightPane !== 'terminal') return false;
  if (isNarrowViewport && narrowTab !== 'terminal') return false;
  return true;
}
