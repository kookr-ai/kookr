/**
 * Browser-safe terminal pane pattern detection for managed agent UI states.
 *
 * Keep this free of Node/core-only imports. Both the backend watchdog and the
 * frontend terminal controls use it, so Claude/Codex prompt heuristics stay in
 * one place.
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

const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// Claude Code's input prompt: ❯ on its own line, often surrounded by horizontal rules.
const CLAUDE_INPUT_PROMPT_RE = /^❯\s*$/;

// Codex empty idle composer row.
const CODEX_INPUT_PROMPT_RE = /^›\s*$/;
// Codex composer/footer line that accompanies the idle prompt.
const CODEX_COMPOSER_FOOTER_RE = /^\s{2}(?:gpt-[\w.-].*|Fast on\s*$|.*Plan mode.*|.*(?:% left|context left).*)$/i;

// Permission dialog: Claude Code shows tool name + "Allow" / "Deny" options.
const PERMISSION_ALLOW_DENY_RE = /\bAllow\b.*\bDeny\b|\ballow\b.*\bdeny\b/i;
const PERMISSION_QUESTION_RE = /allow.*tool|permission|approve.*tool/i;
// Codex approvals have specific prompt text distinct from generic popups.
const CODEX_PERMISSION_RE = /would you like to (?:run the following command|grant these permissions|make the following edits)\?|allow\s+run the tool and continue\./i;

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
  const cleanText = paneText.replace(ANSI_ESCAPE_RE, '');
  if (!cleanText.trim()) {
    return { state: 'unknown', confidence: 'low' };
  }

  const lastLines = cleanText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-15);

  if (lastLines.length === 0) {
    return { state: 'unknown', confidence: 'low' };
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

  const hasActiveStatusBar = lastLines.some((line) => STATUS_BAR_RE.test(line));
  const hasCodexComposerFooter = lastLines.some((line) => CODEX_COMPOSER_FOOTER_RE.test(line));
  if (!hasActiveStatusBar) {
    for (let i = nonStatusLines.length - 1; i >= Math.max(0, nonStatusLines.length - 5); i--) {
      if (hasCodexComposerFooter && CODEX_INPUT_PROMPT_RE.test(nonStatusLines[i])) {
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
  const cleanText = paneText.replace(ANSI_ESCAPE_RE, '');
  if (!cleanText.trim()) return '';

  return cleanText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !VOLATILE_ACTIVITY_LINE_RES.some((re) => re.test(line)))
    .join('\n')
    .trim();
}
