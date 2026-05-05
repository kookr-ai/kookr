/**
 * Terminal pane pattern detection for managed agent UI states.
 *
 * Analyzes the last lines of a tmux pane capture to determine what
 * Claude Code or Codex CLI is currently showing. Used by the shadow
 * detector and watchdog fallback when hooks are absent or incomplete.
 *
 * When patterns can't determine the state, 'unknown' is returned —
 * this is safe because the feature is additive and only high-confidence
 * matches are promoted into actionable anomalies.
 */

import type { Anomaly, AnomalyType } from './types.js';
import type { ShadowStrategy, ShadowInputs } from './shadow-detector.js';

// --- Pane semantics ---

export type PaneState =
  | 'input_prompt'       // Agent is waiting for user input (Claude or Codex prompt visible)
  | 'permission_dialog'  // Permission request visible (Allow/Deny)
  | 'shell_prompt'       // Claude Code has exited, shell prompt visible ($, %, or user@host)
  | 'streaming'          // LLM is actively streaming/thinking
  | 'unknown';           // Can't determine

export interface PaneSemantics {
  state: PaneState;
  confidence: 'high' | 'low';
  matchedText?: string;
}

// --- Pattern matching ---

// Claude Code's input prompt: ❯ on its own line, often surrounded by horizontal rules.
const CLAUDE_INPUT_PROMPT_RE = /^❯\s*$/;

// Codex idle composer row. Excludes numbered selection rows like "› 1. Yes, proceed (y)".
const CODEX_INPUT_PROMPT_RE = /^› (?!\d+\.)\S.*$/;
// Codex composer/footer line that accompanies the idle prompt.
const CODEX_COMPOSER_FOOTER_RE = /^\s{2}(?:gpt-[\w.-].*|Fast on\s*$|.*Plan mode.*|.*(?:% left|context left).*)$/i;

// Claude Code uses ❯ as the prompt character. When waiting for input,
// one of the last non-empty lines will be just "❯" or "❯ " (possibly with trailing spaces).
// The status bar line (with "esc to interrupt", "ctrl+t", etc.) appears below it.

// Permission dialog: Claude Code shows tool name + "Allow" / "Deny" options.
const PERMISSION_ALLOW_DENY_RE = /\bAllow\b.*\bDeny\b|\ballow\b.*\bdeny\b/i;
const PERMISSION_QUESTION_RE = /allow.*tool|permission|approve.*tool/i;
// Codex approvals have specific prompt text distinct from generic popups.
const CODEX_PERMISSION_RE = /would you like to (?:run the following command|grant these permissions|make the following edits)\?|allow\s+run the tool and continue\./i;

