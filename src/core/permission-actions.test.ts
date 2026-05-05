import { describe, test, expect } from 'vitest';
import {
  extractPermissionActions,
  extractMenuRegion,
  parseNumberedMenuOptions,
  isConsecutiveFrom1,
  classifyOption,
} from './permission-actions.js';

// ════════════════════════════════════════════════════════════════
// Real terminal snapshots captured from live Kookr sessions
// ════════════════════════════════════════════════════════════════

const REAL_SNAPSHOT_2OPT = `  4. RooCodeInc/Roo-Code (23k stars) — Apache-2.0, TypeScript, 764 open issues, CONTRIBUTING.md. The most contributor-friendly of the major VS Code agent extensions. Easier to land PRs than
  Cursor/Windsurf since it's fully open source.
  5. continuedev/continue (32k stars) — Apache-2.0, TypeScript, 435 open issues. Another major open-source AI code assistant. Strong community, TypeScript-native, well-structured.

  Contribution Strategy Tips

  - Start with documentation/test PRs — they get merged faster and establish you as a contributor
  - Pick repos with CONTRIBUTING.md — your PR won't rot in the queue
  - Fix open issues rather than proposing features — much higher merge rate
  - Target repos where your Kookr work gives you unique insight (Claude Code hooks, MCP servers, agent orchestration)
  - A few merged PRs in 2-3 top-tier repos beats many PRs in obscure repos — recruiters recognize names, not commit counts

✻ Cogitated for 1m 34s

❯ claude code and codexcli doesn't accept any external contributions. Find others

● Good to know. Let me find repos that actually accept external PRs — I'll check for merged external contributions as a ground-truth signal.

● Bash(# Check recent merged PRs from external contributors for candidate repos
      for repo in modelcontextprotocol/servers All-Hands-AI/OpenHands aider-ai/aider BerriAI/…)
  ⎿  Running…

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command

   # Check recent merged PRs from external contributors for candidate repos
   for repo in modelcontextprotocol/servers All-Hands-AI/OpenHands aider-ai/aider BerriAI/litellm crewAIInc/crewAI block/goose continuedev/continue RooCodeInc/Roo-Code google/adk-python
   SWE-agent/SWE-agent Kilo-Org/kilocode microsoft/autogen; do
     echo "=== $repo ==="
     gh api "repos/$repo/pulls?state=closed&sort=updated&direction=desc&per_page=5" --jq '[.[] | select(.merged_at != null) | {user: .user.login, merged: .merged_at, title: .title}] | .[:3]'
   2>&1
     echo "---"
   done
   Check recent merged PRs from external contributors

 Command contains newlines that could separate multiple commands

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

const REAL_SNAPSHOT_3OPT = `  1460 +  font-size: 11px;
      1461 +}
      1462 +
      1463 +.shortcuts-footer {
      1464 +  margin-top: 16px;
      1465 +  padding-top: 12px;
      1466 +  border-top: 1px solid var(--border-dim);
      1467 +  text-align: center;
      1468 +  font-size: 11px;
      1469 +  color: var(--text-muted);
      1470 +}

● Now let me verify the build works:

● Bash(cd /home/jean/git/kookr-shortcuts-help && npx tsc --noEmit 2>&1 | head -30)
  ⎿  Running…

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command

   cd /home/jean/git/kookr-shortcuts-help && npx tsc --noEmit 2>&1 | head -30
   Type-check the project

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from kookr-shortcuts-help/ from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

// ════════════════════════════════════════════════════════════════
// Synthetic test panes
// ════════════════════════════════════════════════════════════════

// Case 3: Numbered questions — NO permission prompt
const NUMBERED_QUESTIONS = `RFC is ready at docs/rfc/rfc-task-action-buttons.md. Here's a summary of what it covers:

**A. Visual Redesign** — Replace plain text links with proper button elements
**B. Lifecycle Redesign** — Replace the single Stop button with two distinct outcomes
**C. Conditional visibility** — Only show relevant buttons per task state

**Open questions** for your input:
1. Should "Complete" require confirmation (it kills sessions)?
2. Keep a session-level "Stop" for multi-session tasks, or only task-level actions?
3. Keep "Attach" for completed tasks (tmux session is already dead)?
4. Naming: "Cancel" vs "Abort"?

Waiting for your instructions.`;

