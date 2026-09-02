/**
 * Grok Build interactive readiness + startup-UI guard (issue #1343, RFC
 * "Grok Build adapter": deliver the prompt "only after a structured or
 * otherwise unambiguous ready-state probe … abort rather than type into
 * authentication, update, or other unexpected startup UI").
 *
 * POC-A (pty-interactive.redacted.json) captured Grok's startup bytes: it emits
 * the DECSET `ESC[?2004h` (bracketed-paste enable) once its TUI is ready, so
 * {@link isBracketedPasteModeEnabled} from the shared launch context is the
 * ready probe; this module adds the negative guard that aborts delivery when
 * the captured screen is an auth/update screen rather than the composer.
 *
 * Claude Code's gate is no longer the same (#2977): it emits that DECSET during
 * terminal setup and then drops input for seconds, so its readiness needs the
 * DECSET *plus* painted composer chrome plus a settle cushion. If Grok is ever
 * observed dropping input after the DECSET, that is the fix to copy — see
 * `waitForPasteReady` in `agent-launch-context.ts`.
 */
import { stripTerminalControls } from './agent-launch-context.js';
import { analyzePaneSemantics } from '../shared/pane-semantics.js';

/**
 * Substrings that indicate Grok is showing an authentication or update screen
 * (not the ready composer). Delivery must ABORT — typing a task prompt into a
 * login/update UI is unsafe. Kept narrow and lowercased; matched against the
 * control-stripped display. POC-A's 403 blocker text ("log into console.x.ai")
 * and the OAuth/update flows motivate these markers.
 */
const GROK_BLOCKING_STARTUP_MARKERS: readonly string[] = [
  'console.x.ai',
  'sign in',
  'log in to',
  'please log in',
  'authenticate',
  'authentication required',
  'oauth',
  'enter your api key',
  'paste your api key',
  'update available',
  'a new version of grok',
  'please update',
  'access to the chat endpoint is denied',
];

/**
 * Return a human-readable reason when the captured display looks like a Grok
 * auth/update screen the launcher must not type into, else `null`. Operates on
 * decoded display text (ANSI stripped) and is deliberately conservative — a
 * false negative merely proceeds to normal delivery (which the ready probe
 * already gated), while a false positive would abort a healthy launch.
 */
export function detectGrokBlockingStartupUI(display: string): string | null {
  const text = stripTerminalControls(display).toLowerCase();
  for (const marker of GROK_BLOCKING_STARTUP_MARKERS) {
    if (text.includes(marker)) {
      return `Grok showed an unexpected startup screen ("${marker}") instead of the ready composer`;
    }
  }
  return null;
}

/**
 * Mid-run analog of {@link detectGrokBlockingStartupUI} for Grok's PERMISSION
 * prompt (issue #1526 Phase C4): returns a human-readable reason when the
 * captured display shows Grok's cursor-selectable permission row menu, else
 * `null`.
 *
 * The row labels are grounded in verbatim strings extracted from the grok
 * 0.2.111 binary's permission prompter ("Allow once", "Always allow this
 * command", "Reject", "No, and tell Grok what to do differently", …) and live
 * in the shared pane-semantics module, which is ALSO the production mid-run
 * rescan path: the server's 5s watchdog tick calls `adapter.captureDisplay`
 * and classifies the pane via `analyzePaneSemantics`, so a Grok session whose
 * permission hooks never fired (POC-A: `permission_denied` is unreliable in
 * headless mode) is still reported `permission_blocked` from the pane alone.
 * This wrapper exposes the same classification to Grok-adapter callers — the
 * launch path uses it to explain an unacknowledged initial prompt.
 */
export function detectGrokPermissionPromptUI(display: string): string | null {
  const semantics = analyzePaneSemantics(display);
  if (semantics.state === 'permission_dialog' && semantics.confidence === 'high') {
    return `Grok is showing a permission prompt ("${semantics.matchedText ?? 'Allow once / Reject'}")`;
  }
  return null;
}

/**
 * Upper bound on pane text embedded in handshake-failure logs/errors
 * (issue #1808). Large enough to see composer vs permission vs streaming
 * state; small enough to keep launch error bodies readable.
 */
export const GROK_HANDSHAKE_PANE_EXCERPT_MAX_CHARS = 800;

/**
 * Tail excerpt of a Grok pane for failure diagnosis (issue #1808). Control
 * sequences are stripped so the log shows readable text; empty panes yield
 * `(empty)`.
 */
export function formatGrokPaneExcerpt(
  display: string,
  maxChars: number = GROK_HANDSHAKE_PANE_EXCERPT_MAX_CHARS,
): string {
  const text = stripTerminalControls(display).replace(/\r/g, '').trim();
  if (!text) return '(empty)';
  if (text.length <= maxChars) return text;
  return text.slice(Math.max(0, text.length - maxChars));
}

/**
 * True when the pane looks like Grok already accepted the prompt and is
 * working (or blocked on a permission menu) — i.e. a retry Enter would be
 * unsafe (issue #1808 handshake retry).
 *
 * Narrower than Claude's `esc to interrupt` busy markers: Grok's idle
 * composer footer also contains that phrase (`› type a message… (esc to
 * interrupt)`), so a bare match would false-positive and skip a needed
 * resubmit. Require streaming/thinking indicators, a timed active status
 * line, or a high-confidence permission menu.
 */
export function isGrokBusyOrResponding(display: string): boolean {
  if (detectGrokPermissionPromptUI(display)) return true;
  const semantics = analyzePaneSemantics(display);
  if (semantics.state === 'streaming') return true;
  const text = stripTerminalControls(display);
  // Timed status line with elapsed work — not the idle composer footer alone.
  if (/^[•●].*\(\d+[smh].*\besc to interrupt\)$/im.test(text)) return true;
  if (/\b(Thinking|Running…|Streaming|Pollinating)\b/i.test(text)) return true;
  return false;
}
