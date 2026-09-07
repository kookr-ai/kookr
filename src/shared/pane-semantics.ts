/**
 * Browser-safe terminal pane pattern detection for managed agent UI states.
 *
 * Keep this free of Node/core-only imports. Both the backend watchdog and the
 * frontend terminal controls use it, so Claude/Codex/Grok prompt heuristics
 * stay in one place.
 */

export type PaneState =
  | 'input_prompt'
  | 'permission_dialog'
  | 'shell_prompt'
  | 'streaming'
  | 'unknown';

export interface PaneSemantics {
  state: PaneState;
  confidence: 'high' | 'low';
  matchedText?: string;
}

const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_CHAR_RE = /\x1b[@-_]/g;

export function stripTerminalControls(text: string): string {
  return text
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_SINGLE_CHAR_RE, '');
}

// Matches one CSI sequence: ESC [ <params> <intermediates> <final>. Parameter
// bytes are 0x30–0x3F (digits, ';', and the '?' private-marker), intermediates
// 0x20–0x2F, final 0x40–0x7E. Sticky so it can be anchored at a given index via
// `lastIndex` without slicing the remaining text (keeps reconstruction linear).
const CSI_SEQUENCE_RE = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
// ESC-family sequences whose selector byte in [()*+#] introduces a charset/DEC
// sequence taking one further byte (e.g. ESC(B) — consume it too so the final
// byte is not mistaken for printable text).
const ESC_CHARSET_INTRODUCERS = new Set(['(', ')', '*', '+', '#']);
const DEL_CHAR = '\x7f';

// Guards against a bogus absolute row (`ESC[99999H`) forcing a huge grid
// allocation on the watchdog's per-tick hot path. Real terminals are well under
// this; the Codex PTY is 50 rows.
const MAX_INFERRED_SCREEN_HEIGHT = 1000;

/**
 * The visible screen height for absolute row addressing: the tallest absolute
 * row (>= 2) any CUP/HVP/VPA sequence targets. A stream that never addresses a
 * row past the first keeps an unbounded, non-scrolling buffer (`Infinity`) in
 * which rows accumulate in stream order.
 */
function inferScreenHeight(text: string): number {
  let max = 0;
  const re = /\x1b\[([0-9;]*)[Hfd]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const row = parseInt(m[1].split(';')[0] || '1', 10);
    if (!Number.isNaN(row)) max = Math.max(max, row);
  }
  return max >= 2 ? Math.min(max, MAX_INFERRED_SCREEN_HEIGHT) : Infinity;
}

/**
 * Reconstruct the visible lines of a terminal pane from its raw byte stream.
 *
 * This is a compact VT screen-buffer model, not a newline splitter: it keeps a
 * cursor (line, column) over a grid and applies printable writes, `\r`/`\n`/`\b`,
 * absolute and relative cursor moves (CUP/HVP, CUU/CUD/CUF/CUB, CHA, VPA,
 * CNL/CPL) and in-line/display erases (EL/ED). SGR colour, OSC, DEC private
 * modes and other sequences are consumed and ignored. Cursor-addressed TUIs —
 * Codex draws its composer with `ESC[22;1H›  …  ESC[24;1H  gpt-…` and no
 * newlines between rows — therefore reconstruct into the correct distinct lines
 * instead of collapsing onto one, which is what defeated the idle-composer
 * detector in issue #3037 and forced the placeholder-specific workaround in
 * #3038 (issue #3039).
 *
 * Absolute row addressing is relative to the visible screen, so the model
 * tracks a screen top and scrolls on overflow. The screen height is the tallest
 * absolute row the stream addresses (>= 2); a stream that never uses multi-row
 * absolute addressing keeps an unbounded, non-scrolling buffer. A pane that
 * positions text with only `\r`/`\n`/`\b` (plus SGR/OSC colour, which is
 * dropped either way) reconstructs identically to the previous newline model —
 * so the watchdog's pane-change activity hash is unchanged for providers whose
 * output is line-oriented (Claude/Grok panes in practice). Panes that do use
 * cursor moves or erases now reconstruct faithfully instead of by concatenation,
 * which is the point; change detection is preserved because output still varies
 * iff the visible content varies.
 */
