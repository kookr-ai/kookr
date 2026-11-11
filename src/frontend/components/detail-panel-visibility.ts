/**
 * Layout the reading pane actually renders (#3561 slice 4a). It differs from
 * the stored `DetailPaneMode` because split view and terminal focus need a
 * wide window; below the wide breakpoint every stored mode renders as tabs.
 */
export type DetailPaneLayout = 'tabs' | 'split' | 'focus';

/**
 * Resolve the rendered layout from the stored mode. Split view and terminal
 * focus need a wide window and a task that still shows its panes (a finished
 * task with a completion digest replaces them); otherwise the pane uses tabs.
 */
export function resolveDetailPaneLayout(params: {
  requestedMode: 'tabs' | 'split' | 'right';
  wideDetailActive: boolean;
  panesVisible: boolean;
}): DetailPaneLayout {
  const { requestedMode, wideDetailActive, panesVisible } = params;
  if (!wideDetailActive || !panesVisible) return 'tabs';
  if (requestedMode === 'split') return 'split';
  if (requestedMode === 'right') return 'focus';
  return 'tabs';
}

/**
 * Whether the terminal slot inside the detail panel is actually visible.
 *
 * In the tabbed layout only the selected tab is on screen, so the terminal is
 * visible when `rightPane` selects it AND the Terminal tab is active. Split view
 * and terminal focus always show the right pane, so the tab is ignored there.
 *
 * Kept as a pure function so the wiring behind TerminalPanel's `visible` prop
 * (which gates the terminal byte-stream subscription) is covered by a direct
 * truth-table test instead of only indirect component tests.
 */
export function computeTerminalVisible(params: {
  rightPane: string;
  layout: DetailPaneLayout;
  activeTab: string;
}): boolean {
  const { rightPane, layout, activeTab } = params;
  if (rightPane !== 'terminal') return false;
  if (layout === 'tabs' && activeTab !== 'terminal') return false;
  return true;
}
