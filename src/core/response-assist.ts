/**
 * Quick-action extraction from agent messages.
 *
 * Parses the agent's last message to detect binary/multiple-choice questions
 * and generates clickable quick-action buttons for the UI.
 *
 * See: docs/rfc/rfc-smart-response-assist.md
 */

const MAX_OPTIONS = 5;

export interface QuickAction {
  label: string;    // Button text shown in UI
  value: string;    // Text sent to agent when clicked
  shortcut?: string; // Optional keyboard shortcut key
}

/**
 * Extract quick actions from an agent's last message.
 * Returns an empty array if no structured question is detected.
 *
 * Note: Numbered/lettered option extraction is intentionally excluded.
 * Real-world data shows Claude Code never produces text-based "pick one"
 * numbered menus — it uses AskUserQuestion with choices instead. Every
 * numbered list in agent output is a plan, summary, or list of questions,
 * causing 100% false-positive rate. See docs/rfc/rfc-numbered-list-disambiguation.md
 */
export function extractQuickActions(message: string): QuickAction[] {
  if (!message || !message.trim()) return [];

  // 1. Yes/No questions
  if (isYesNoQuestion(message)) {
    return [
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ];
  }

  // 2. Continue/stop pattern
  if (isContinueQuestion(message)) {
    return [
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ];
  }

  return [];
}

/**
 * Determine whether smart assist (quick actions + AI suggestions)
 * should be offered for a given anomaly type and event context.
 *
 * Returns false for permission_blocked (interactive terminal menu)
 * and AskUserQuestion with fixed choices (interactive selection).
 */
export function shouldOfferAssist(
  anomalyType: string,
  events: Array<{ type: string; toolName?: string; toolInput?: unknown }>,
): boolean {
  // Never suggest for permission prompts (interactive menu in terminal)
  if (anomalyType === 'permission_blocked') return false;

  // Check if AskUserQuestion has fixed choices (interactive menu)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'tool_result' || e.type === 'input_received') break;
    if (e.type === 'tool_use' && e.toolName === 'AskUserQuestion') {
      const input = e.toolInput as Record<string, unknown> | undefined;
      if (input && Array.isArray(input.choices) && input.choices.length > 0) {
        return false;
      }
    }
  }

  return true;
}

// --- Pattern matchers ---

const YES_NO_INDICATORS = [
  'do you want',
  'should i',
  'would you like',
  'shall i',
  'can i',
  'want me to',
  'okay to',
  'is that correct',
  'does that look',
  'ready to',
  'do you agree',
  'is this what',
  'does this look',
  'are you sure',
  'do you approve',
  'may i',
  'is it ok',
  'is it okay',
];

const CONTINUE_INDICATORS = [
  'shall i continue',
  'should i continue',
  'want me to continue',
  'do you want me to proceed',
  'should i proceed',
  'shall i proceed',
  'shall i go ahead',
  'should i go ahead',
  'want me to go ahead',
  'ready for me to continue',
  'keep going',
  'move on to',
  'move forward',
];

// Interrogative words that signal open-ended questions (not yes/no)
const OPEN_ENDED_STARTERS = [
  'what ', 'how ', 'which ', 'where ', 'when ', 'why ', 'who ',
  'what\'s', 'how\'s', 'where\'s', 'when\'s', 'who\'s',
];

/** @internal Exported for testing only — not part of the public API. */
export function isYesNoQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  // Must contain a question mark on the last non-empty line
  const lines = lower.split('\n').filter(l => l.trim());
  const lastLine = lines[lines.length - 1] ?? '';
  if (!lastLine.includes('?')) return false;

  // Must not be a continue question (handled separately with better labels)
  if (CONTINUE_INDICATORS.some(p => lower.includes(p))) return false;

  // Exclude open-ended questions starting with interrogative words
  const trimmedLast = lastLine.trim();
  if (OPEN_ENDED_STARTERS.some(w => trimmedLast.startsWith(w))) return false;

  // Must contain a yes/no indicator
  return YES_NO_INDICATORS.some(p => lower.includes(p));
}

/** @internal Exported for testing only — not part of the public API. */
export function isContinueQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  return CONTINUE_INDICATORS.some(p => lower.includes(p));
}

/** @internal Exported for testing only — not part of the public API. */
export function extractNumberedOptions(message: string): QuickAction[] {
  const lines = message.split('\n');
  const opts: QuickAction[] = [];
  for (const line of lines) {
    // Match "1. Some option" or "1) Some option" or "(1) Some option"
    const m = line.match(/^\s*\(?(\d+)[.)]\)?\s+(.+)/);
    if (m) {
      const num = m[1];
      const text = m[2].trim();
      opts.push({
        label: text.length > 120 ? text.slice(0, 117) + '...' : text,
        value: num,
        shortcut: num,
      });
    }
  }
  return opts.slice(0, MAX_OPTIONS);
}

/** @internal Exported for testing only — not part of the public API. */
export function extractLetteredOptions(message: string): QuickAction[] {
  const lines = message.split('\n');
  const opts: QuickAction[] = [];
  for (const line of lines) {
    // Match "(a) Some option" or "a) Some option" or "a. Some option"
    const m = line.match(/^\s*\(?([a-z])[.)]\)?\s+(.+)/i);
    if (m) {
      const letter = m[1].toLowerCase();
      const text = m[2].trim();
      opts.push({
        label: text.length > 120 ? text.slice(0, 117) + '...' : text,
        value: letter,
        shortcut: letter,
      });
    }
  }
  return opts.slice(0, MAX_OPTIONS);
}