export function visibleLinesFromTerminalText(text: string): string[] {
  const screenHeight = inferScreenHeight(text);
  const scrolls = Number.isFinite(screenHeight);
  const lines = [''];
  let line = 0; // absolute index into `lines` of the cursor's row
  let col = 0;
  let screenTop = 0; // absolute index of the visible screen's first row

  const ensureLine = (idx: number) => {
    while (lines.length <= idx) lines.push('');
  };
  const scrollIntoView = () => {
    if (scrolls && line > screenTop + screenHeight - 1) {
      screenTop = line - (screenHeight - 1);
    }
  };
  // Absolute row within the visible screen, clamped to [0, height-1] so a bogus
  // out-of-range CUP/VPA cannot grow the grid without bound.
  const clampRow = (row: number) => {
    const r = Math.max(0, row);
    return scrolls ? Math.min(r, screenHeight - 1) : r;
  };
  const writeChar = (ch: string) => {
    ensureLine(line);
    let s = lines[line];
    if (s.length < col) s += ' '.repeat(col - s.length);
    lines[line] = s.slice(0, col) + ch + s.slice(col + 1);
    col++;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '\x1b') {
      if (text[i + 1] === ']') {
        // OSC … ST (ESC\) or BEL — consumed and ignored.
        let j = i + 2;
        while (j < text.length && text[j] !== '\x07' && !(text[j] === '\x1b' && text[j + 1] === '\\')) j++;
        i = text[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      if (text[i + 1] === '[') {
        CSI_SEQUENCE_RE.lastIndex = i;
        const m = CSI_SEQUENCE_RE.exec(text);
        if (m) {
          i += m[0].length - 1;
          const params = m[1];
          const final = m[2];
          // Skip DEC/private-marker sequences (params led by ? < = >), and parse
          // params NaN-safe: a non-numeric field (e.g. a `:` sub-parameter) maps
          // to undefined so `?? default` applies rather than propagating NaN into
          // a row/col — which would index `lines[NaN]` and throw on this hot path.
          if (/^[?<=>]/.test(params)) continue;
          const nums = params.split(';').map((p) => {
            const v = parseInt(p, 10);
            return Number.isNaN(v) ? undefined : v;
          });
          const n1 = nums[0];
          const n2 = nums[1];
          switch (final) {
            case 'H': // CUP
            case 'f': // HVP
              line = screenTop + clampRow((n1 ?? 1) - 1);
              col = Math.max(0, (n2 ?? 1) - 1);
              ensureLine(line);
              break;
            case 'A': // CUU
              line = Math.max(screenTop, line - (n1 ?? 1));
              break;
            case 'B': // CUD
              line += n1 ?? 1;
              ensureLine(line);
              scrollIntoView();
              break;
            case 'C': // CUF
              col += n1 ?? 1;
              break;
            case 'D': // CUB
              col = Math.max(0, col - (n1 ?? 1));
              break;
            case 'E': // CNL
              line += n1 ?? 1;
              col = 0;
              ensureLine(line);
              scrollIntoView();
              break;
            case 'F': // CPL
              line = Math.max(screenTop, line - (n1 ?? 1));
              col = 0;
              break;
            case 'G': // CHA
              col = Math.max(0, (n1 ?? 1) - 1);
              break;
            case 'd': // VPA
              line = screenTop + clampRow((n1 ?? 1) - 1);
              ensureLine(line);
              break;
            case 'K': { // EL — erase in line
              ensureLine(line);
              const mode = n1 ?? 0;
              if (mode === 0) lines[line] = lines[line].slice(0, col);
              else if (mode === 1) {
                const clear = Math.min(col + 1, lines[line].length);
                lines[line] = ' '.repeat(clear) + lines[line].slice(clear);
              } else if (mode === 2) lines[line] = '';
              break;
            }
            case 'J': { // ED — erase in display
              const mode = n1 ?? 0;
              if (mode === 0) {
                ensureLine(line);
                lines[line] = lines[line].slice(0, col);
                lines.length = line + 1;
              } else if (mode === 2 || mode === 3) {
                if (scrolls) {
                  for (let k = screenTop; k < lines.length; k++) lines[k] = '';
                  line = screenTop;
                  col = 0;
                } else {
                  lines.length = 0;
                  lines.push('');
                  line = 0;
                  screenTop = 0;
                  col = 0;
                }
              }
              break;
            }
            default:
              break; // SGR (m), DECSTBM (r), DECSCUSR (space q), … — ignore.
          }
          continue;
        }
      }
      // Other ESC sequence: consume ESC + its 1-byte selector (plus one more
      // byte for charset/DEC introducers). No worse than the prior strip, which
      // only removed CSI/OSC/C1 forms.
      const next = text[i + 1];
      i += next !== undefined && ESC_CHARSET_INTRODUCERS.has(next) ? 2 : 1;
      continue;
    }

    if (char === '\r') {
      // CRLF ends a line; bare CR is a terminal redraw that returns to column 0.
      // Replays can contain duplicated CRs before LF, so collapse those first.
      let next = i + 1;
      while (text[next] === '\r') next++;
      if (text[next] === '\n') {
        i = next - 1;
        col = 0;
        continue;
      }
      lines[line] = '';
      col = 0;
      continue;
    }
    if (char === '\n') {
      line += 1;
      col = 0;
      ensureLine(line);
      scrollIntoView();
      continue;
    }
    if (char === '\b' || char === DEL_CHAR) {
      lines[line] = lines[line].slice(0, -1);
      col = Math.max(0, col - 1);
      continue;
    }
    writeChar(char);
  }

  return lines;
}

// Claude Code's input prompt: ❯ on its own line, often surrounded by horizontal rules.
const CLAUDE_INPUT_PROMPT_RE = /^❯\s*$/;

// Codex empty idle composer row. An empty composer either renders a bare `›`
// or fills the row with the dim placeholder Codex draws when nothing is typed
// ("Ask Codex to do anything"); a faithful multi-row reconstruction now keeps
// that row distinct from the model footer, so both forms are handled here as
// "empty composer" rather than by the collapsed-line workaround #3038 needed
// (issue #3039). Typed draft text (`› run tests`) is deliberately NOT matched.
const CODEX_INPUT_PROMPT_RE = /^›\s*(?:Ask Codex to do anything\s*)?$/;
// Codex composer/footer line that accompanies the idle prompt.
const CODEX_COMPOSER_FOOTER_RE = /^\s{2}(?:gpt-[\w.-].*|Fast on\s*$|.*Plan mode.*|.*(?:% left|context left).*)$/i;

// Permission dialog: Claude Code shows tool name + "Allow" / "Deny" options.
const PERMISSION_ALLOW_DENY_RE = /\bAllow\b.*\bDeny\b|\ballow\b.*\bdeny\b/i;
const PERMISSION_QUESTION_RE = /allow.*tool|permission|approve.*tool/i;
// Codex approvals have specific prompt text distinct from generic popups.
const CODEX_PERMISSION_RE = /would you like to (?:run the following command|grant these permissions|make the following edits)\?|allow\s+run the tool and continue\./i;

// Grok Build permission prompt (issue #1526 Phase C4). Row labels are VERBATIM
// strings extracted from the grok 0.2.111 binary (crates/codegen/
// xai-grok-workspace/src/permission/prompter.rs string table): "Allow once",
// "Always allow this command", "Always allow on all sessions", "Reject",
// "Yes, always allow … this session", "Yes, allow all edits during this
// session", "Yes, and don't ask again for bash commands", "No, and don't run
// bash commands", "Yes, and don't ask again for anything (always-approve
// mode)", "No, and tell Grok what to do differently". Grok renders these as a
// cursor-selectable row menu, one row per line — so unlike Claude's
// PERMISSION_ALLOW_DENY_RE the allow/deny words are never on ONE line.
// High confidence requires BOTH an allow-side row and a reject-side row
// (each anchored at line start, after an optional cursor/number prefix) so
// agent output merely QUOTING one label cannot trip the detector.
const GROK_PERMISSION_ALLOW_ROW_RE =
  /^\s*[❯›>]?\s*(?:\d+\.\s*)?(?:Allow once\b|Always allow (?:this command|on all sessions)\b|Yes, (?:always allow\b|allow all edits\b|and don'?t ask again\b))/i;
const GROK_PERMISSION_REJECT_ROW_RE =
  /^\s*[❯›>]?\s*(?:\d+\.\s*)?(?:Reject\b|No, and (?:tell Grok\b|don'?t run\b))/i;

// Shell prompt patterns: user has exited Claude Code and is back at the shell.
const SHELL_PROMPT_RE = /^[\w.-]*@[\w.-]*[:%~].*[$#%]\s*$|^\$\s*$|^%\s*$/;

// Streaming/thinking indicators. Codex uses a status row with "esc to interrupt"
// while the composer stays visible, so the prompt line alone is not sufficient.
const STREAMING_RE = /Thinking|Pollinating|✢|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Running…|Streaming/i;

// Shared footer/status hints for Claude/Codex terminals.
const STATUS_BAR_RE = /esc to interrupt|ctrl\+[a-z]|shift\+tab|tab to queue message/i;
// Codex repaints an active status line with elapsed time while the model works.
const ACTIVE_STATUS_LINE_RE = /^[•●].*\(\d+[smh].*\besc to interrupt\)$/i;

const VOLATILE_ACTIVITY_LINE_RES = [
  STATUS_BAR_RE,
  CODEX_COMPOSER_FOOTER_RE,
  ACTIVE_STATUS_LINE_RE,
];

export function analyzePaneSemantics(paneText: string): PaneSemantics {
  const visibleLines = visibleLinesFromTerminalText(paneText);
  if (!visibleLines.some((line) => line.trim().length > 0)) {
    return { state: 'unknown', confidence: 'low' };
  }

  const lastLines = visibleLines
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-15);

  if (lastLines.length === 0) {
    return { state: 'unknown', confidence: 'low' };
  }

  // Grok's row-menu permission prompt: an allow row plus a reject row, each on
  // its own line. Checked as a line PAIR before the single-line heuristics so
  // the (deliberately weak) PERMISSION_QUESTION_RE cannot downgrade a real
  // Grok menu to low confidence.
  const grokAllowRow = lastLines.find((line) => GROK_PERMISSION_ALLOW_ROW_RE.test(line));
  if (grokAllowRow && lastLines.some((line) => GROK_PERMISSION_REJECT_ROW_RE.test(line))) {
    return { state: 'permission_dialog', confidence: 'high', matchedText: grokAllowRow.trim() };
  }

  for (const line of lastLines) {
    if (PERMISSION_ALLOW_DENY_RE.test(line)) {
      return { state: 'permission_dialog', confidence: 'high', matchedText: line.trim() };
    }
    if (PERMISSION_QUESTION_RE.test(line)) {
      return { state: 'permission_dialog', confidence: 'low', matchedText: line.trim() };
    }
    if (CODEX_PERMISSION_RE.test(line)) {
      return { state: 'permission_dialog', confidence: 'high', matchedText: line.trim() };
    }
  }

  const nonStatusLines = lastLines.filter((line) => !STATUS_BAR_RE.test(line));
  for (let i = nonStatusLines.length - 1; i >= Math.max(0, nonStatusLines.length - 5); i--) {
    if (CLAUDE_INPUT_PROMPT_RE.test(nonStatusLines[i])) {
      return { state: 'input_prompt', confidence: 'high', matchedText: nonStatusLines[i].trim() };
    }
  }

  // Codex idle composer: a composer prompt row (bare `›` or the dim
  // "Ask Codex to do anything" placeholder Codex fills an empty composer with)
  // plus its model footer, and no live `esc to interrupt` status bar. Faithful
  // multi-row reconstruction (visibleLinesFromTerminalText) keeps the composer
  // row, the blank row and the footer distinct, so the empty-composer +
  // standalone-footer heuristic classifies real Codex panes directly — the
  // placeholder is just another empty-composer form (issue #3039). Gating on
  // the absence of an active status bar keeps a mid-turn frame (whose
  // `• Working (Ns • esc to interrupt)` row is present) from reading as idle.
  const hasActiveStatusBar = lastLines.some((line) => STATUS_BAR_RE.test(line));
  const hasCodexComposerFooter = lastLines.some((line) => CODEX_COMPOSER_FOOTER_RE.test(line));
  if (!hasActiveStatusBar && hasCodexComposerFooter) {
    for (let i = nonStatusLines.length - 1; i >= Math.max(0, nonStatusLines.length - 5); i--) {
      if (CODEX_INPUT_PROMPT_RE.test(nonStatusLines[i])) {
        return { state: 'input_prompt', confidence: 'high', matchedText: nonStatusLines[i].trim() };
      }
    }
  }

  for (let i = lastLines.length - 1; i >= Math.max(0, lastLines.length - 5); i--) {
    if (STREAMING_RE.test(lastLines[i])) {
      return { state: 'streaming', confidence: 'low', matchedText: lastLines[i].trim() };
    }
  }

  const lastLine = lastLines[lastLines.length - 1];
  if (SHELL_PROMPT_RE.test(lastLine)) {
    const hasStatusBar = lastLines.some((line) => STATUS_BAR_RE.test(line));
    if (!hasStatusBar) {
      return { state: 'shell_prompt', confidence: 'high', matchedText: lastLine.trim() };
    }
  }

  return { state: 'unknown', confidence: 'low' };
}

export function normalizePaneForActivity(paneText: string): string {
  const visibleLines = visibleLinesFromTerminalText(paneText);
  if (!visibleLines.some((line) => line.trim().length > 0)) return '';

  return visibleLines
    .map((line) => line.trimEnd())
    .filter((line) => !VOLATILE_ACTIVITY_LINE_RES.some((re) => re.test(line)))
    .join('\n')
    .trim();
}
