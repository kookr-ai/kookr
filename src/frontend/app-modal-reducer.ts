/**
 * Single source of truth for which top-level modal dialog is currently open in
 * {@link App}. These dialogs are mutually exclusive full-screen/centered
 * overlays: only one is ever shown at a time and opening one implicitly closes
 * any other. Collapsing their formerly-independent `useState` booleans into one
 * discriminated value (issue #1825) makes that invariant structural instead of
 * relying on ~12 booleans staying consistent by hand.
 *
 * Non-modal, co-existing surfaces (the command palette, the diagnostics popover,
 * and the inline coordinator-findings pane) are deliberately NOT modeled here —
 * they can legitimately be open alongside a modal or each other, so they keep
 * their own state.
 *
 * Per-modal payloads (e.g. the settings focus field, the schedules prefill,
 * the launch project context) also stay as separate state: this reducer only
 * tracks visibility, not the data a given modal was opened with.
 */
export type ActiveModal =
  | 'launch'
  | 'quickLaunch'
  | 'shortcuts'
  | 'snooze'
  | 'projectSidebarManager'
  | 'settings'
  | 'schedules'
  | 'workspace'
  | 'costComparison'
  | 'bugReport'
  | 'shareViewer'
  | 'sweepConfirm';

export type ModalAction =
  | { type: 'open'; modal: ActiveModal }
  | { type: 'toggle'; modal: ActiveModal }
  | { type: 'close' };

export type ActiveModalState = ActiveModal | null;

export function activeModalReducer(state: ActiveModalState, action: ModalAction): ActiveModalState {
  switch (action.type) {
    case 'open':
      return action.modal;
    case 'toggle':
      return state === action.modal ? null : action.modal;
    case 'close':
      return null;
    default:
      return state;
  }
}
