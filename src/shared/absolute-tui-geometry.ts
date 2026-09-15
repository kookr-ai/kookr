/**
 * Grok Build (and similar absolute-position TUIs) paint CUP cells out near
 * column 180–200 regardless of a short FitAddon width. The dashboard pins
 * xterm and attach geometry to this width so those cells land on-screen
 * instead of leaving a blank left-edge pane.
 *
 * Keep the frontend pin, attach clamp, and reconstruct grid in sync.
 */
export const ABSOLUTE_TUI_COLS = 200;
