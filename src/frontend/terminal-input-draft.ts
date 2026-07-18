const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BACKSPACE = '\b';
const DELETE = '\u007f';

// xterm.onData forwards more than user keystrokes — it also emits replies
// xterm generates on its own behalf in response to *agent* queries or DOM focus
// changes, none of which represent local input. Examples seen on real Claude
// Code / Codex sessions: focus tracking (`ESC [ I` / `ESC [ O` from DECSET 1004),
// Primary/Secondary Device Attribute replies (`ESC [ ? 1 ; 2 c`, `ESC [ > 0 ; … c`),
// Device Status Reports (`ESC [ … n`), Cursor Position Reports (`ESC [ row ; col R`),
// SGR mouse events, and bracketed-paste markers around xterm's native paste.
//
// Treating any of those bytes as draft input masks empty-Enter navigation: the
// draft looks non-empty even though the user hasn't typed anything. The first
// concrete symptom was `ESC [ I` on click; the deeper one is `ESC [ ? 1 ; 2 c`
// which xterm sends as soon as the agent issues `ESC [ c` (Primary DA query) at
// session start, so the draft is polluted before the user ever interacts.
//
// Strip the known xterm-emitted report sequences before accumulating; leave
// keystroke-driven CSI sequences (arrow keys, function keys) alone so
// up-arrow-recall + Enter still submits to the agent.
const TERMINAL_REPORT_PATTERN = new RegExp(
  [
    '\\x1b\\[[IO]',                  // focus tracking (DECSET 1004)
    '\\x1b\\[[?>][0-9;]*c',          // DA1 / DA2 replies (private prefix, final 'c')
    '\\x1b\\[\\??[0-9;]*n',          // DSR replies (status / cursor-status, final 'n')
    '\\x1b\\[[0-9]+;[0-9]+R',        // Cursor Position Report (final 'R')
    '\\x1b\\[<[0-9]+;[0-9]+;[0-9]+[Mm]', // SGR mouse press/release
    '\\x1b\\[20[01]~',               // bracketed-paste open/close markers
  ].join('|'),
  'g',
);

export function stripTerminalReports(data: string): string {
  return data.replace(TERMINAL_REPORT_PATTERN, '');
}

export function updateTerminalInputDraft(draft: string, data: string): string {
  let next = draft;
  const cleaned = stripTerminalReports(data);
  for (const char of cleaned) {
    if (char === '\r' || char === '\n' || char === CTRL_C || char === CTRL_U) {
      next = '';
    } else if (char === DELETE || char === BACKSPACE) {
      next = next.slice(0, -1);
    } else {
      next += char;
    }
  }
  return next;
}

// A selected menu row: a TUI selection marker (❯ › ▶ ▸ — deliberately NOT the
// ASCII ">", which is a common markdown blockquote in agent output) followed by
// a numbered/lettered option, e.g. "❯ 2. Dark mode" or "› 1. Yes, continue".
// The idle composer (marker alone, or marker + dim placeholder like `Try "…"`)
// has no digit/letter-then-delimiter after the marker, so it does not match.
const MENU_SELECTION_ROW_RE = /^\s*[❯›▶▸]\s*[0-9a-z][.)]\s*\S/i;
// Footer hint that Enter confirms a selection rather than submits a prompt.
// Claude: "Enter to select · Esc to cancel"; Codex: "Press enter to continue".
// `\bpress enter\b` is intentionally broad — if it false-positives on agent
// prose containing that phrase, the only effect is forwarding Enter to the
// agent instead of navigating, which is a safe degrade (no menu choice lost).
const MENU_FOOTER_RE = /\benter to (?:select|continue|confirm|submit|choose)\b|\bpress enter\b/i;
const COMPOSER_ROW_RE = /^\s*[❯›](?:\s+(.*?))?\s*$/;
const COMPOSER_PLACEHOLDER_RE = /^Try\s+["“]|^[─━╌\-—]+$/i;

export function looksLikeInteractiveMenu(tail: string): boolean {
  return tail.split('\n').some((line) => MENU_SELECTION_ROW_RE.test(line) || MENU_FOOTER_RE.test(line));
}

export function looksLikeVisibleComposerDraft(tail: string): boolean {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = COMPOSER_ROW_RE.exec(lines[i] ?? '');
    if (!match) continue;
    const draft = match[1]?.trim() ?? '';
    return draft.length > 0 && !COMPOSER_PLACEHOLDER_RE.test(draft);
  }
  return false;
}
