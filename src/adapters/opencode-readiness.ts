/**
 * opencode TUI pane probes (RFC rfc-opencode-agent-integration §2).
 *
 * Verified on a real 1.19.5 run: the idle composer shows the placeholder
 * `Ask anything…` and a footer containing `ctrl+p commands`; while a turn is
 * running the status area shows `esc interrupt`. Matching is deliberately
 * tolerant (lowercased, control-stripped) because only these coarse markers
 * were observed.
 */
import { stripTerminalControls } from './agent-launch-context.js';

const READY_MARKERS: readonly string[] = ['ask anything', 'ctrl+p commands'];
const BUSY_MARKERS: readonly string[] = ['esc interrupt', 'esc to interrupt'];

function normalize(display: string): string {
  return stripTerminalControls(display).toLowerCase();
}

/** True when the composer chrome is painted (safe to paste the prompt). */
export function isOpenCodeComposerReady(display: string): boolean {
  const text = normalize(display);
  return READY_MARKERS.some((marker) => text.includes(marker));
}

/** True when opencode is mid-turn (a prompt was accepted). */
export function isOpenCodeBusyOrResponding(display: string): boolean {
  const text = normalize(display);
  return BUSY_MARKERS.some((marker) => text.includes(marker));
}

/** Bounded single-line pane excerpt for diagnostics. */
export function formatOpenCodePaneExcerpt(display: string, maxChars = 400): string {
  const text = stripTerminalControls(display).replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`;
}