// Shell prompt patterns: user has exited Claude Code and is back at the shell
// Matches: $ (bash), % (zsh), user@host patterns, or the shell prompt after exit
const SHELL_PROMPT_RE = /^[\w.-]*@[\w.-]*[:%~].*[$#%]\s*$|^\$\s*$|^%\s*$/;

// Streaming/thinking indicators. Codex uses a status row with "esc to interrupt"
// while the composer stays visible, so the prompt line alone is not sufficient.
const STREAMING_RE = /Thinking|Pollinating|✢|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Running…|Streaming/i;

// Shared footer/status hints for Claude/Codex terminals.
const STATUS_BAR_RE = /esc to interrupt|ctrl\+[a-z]|shift\+tab|tab to queue message/i;
// Codex repaints an active status line with elapsed time while the model works.
// That timer churn is not meaningful output for stuck detection.
const ACTIVE_STATUS_LINE_RE = /^[•●].*\(\d+[smh].*\besc to interrupt\)$/i;

const VOLATILE_ACTIVITY_LINE_RES = [
  STATUS_BAR_RE,
  CODEX_COMPOSER_FOOTER_RE,
  ACTIVE_STATUS_LINE_RE,
];

/**
 * Analyze pane text to determine what the managed agent is currently showing.
 *
 * Examines the last ~15 non-empty lines of the pane capture.
 * Returns 'unknown' when no pattern matches — never guesses.
 */
export function analyzePaneSemantics(paneText: string): PaneSemantics {
  if (!paneText.trim()) {
    return { state: 'unknown', confidence: 'low' };
  }

  // Get the last non-empty lines (Claude Code UI is at the bottom of the terminal)
  const lines = paneText.split('\n');
  const lastLines = lines
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-15);

  if (lastLines.length === 0) {
    return { state: 'unknown', confidence: 'low' };
  }

  // Check for permission dialog (highest priority — blocking state)
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

  // Check for input prompt. Claude and Codex render different prompts.
  // Claude: bare ❯ even while a status bar is present.
  // Codex: composer line beginning with ›, but only when there is no active
  // "esc to interrupt" status row in the recent pane.
  const nonStatusLines = lastLines.filter((l) => !STATUS_BAR_RE.test(l));
  for (let i = nonStatusLines.length - 1; i >= Math.max(0, nonStatusLines.length - 5); i--) {
    if (CLAUDE_INPUT_PROMPT_RE.test(nonStatusLines[i])) {
      return { state: 'input_prompt', confidence: 'high', matchedText: nonStatusLines[i].trim() };
    }
  }
  const hasActiveStatusBar = lastLines.some((l) => STATUS_BAR_RE.test(l));
  const hasCodexComposerFooter = lastLines.some((l) => CODEX_COMPOSER_FOOTER_RE.test(l));
  if (!hasActiveStatusBar) {
    for (let i = nonStatusLines.length - 1; i >= Math.max(0, nonStatusLines.length - 5); i--) {
      if (hasCodexComposerFooter && CODEX_INPUT_PROMPT_RE.test(nonStatusLines[i])) {
        return { state: 'input_prompt', confidence: 'high', matchedText: nonStatusLines[i].trim() };
      }
    }
  }

  // Check for streaming/thinking (active work)
  for (let i = lastLines.length - 1; i >= Math.max(0, lastLines.length - 5); i--) {
    if (STREAMING_RE.test(lastLines[i])) {
      return { state: 'streaming', confidence: 'low', matchedText: lastLines[i].trim() };
    }
  }

  // Check for shell prompt (Claude Code has exited)
  const lastLine = lastLines[lastLines.length - 1];
  if (SHELL_PROMPT_RE.test(lastLine)) {
    // Only if there's no status bar (status bar means Claude is still running)
    const hasStatusBar = lastLines.some((l) => STATUS_BAR_RE.test(l));
    if (!hasStatusBar) {
      return { state: 'shell_prompt', confidence: 'high', matchedText: lastLine.trim() };
    }
  }

  return { state: 'unknown', confidence: 'low' };
}

/**
 * Normalize pane text for activity comparison.
 *
 * Raw tmux captures include volatile UI chrome such as elapsed-time status
 * rows and Codex composer footers. Those redraw frequently without indicating
 * meaningful agent progress, so the watchdog strips them before diffing panes.
 */
export function normalizePaneForActivity(paneText: string): string {
  if (!paneText.trim()) return '';

  return paneText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !VOLATILE_ACTIVITY_LINE_RES.some((re) => re.test(line)))
    .join('\n')
    .trim();
}

// --- Shadow strategy ---

/**
 * Maps pane states to anomaly types for shadow comparison.
 * Only maps states that correspond to actionable anomalies.
 */
function paneStateToAnomaly(agentId: string, semantics: PaneSemantics): Anomaly | null {
  if (semantics.confidence === 'low') return null; // Only act on high-confidence matches

  switch (semantics.state) {
    case 'input_prompt':
      return {
        agentId,
        type: 'needs_input',
        severity: 'info',
        explanation: `Pane shows input prompt: "${semantics.matchedText ?? '❯'}"`,
        detectedAt: new Date(),
        confidence: semantics.confidence,
      };
    case 'permission_dialog':
      return {
        agentId,
        type: 'permission_blocked',
        severity: 'warning',
        explanation: `Pane shows permission dialog: "${semantics.matchedText ?? 'Allow/Deny'}"`,
        detectedAt: new Date(),
        confidence: semantics.confidence,
      };
    case 'shell_prompt':
      return {
        agentId,
        type: 'stale_agent',
        severity: 'warning',
        explanation: `Pane shows shell prompt — Claude Code may have exited: "${semantics.matchedText ?? '$'}"`,
        detectedAt: new Date(),
        confidence: semantics.confidence,
      };
    default:
      return null;
  }
}

export class PaneSemanticsStrategy implements ShadowStrategy {
  readonly source = 'pane_semantics' as const;

  evaluate(agentId: string, inputs: ShadowInputs): Anomaly | null {
    const semantics = analyzePaneSemantics(inputs.paneText);
    return paneStateToAnomaly(agentId, semantics);
  }
}
