/**
 * Permission prompt quick-action extraction from terminal pane content.
 *
 * Parses tmux capture-pane output to detect Claude Code's permission menus
 * ("Do you want to proceed? 1. Yes / 2. No") and generates keystroke-based
 * quick-action buttons.
 *
 * CRITICAL: Uses anchor-scoped parsing to prevent false positives from
 * numbered lists in agent output above the permission prompt.
 *
 * See: docs/rfc/rfc-interactive-prompt-quick-actions.md
 */

import type { QuickAction } from './response-assist.js';

export interface PermissionQuickAction extends QuickAction {
  keystroke: string;  // Raw key to send via sendKeystroke (no trailing Enter)
}

interface MenuOption {
  number: number;
  text: string;
}

type OptionClass = 'allow-once' | 'allow-persistent' | 'deny' | 'unknown';

/**
 * Extract quick actions from a terminal pane showing a permission prompt.
 *
 * Three-layer false-positive defense:
 * 1. Anchor-scoped: only parse lines AFTER "Do you want to proceed?"
 * 2. Consecutive-from-1: options must be 1, 2, 3... in order
 * 3. Break-on-non-match: stop at first non-numbered non-empty line
 */
export function extractPermissionActions(
  toolName: string,
  toolInput?: unknown,
  paneContent?: string,
): PermissionQuickAction[] {
  if (!paneContent) return [];

  // Layer 1: Find the anchor and scope to menu region only
  const menuRegion = extractMenuRegion(paneContent);
  if (!menuRegion) return [];

  // Extract numbered options from the scoped region
  const options = parseNumberedMenuOptions(menuRegion);

  // Layer 2: Need at least 2 consecutive options starting from 1
  if (options.length < 2) return [];
  if (!isConsecutiveFrom1(options)) return [];

  const toolSummary = formatToolSummary(toolName, toolInput);

  return options.map((opt, i) => {
    const classification = classifyOption(opt.text);
    const label = classification === 'allow-once'
      ? `Allow: ${toolSummary}`
      : classification === 'allow-persistent'
        ? `Always allow: ${truncate(opt.text, 60)}`
        : classification === 'deny'
          ? 'Deny'
          : truncate(opt.text, 60);

    return {
      label,
      value: opt.text,
      keystroke: String(opt.number),
      shortcut: i === 0 ? 'y' : i === options.length - 1 ? 'n' : String(opt.number),
    };
  });
}

/**
 * Extract only the menu region — text AFTER the LAST "Do you want to proceed?" line.
 *
 * Uses findLastIndex because:
 * 1. Claude Code always renders the permission menu at the bottom of the terminal.
 * 2. Earlier occurrences in the pane may be quoted text, command arguments, or
 *    agent output that happens to contain the phrase.
 * 3. The real menu is always the bottommost occurrence.
 *
 * This is the critical false-positive defense: everything above the prompt
 * is agent output (may contain numbered lists) and MUST be excluded.
 * @internal Exported for testing only — not part of the public API.
 */
export function extractMenuRegion(pane: string): string | null {
  const lines = pane.split('\n');
  // Find the LAST occurrence (ES2022-compatible — no findLastIndex)
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/do you want to proceed/i.test(lines[i])) {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx === -1) return null;
  return lines.slice(promptIdx + 1).join('\n');
}

/**
 * Parse numbered menu options from the menu region (NOT the full pane).
 * Stops at the first non-matching, non-empty line.
 * @internal Exported for testing only — not part of the public API.
 */
export function parseNumberedMenuOptions(menuRegion: string): MenuOption[] {
  const options: MenuOption[] = [];
  for (const line of menuRegion.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match: optional cursor indicator, number, dot, text
    const m = trimmed.match(/^[❯>]?\s*(\d+)\.\s+(.+)/);
    if (m) {
      options.push({ number: parseInt(m[1], 10), text: m[2].trim() });
    } else {
      // First non-numbered, non-empty line = end of menu
      break;
    }
  }
  return options;
}

/**
 * Validate options are consecutive integers starting from 1.
 * @internal Exported for testing only — not part of the public API.
 */
export function isConsecutiveFrom1(options: MenuOption[]): boolean {
  return options.every((opt, i) => opt.number === i + 1);
}

/** @internal Exported for testing only — not part of the public API. */
export function classifyOption(text: string): OptionClass {
  const lower = text.toLowerCase();
  if (lower === 'no') return 'deny';
  if (lower === 'yes') return 'allow-once';
  if (lower.startsWith('yes,') && /allow/i.test(lower)) return 'allow-persistent';
  return 'unknown';
}

function formatToolSummary(toolName: string, toolInput?: unknown): string {
  if (!toolInput) return toolName;
  const input = toolInput as Record<string, unknown>;
  const cmd = input.command ?? input.file_path ?? input.content;
  if (typeof cmd === 'string') {
    const short = cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
    return `${toolName}: \`${short}\``;
  }
  return toolName;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
