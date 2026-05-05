import { describe, test, expect } from 'vitest';
import {
  extractQuickActions,
  shouldOfferAssist,
  isYesNoQuestion,
  isContinueQuestion,
  extractNumberedOptions,
  extractLetteredOptions,
} from './response-assist.js';

// =============================================================================
// extractQuickActions
// =============================================================================

describe('extractQuickActions', () => {
  // --- Empty / null inputs ---

  test('returns empty array for empty string', () => {
    expect(extractQuickActions('')).toEqual([]);
  });

  test('returns empty array for whitespace-only string', () => {
    expect(extractQuickActions('   \n\t  ')).toEqual([]);
  });

  test('returns empty array for statement (no question)', () => {
    expect(extractQuickActions('I have completed the refactor.')).toEqual([]);
  });

  test('returns empty array for open-ended question with interrogative word', () => {
    expect(extractQuickActions('What framework should I use?')).toEqual([]);
  });

  // --- Yes/No questions ---

  test('detects "Do you want me to..." as yes/no', () => {
    const actions = extractQuickActions('Do you want me to fix the failing test?');
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects "Do you want me to proceed..." as continue/stop', () => {
    const actions = extractQuickActions('Do you want me to proceed with the refactor?');
    expect(actions).toEqual([
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ]);
  });

  test('detects "Should I..." as yes/no', () => {
    const actions = extractQuickActions('Should I fix the failing tests first?');
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects "Would you like me to..." as yes/no', () => {
    const actions = extractQuickActions('Would you like me to add error handling?');
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects "Shall I..." as yes/no', () => {
    const actions = extractQuickActions('Shall I update the tests?');
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects "Is that correct?" as yes/no', () => {
    const actions = extractQuickActions('The config looks like this. Is that correct?');
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects "May I..." as yes/no', () => {
    const actions = extractQuickActions('May I delete the unused file?');
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects "Is it okay to..." as yes/no', () => {
    const actions = extractQuickActions('Is it okay to overwrite the config?');
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects multi-line message with question on last line', () => {
    const msg = `I've analyzed the codebase and found 3 issues.\n\nHere's what I found:\n- Bug in auth module\n- Missing tests\n- Deprecated API usage\n\nShould I fix all three?`;
    const actions = extractQuickActions(msg);
    expect(actions).toEqual([
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
  });

  test('detects continue pattern even without question mark', () => {
    const actions = extractQuickActions('Let me know if you want me to continue');
    expect(actions).toEqual([
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ]);
  });

  test('does not detect yes/no when no question mark', () => {
    expect(extractQuickActions('I will fix this for you')).toEqual([]);
  });

  // --- Continue/Stop questions ---

  test('detects "Shall I continue" as continue/stop', () => {
    const actions = extractQuickActions('I have finished step 1. Shall I continue with step 2?');
    expect(actions).toEqual([
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ]);
  });

  test('detects "Should I proceed" as continue/stop', () => {
    const actions = extractQuickActions('The tests pass. Do you want me to proceed with deployment?');
    expect(actions).toEqual([
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ]);
  });

  test('detects "should I go ahead" as continue/stop', () => {
    const actions = extractQuickActions('Should I go ahead and merge?');
    expect(actions).toEqual([
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ]);
  });

  test('detects "keep going" as continue/stop', () => {
    const actions = extractQuickActions('Done with file 3 of 10. Keep going?');
    expect(actions).toEqual([
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ]);
  });

  test('continue takes priority over yes/no when message contains continue indicators', () => {
    const actions = extractQuickActions('Should I continue with the next batch?');
    expect(actions).toEqual([
      { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
      { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
    ]);
  });

  // --- Numbered/lettered lists are NOT extracted (false-positive prevention) ---

  test('does not extract numbered lists as quick actions', () => {
    const msg = `Which approach do you prefer?\n1. Refactor the module\n2. Add tests first\n3. Do both`;
    expect(extractQuickActions(msg)).toEqual([]);
  });

  test('does not extract lettered lists as quick actions', () => {
    const msg = `Which one?\n(a) Refactor first\n(b) Test first\n(c) Both`;
    expect(extractQuickActions(msg)).toEqual([]);
  });

  test('returns empty when yes/no indicator is not on last line', () => {
    // "Should I" is on line 1 but last line is "2. JavaScript" (no question mark)
    const msg = `Should I use one of these?\n1. TypeScript\n2. JavaScript`;
    expect(extractQuickActions(msg)).toEqual([]);
  });

  // --- Regression: real numbered-list message that previously confused the disambiguator ---

  test('does not extract numbered open questions as choice menu (real-world regression)', () => {
    const msg = `RFC is ready at docs/rfc/rfc-task-action-buttons.md. Here's a summary:

**A. Visual Redesign** — Replace plain text with proper buttons...

**B. Lifecycle Redesign** — Replace the single "Stop" button...

**Open questions** for your input:
1. Should "Complete" require confirmation (it kills sessions)?
2. Keep a session-level "Stop" for multi-session tasks, or only task-level actions?
3. Keep "Attach" for completed tasks (tmux session is already dead)?
4. Naming: "Cancel" vs "Abort"?

Waiting for your instructions.`;

    expect(extractQuickActions(msg)).toEqual([]);
  });

  test('does not extract numbered summary items as choice menu (real-world)', () => {
    const msg = `Here's a summary of the changes:

**Key improvements:**

1. **Centered hero section** with status badges and quick doc links
2. **Visual proof in first screenful** — the UI mockup now appears immediately
3. **Scannable feature list** — 10 bolded feature bullets
4. **Single Quick Start section** — eliminated duplication`;

    expect(extractQuickActions(msg)).toEqual([]);
  });

  test('does not extract numbered plan steps as choice menu (real-world)', () => {
    const msg = `Launched a background agent. It will:

1. Read all design docs
2. Explore the full implementation
3. Systematically compare docs vs code
4. Produce a report
5. Create a PR targeting main`;

    expect(extractQuickActions(msg)).toEqual([]);
  });

  // --- Edge cases ---

  test('returns empty for complex open-ended question starting with "how"', () => {
    const msg = `How should I handle the edge case where the token is expired but the refresh endpoint is down?`;
    expect(extractQuickActions(msg)).toEqual([]);
  });

  test('returns empty for "what" questions even with yes/no indicators', () => {
    expect(extractQuickActions('What should I do next?')).toEqual([]);
  });

  test('returns empty for "which" questions', () => {
    expect(extractQuickActions('Which module needs work?')).toEqual([]);
  });
});

// =============================================================================
// shouldOfferAssist
// =============================================================================

describe('shouldOfferAssist', () => {
  test('returns true for needs_input with empty events', () => {
    expect(shouldOfferAssist('needs_input', [])).toBe(true);
  });

  test('returns false for permission_blocked', () => {
    expect(shouldOfferAssist('permission_blocked', [])).toBe(false);
  });

  test('returns false for permission_blocked even with events', () => {
    const events = [
      { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' } },
    ];
    expect(shouldOfferAssist('permission_blocked', events)).toBe(false);
  });

  test('returns true for needs_input with stop event', () => {
    const events = [
      { type: 'stop' },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(true);
  });

  test('returns true for needs_input with AskUserQuestion without choices', () => {
    const events = [
      { type: 'tool_use', toolName: 'AskUserQuestion', toolInput: { question: 'What color?' } },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(true);
  });

  test('returns false for AskUserQuestion with choices array', () => {
    const events = [
      {
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolInput: { question: 'Pick one', choices: ['a', 'b', 'c'] },
      },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(false);
  });

  test('returns true for AskUserQuestion with empty choices array', () => {
    const events = [
      {
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolInput: { question: 'What?', choices: [] },
      },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(true);
  });

  test('returns true when AskUserQuestion was already answered (tool_result after it)', () => {
    const events = [
      { type: 'tool_use', toolName: 'AskUserQuestion', toolInput: { question: 'Pick', choices: ['a', 'b'] } },
      { type: 'tool_result', toolName: 'AskUserQuestion' },
      { type: 'stop' },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(true);
  });

  test('returns true when AskUserQuestion was answered via input_received', () => {
    const events = [
      { type: 'tool_use', toolName: 'AskUserQuestion', toolInput: { question: 'Pick', choices: ['x', 'y'] } },
      { type: 'input_received' },
      { type: 'stop' },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(true);
  });

  test('returns true for repeated_error anomaly', () => {
    expect(shouldOfferAssist('repeated_error', [])).toBe(true);
  });

  test('returns true for merge_conflict anomaly', () => {
    expect(shouldOfferAssist('merge_conflict', [])).toBe(true);
  });

  test('handles AskUserQuestion with undefined toolInput', () => {
    const events = [
      { type: 'tool_use', toolName: 'AskUserQuestion', toolInput: undefined },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(true);
  });

  test('handles AskUserQuestion with null toolInput', () => {
    const events = [
      { type: 'tool_use', toolName: 'AskUserQuestion', toolInput: null },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(true);
  });

  test('scans backwards to find most recent unresolved AskUserQuestion', () => {
    const events = [
      { type: 'tool_use', toolName: 'Read' },
      { type: 'tool_result', toolName: 'Read' },
      { type: 'tool_use', toolName: 'AskUserQuestion', toolInput: { question: 'Pick', choices: ['a'] } },
    ];
    expect(shouldOfferAssist('needs_input', events)).toBe(false);
  });
});

// =============================================================================
// isYesNoQuestion (exported for direct testing)
// =============================================================================

describe('isYesNoQuestion', () => {
  test('returns true for basic yes/no questions', () => {
    expect(isYesNoQuestion('Do you want me to fix this?')).toBe(true);
    expect(isYesNoQuestion('Should I update the tests?')).toBe(true);
    expect(isYesNoQuestion('Would you like me to add docs?')).toBe(true);
    expect(isYesNoQuestion('Can I delete this file?')).toBe(true);
    expect(isYesNoQuestion('Are you sure about this?')).toBe(true);
    expect(isYesNoQuestion('Do you approve of the changes?')).toBe(true);
  });

  test('returns false when no question mark', () => {
    expect(isYesNoQuestion('Do you want me to fix this')).toBe(false);
    expect(isYesNoQuestion('Should I update the tests')).toBe(false);
  });

  test('returns false for open-ended questions starting with interrogative words', () => {
    expect(isYesNoQuestion('What should I do next?')).toBe(false);
    expect(isYesNoQuestion('How should I implement this?')).toBe(false);
    expect(isYesNoQuestion('Which module needs work?')).toBe(false);
    expect(isYesNoQuestion('Where should I put this file?')).toBe(false);
    expect(isYesNoQuestion('When should I run the migration?')).toBe(false);
    expect(isYesNoQuestion('Why is this test failing?')).toBe(false);
    expect(isYesNoQuestion('Who should review this PR?')).toBe(false);
  });

  test('returns false for continue questions (handled by isContinueQuestion)', () => {
    expect(isYesNoQuestion('Should I continue with the next step?')).toBe(false);
    expect(isYesNoQuestion('Shall I proceed with the merge?')).toBe(false);
  });

  test('detects question mark on last non-empty line', () => {
    expect(isYesNoQuestion('Here is the plan.\n\nShould I do it?\n')).toBe(true);
  });

  test('returns false for messages with question mark not on last line', () => {
    expect(isYesNoQuestion('Should I do it?\nHere is my plan.')).toBe(false);
  });
});

// =============================================================================
// isContinueQuestion
// =============================================================================

describe('isContinueQuestion', () => {
  test('detects continue indicators', () => {
    expect(isContinueQuestion('Shall I continue with the next batch?')).toBe(true);
    expect(isContinueQuestion('Should I proceed with the deployment?')).toBe(true);
    expect(isContinueQuestion('Want me to go ahead and merge?')).toBe(true);
    expect(isContinueQuestion('Ready for me to continue with step 3?')).toBe(true);
    expect(isContinueQuestion('Keep going with the refactor?')).toBe(true);
    expect(isContinueQuestion('Should I move on to the next file?')).toBe(true);
    expect(isContinueQuestion('Shall I move forward with the plan?')).toBe(true);
  });

  test('returns false for non-continue questions', () => {
    expect(isContinueQuestion('Should I fix this?')).toBe(false);
    expect(isContinueQuestion('Do you want me to add tests?')).toBe(false);
    expect(isContinueQuestion('What should I do?')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isContinueQuestion('SHALL I CONTINUE?')).toBe(true);
    expect(isContinueQuestion('KEEP GOING?')).toBe(true);
  });
});

// =============================================================================
// extractNumberedOptions (standalone — not used in extractQuickActions pipeline)
// =============================================================================

describe('extractNumberedOptions', () => {
  test('returns empty for no numbered lines', () => {
    expect(extractNumberedOptions('Just a regular message')).toEqual([]);
  });

  test('extracts dot-style numbered options', () => {
    const result = extractNumberedOptions('1. Alpha\n2. Beta');
    expect(result).toEqual([
      { label: 'Alpha', value: '1', shortcut: '1' },
      { label: 'Beta', value: '2', shortcut: '2' },
    ]);
  });

  test('extracts paren-style numbered options', () => {
    const result = extractNumberedOptions('1) First\n2) Second');
    expect(result).toEqual([
      { label: 'First', value: '1', shortcut: '1' },
      { label: 'Second', value: '2', shortcut: '2' },
    ]);
  });

  test('extracts wrapped-paren-style numbered options', () => {
    const result = extractNumberedOptions('(1) Alpha\n(2) Beta');
    expect(result).toEqual([
      { label: 'Alpha', value: '1', shortcut: '1' },
      { label: 'Beta', value: '2', shortcut: '2' },
    ]);
  });

  test('handles mixed text and options', () => {
    const msg = 'Choose one:\n1. Foo\nSome text\n2. Bar';
    const result = extractNumberedOptions(msg);
    expect(result).toEqual([
      { label: 'Foo', value: '1', shortcut: '1' },
      { label: 'Bar', value: '2', shortcut: '2' },
    ]);
  });

  test('handles double-digit numbers', () => {
    const msg = '10. Tenth option\n11. Eleventh option';
    const result = extractNumberedOptions(msg);
    expect(result).toEqual([
      { label: 'Tenth option', value: '10', shortcut: '10' },
      { label: 'Eleventh option', value: '11', shortcut: '11' },
    ]);
  });

  test('trims option text', () => {
    const result = extractNumberedOptions('1.   Spaced out   ');
    expect(result).toEqual([
      { label: 'Spaced out', value: '1', shortcut: '1' },
    ]);
  });
});

// =============================================================================
// extractLetteredOptions (standalone — not used in extractQuickActions pipeline)
// =============================================================================

describe('extractLetteredOptions', () => {
  test('returns empty for no lettered lines', () => {
    expect(extractLetteredOptions('Just text')).toEqual([]);
  });

  test('extracts paren-wrapped lettered options', () => {
    const result = extractLetteredOptions('(a) Alpha\n(b) Beta');
    expect(result).toEqual([
      { label: 'Alpha', value: 'a', shortcut: 'a' },
      { label: 'Beta', value: 'b', shortcut: 'b' },
    ]);
  });

  test('extracts dot-style lettered options', () => {
    const result = extractLetteredOptions('a. First\nb. Second');
    expect(result).toEqual([
      { label: 'First', value: 'a', shortcut: 'a' },
      { label: 'Second', value: 'b', shortcut: 'b' },
    ]);
  });

  test('normalizes uppercase to lowercase', () => {
    const result = extractLetteredOptions('(A) Upper\n(B) Case');
    expect(result).toEqual([
      { label: 'Upper', value: 'a', shortcut: 'a' },
      { label: 'Case', value: 'b', shortcut: 'b' },
    ]);
  });

  test('handles closing paren only', () => {
    const result = extractLetteredOptions('a) One\nb) Two');
    expect(result).toEqual([
      { label: 'One', value: 'a', shortcut: 'a' },
      { label: 'Two', value: 'b', shortcut: 'b' },
    ]);
  });
});