// Case 4: Numbered findings FOLLOWED by permission prompt (critical mixed case)
const MIXED_NUMBERED_THEN_PERMISSION = `Key findings from the analysis:
1. Token refresh is broken when the device goes offline
2. Auth middleware silently ignores expired sessions
3. Rate limiter has no exponential backoff
4. WebSocket reconnection drops pending messages
5. Cache invalidation race condition on concurrent writes

I'll fix these issues. Let me start with the auth middleware.

● Bash(cd src/auth && npm test 2>&1 | head -50)
  ⎿  Running…

─────────────────────────────────────────────────────────────────
 Bash command

   cd src/auth && npm test 2>&1 | head -50
   Run auth tests

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend · ctrl+e to explain`;

// Case 5: Numbered plan steps — NO permission prompt
const NUMBERED_PLAN = `I'll implement the feature in these steps:

1. Create the new TypeScript module in src/core/
2. Add unit tests with Vitest
3. Wire up the HTTP endpoint in the server
4. Update the frontend store
5. Add E2E test with Playwright

Let me start with step 1.

● Read(src/core/types.ts)
  ⎿  Reading file...

The types file has 139 lines. I can see the existing type definitions.
Now let me create the new module.`;

// Case 6: Tricky list with "Yes"/"No" items but NO permission prompt
const TRICKY_YES_NO_LIST = `Here are the test results:

1. Yes, the auth module passes all tests
2. No, the rate limiter still has the race condition
3. Yes, the WebSocket reconnection is fixed
4. No changes needed for the cache module

All critical issues are resolved. Should I proceed with the PR?`;

// Case 7: Permission prompt with non-standard numbering (starts at 0)
const BAD_NUMBERING = `● Bash(rm -rf node_modules)
  ⎿  Running…

 Do you want to proceed?
 ❯ 0. Yes
   1. No

 Esc to cancel`;

// Case 8: Empty pane
const EMPTY_PANE = ``;

// Case 9: Permission prompt with no options below (corrupted terminal)
const PROMPT_NO_OPTIONS = ` Do you want to proceed?

 Esc to cancel · Tab to amend · ctrl+e to explain`;

// Case 10: Agent output that coincidentally contains "Do you want to proceed" as text
// (e.g., quoting a log message), followed by numbered summary — NOT a real permission prompt
const QUOTED_PROMPT_TEXT = `I found the issue. The error message says:

  "The user was asked: Do you want to proceed? and they clicked Cancel"

Here are the affected endpoints:
1. POST /api/sessions — session creation flow
2. DELETE /api/sessions/:id — session teardown
3. PUT /api/sessions/:id/extend — session extension

All three need the same fix.`;


// ════════════════════════════════════════════════════════════════
// Unit tests: extractMenuRegion
// ════════════════════════════════════════════════════════════════

describe('extractMenuRegion', () => {
  test('returns text after "Do you want to proceed?" line', () => {
    const pane = `some output\n Do you want to proceed?\n ❯ 1. Yes\n   2. No`;
    const region = extractMenuRegion(pane);
    expect(region).toBe(' ❯ 1. Yes\n   2. No');
  });

  test('returns null when no prompt found', () => {
    expect(extractMenuRegion(NUMBERED_QUESTIONS)).toBeNull();
    expect(extractMenuRegion(NUMBERED_PLAN)).toBeNull();
    expect(extractMenuRegion(TRICKY_YES_NO_LIST)).toBeNull();
    expect(extractMenuRegion(EMPTY_PANE)).toBeNull();
  });

  test('scopes to AFTER prompt — excludes numbered content above', () => {
    const region = extractMenuRegion(MIXED_NUMBERED_THEN_PERMISSION)!;
    expect(region).not.toBeNull();
    // Should NOT contain the "1. Token refresh" findings
    expect(region).not.toContain('Token refresh');
    expect(region).not.toContain('Auth middleware');
    // Should contain the menu options
    expect(region).toContain('1. Yes');
    expect(region).toContain('2. No');
  });

  test('works with real 2-option snapshot', () => {
    const region = extractMenuRegion(REAL_SNAPSHOT_2OPT)!;
    expect(region).not.toBeNull();
    // Must not contain agent output (contribution strategy tips, repo stars, etc.)
    expect(region).not.toContain('RooCodeInc');
    expect(region).not.toContain('Contribution Strategy');
    // Must contain menu
    expect(region).toContain('1. Yes');
  });

  test('works with real 3-option snapshot', () => {
    const region = extractMenuRegion(REAL_SNAPSHOT_3OPT)!;
    expect(region).not.toBeNull();
    expect(region).not.toContain('font-size');
    expect(region).toContain('1. Yes');
    expect(region).toContain('allow reading from');
    expect(region).toContain('3. No');
  });
});

// ════════════════════════════════════════════════════════════════
// Unit tests: parseNumberedMenuOptions
// ════════════════════════════════════════════════════════════════

describe('parseNumberedMenuOptions', () => {
  test('parses 2-option menu', () => {
    const region = ' ❯ 1. Yes\n   2. No\n\n Esc to cancel';
    const opts = parseNumberedMenuOptions(region);
    expect(opts).toEqual([
      { number: 1, text: 'Yes' },
      { number: 2, text: 'No' },
    ]);
  });

  test('parses 3-option menu', () => {
    const region = ' ❯ 1. Yes\n   2. Yes, allow reading from kookr-shortcuts-help/ from this project\n   3. No\n\n Esc to cancel';
    const opts = parseNumberedMenuOptions(region);
    expect(opts).toEqual([
      { number: 1, text: 'Yes' },
      { number: 2, text: 'Yes, allow reading from kookr-shortcuts-help/ from this project' },
      { number: 3, text: 'No' },
    ]);
  });

  test('stops at non-numbered non-empty line', () => {
    const region = ' ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend';
    const opts = parseNumberedMenuOptions(region);
    expect(opts).toEqual([
      { number: 1, text: 'Yes' },
      { number: 2, text: 'No' },
    ]);
  });

  test('returns empty for non-menu content', () => {
    const region = ' Esc to cancel · Tab to amend · ctrl+e to explain';
    expect(parseNumberedMenuOptions(region)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// Unit tests: isConsecutiveFrom1
// ════════════════════════════════════════════════════════════════

describe('isConsecutiveFrom1', () => {
  test('accepts 1, 2', () => {
    expect(isConsecutiveFrom1([{ number: 1, text: 'a' }, { number: 2, text: 'b' }])).toBe(true);
  });

  test('accepts 1, 2, 3', () => {
    expect(isConsecutiveFrom1([
      { number: 1, text: 'a' },
      { number: 2, text: 'b' },
      { number: 3, text: 'c' },
    ])).toBe(true);
  });

  test('rejects 0, 1 (starts at 0)', () => {
    expect(isConsecutiveFrom1([{ number: 0, text: 'a' }, { number: 1, text: 'b' }])).toBe(false);
  });

  test('rejects 1, 3 (gap)', () => {
    expect(isConsecutiveFrom1([{ number: 1, text: 'a' }, { number: 3, text: 'b' }])).toBe(false);
  });

  test('rejects 2, 3 (starts at 2)', () => {
    expect(isConsecutiveFrom1([{ number: 2, text: 'a' }, { number: 3, text: 'b' }])).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Unit tests: classifyOption
// ════════════════════════════════════════════════════════════════

describe('classifyOption', () => {
  test('classifies "Yes" as allow-once', () => {
    expect(classifyOption('Yes')).toBe('allow-once');
  });

  test('classifies "No" as deny', () => {
    expect(classifyOption('No')).toBe('deny');
  });

  test('classifies persistent allow', () => {
    expect(classifyOption('Yes, allow reading from kookr-shortcuts-help/ from this project')).toBe('allow-persistent');
  });

  test('classifies unknown options', () => {
    expect(classifyOption('Maybe')).toBe('unknown');
    expect(classifyOption('Skip this')).toBe('unknown');
  });
});

// ════════════════════════════════════════════════════════════════
// Integration tests: extractPermissionActions (full pipeline)
// ════════════════════════════════════════════════════════════════

describe('extractPermissionActions', () => {
  describe('TRUE POSITIVES: should detect permission menus', () => {
    test('real snapshot: 2-option permission menu', () => {
      const actions = extractPermissionActions('Bash', { command: 'git status' }, REAL_SNAPSHOT_2OPT);
      expect(actions).toHaveLength(2);
      expect(actions[0].label).toContain('Allow');
      expect(actions[0].keystroke).toBe('1');
      expect(actions[0].shortcut).toBe('y');
      expect(actions[1].label).toBe('Deny');
      expect(actions[1].keystroke).toBe('2');
      expect(actions[1].shortcut).toBe('n');
    });

    test('real snapshot: 3-option permission menu', () => {
      const actions = extractPermissionActions(
        'Bash',
        { command: 'cd /home/jean/git/kookr-shortcuts-help && npx tsc --noEmit' },
        REAL_SNAPSHOT_3OPT,
      );
      expect(actions).toHaveLength(3);
      expect(actions[0].label).toContain('Allow');
      expect(actions[0].keystroke).toBe('1');
      expect(actions[0].shortcut).toBe('y');
      expect(actions[1].label).toContain('Always allow');
      expect(actions[1].keystroke).toBe('2');
      expect(actions[2].label).toBe('Deny');
      expect(actions[2].keystroke).toBe('3');
      expect(actions[2].shortcut).toBe('n');
    });

    test('synthetic: mixed numbered content + permission prompt — only detects menu', () => {
      const actions = extractPermissionActions(
        'Bash',
        { command: 'cd src/auth && npm test' },
        MIXED_NUMBERED_THEN_PERMISSION,
      );
      // CRITICAL: must detect only Yes/No, NOT the 5 findings above the prompt
      expect(actions).toHaveLength(2);
      expect(actions[0].keystroke).toBe('1');
      expect(actions[1].keystroke).toBe('2');
      // Must not contain findings text
      expect(actions.map(a => a.value)).not.toContain('Token refresh is broken when the device goes offline');
    });
  });

  describe('TRUE NEGATIVES: must NOT detect these as permission menus', () => {
    test('numbered questions (no permission prompt)', () => {
      const actions = extractPermissionActions('Bash', { command: 'test' }, NUMBERED_QUESTIONS);
      expect(actions).toEqual([]);
    });

    test('numbered plan steps (no permission prompt)', () => {
      const actions = extractPermissionActions('Read', undefined, NUMBERED_PLAN);
      expect(actions).toEqual([]);
    });

    test('tricky yes/no list items (no permission prompt)', () => {
      const actions = extractPermissionActions('Bash', undefined, TRICKY_YES_NO_LIST);
      expect(actions).toEqual([]);
    });

    test('non-standard numbering starting at 0', () => {
      const actions = extractPermissionActions('Bash', { command: 'rm -rf node_modules' }, BAD_NUMBERING);
      expect(actions).toEqual([]);
    });

    test('empty pane', () => {
      const actions = extractPermissionActions('Bash', undefined, EMPTY_PANE);
      expect(actions).toEqual([]);
    });

    test('no pane content (undefined)', () => {
      const actions = extractPermissionActions('Bash', undefined, undefined);
      expect(actions).toEqual([]);
    });

    test('permission prompt text but no numbered options below', () => {
      const actions = extractPermissionActions('Bash', undefined, PROMPT_NO_OPTIONS);
      expect(actions).toEqual([]);
    });

    test('quoted "Do you want to proceed" in agent output — NOT a real prompt', () => {
      // The text "Do you want to proceed" appears in a quoted log message.
      // findLastIndex finds it (it's the only occurrence).
      // The lines after it are: "? and they clicked Cancel"", then numbered endpoints.
      // parseNumberedMenuOptions will:
      //   - hit '" and they clicked Cancel"' — non-numbered, non-empty → BREAK
      // So it returns 0 options → no actions. SAFE!
      const actions = extractPermissionActions('Bash', undefined, QUOTED_PROMPT_TEXT);
      expect(actions).toEqual([]);
    });
  });

  describe('EDGE CASES', () => {
    test('permission prompt with extra blank lines between options', () => {
      const pane = `Some output\n\n Do you want to proceed?\n\n ❯ 1. Yes\n\n   2. No\n\n Esc to cancel`;
      const actions = extractPermissionActions('Bash', undefined, pane);
      // Blank lines between options are skipped, should still work
      expect(actions).toHaveLength(2);
    });

    test('permission prompt with very long option text', () => {
      const pane = ` Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, allow writing to /home/user/some/very/deeply/nested/directory/structure/that/goes/on/forever from this project\n   3. No`;
      const actions = extractPermissionActions('Bash', undefined, pane);
      expect(actions).toHaveLength(3);
      // Persistent allow label should be truncated
      expect(actions[1].label.length).toBeLessThanOrEqual(75); // "Always allow: " (15 chars) + truncated 60 chars
    });

    test('multiple "Do you want to proceed?" lines — uses LAST (bottommost)', () => {
      // Edge case: agent output mentions the phrase, then a real prompt appears.
      // findLastIndex returns the LAST match, so we parse from the real prompt.
      const pane = `The dialog shows "Do you want to proceed?" to the user.
Here is the implementation:
1. Parse the input
2. Validate the schema
3. Send the response

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel`;
      const actions = extractPermissionActions('Bash', undefined, pane);
      // The last "Do you want to proceed" is the real prompt → correctly detects menu.
      expect(actions).toHaveLength(2);
      expect(actions[0].keystroke).toBe('1');
      expect(actions[1].keystroke).toBe('2');
    });
  });
});
