import { describe, test, expect } from 'vitest';
import {
  analyzePaneSemantics,
  normalizePaneForActivity,
  PaneSemanticsStrategy,
} from './pane-patterns.js';

describe('analyzePaneSemantics', () => {
  describe('input prompt detection', () => {
    test('detects ❯ prompt at end of output', () => {
      const pane = [
        'Some tool output here',
        '─────────────────────────',
        '❯ ',
        '─────────────────────────',
        '  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ctrl+t to hide tasks',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('input_prompt');
      expect(result.confidence).toBe('high');
    });

    test('detects bare ❯ prompt', () => {
      const pane = [
        'Agent completed its work.',
        '',
        '❯',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('input_prompt');
      expect(result.confidence).toBe('high');
    });

    test('does not match ❯ in the middle of text', () => {
      const pane = [
        'The symbol ❯ appears in this line but is not a prompt',
        'More output here',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).not.toBe('input_prompt');
    });

    test('detects Codex idle composer prompt', () => {
      const pane = [
        '',
        '› Ask Codex to do anything',
        '',
        '  gpt-5.4 xhigh fast · 100% left · /tmp/project',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('input_prompt');
      expect(result.confidence).toBe('high');
    });

    test('does not detect Codex plugin popup rows as input prompt', () => {
      const pane = [
        '  Plugins',
        '  Browse plugins from available marketplaces.',
        '  Installed 1 of 4 available plugins.',
        '  Type to search plugins',
        '› Alpha Sync          Installed · Disabled   Press Enter to view plugin details.',
        '  Bravo Search        Available            · ChatGPT Marketplace · Search docs and tickets.',
        '',
        '  Press esc to close.',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).not.toBe('input_prompt');
    });

    test('does not detect Codex composer while agent is still running', () => {
      const pane = [
        '• Investigating rendering code (0s • esc to interrupt)',
        '',
        '› Summarize recent commits',
        '',
        '  tab to queue message                                       100% context left',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).not.toBe('input_prompt');
    });
  });

  describe('permission dialog detection', () => {
    test('detects Allow/Deny dialog', () => {
      const pane = [
        '● Bash(rm -rf /tmp/test)',
        '',
        '  Allow  Deny  allow-always',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('permission_dialog');
      expect(result.confidence).toBe('high');
    });

    test('detects allow/deny in various cases', () => {
      const pane = 'Do you want to Allow or Deny this tool?';
      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('permission_dialog');
    });

    test('detects Codex approval dialog', () => {
      const pane = [
        'Would you like to run the following command?',
        '',
        '$ echo hello world',
        '',
        '› 1. Yes, proceed (y)',
        '  2. Yes, and don\'t ask again for commands that start with `echo hello world` (p)',
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('permission_dialog');
      expect(result.confidence).toBe('high');
    });

    test('does not classify generic Codex confirmation popups as permission dialogs', () => {
      const pane = [
        '  Implement this plan?',
        '',
        '› 1. Yes, implement this plan  Switch to Default and start coding.',
        '  2. No, stay in Plan mode     Continue planning with the model.',
        '',
        '  Press enter to confirm or esc to go back',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).not.toBe('permission_dialog');
    });
  });

  describe('shell prompt detection', () => {
    test('detects bash $ prompt', () => {
      const pane = [
        'Claude Code exited.',
        '$',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('shell_prompt');
      expect(result.confidence).toBe('high');
    });

    test('detects zsh % prompt', () => {
      const pane = [
        'Process finished.',
        '%',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('shell_prompt');
      expect(result.confidence).toBe('high');
    });

    test('detects user@host prompt', () => {
      const pane = [
        'Exit code: 0',
        'jean@machine:~/git/kookr$',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('shell_prompt');
      expect(result.confidence).toBe('high');
    });

    test('does not detect shell prompt when status bar is present', () => {
      // If the status bar is visible, Claude is still running — the $ might be in output
      const pane = [
        'Some output with $',
        '$',
        '  esc to interrupt · ctrl+t to hide tasks',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).not.toBe('shell_prompt');
    });
  });

  describe('streaming detection', () => {
    test('detects Thinking indicator', () => {
      const pane = [
        'Some context',
        '✢ Thinking…',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('streaming');
      expect(result.confidence).toBe('low');
    });

    test('detects Pollinating indicator', () => {
      const pane = [
        '✢ Pollinating…',
        '  ⎿  ◻ Task 1',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('streaming');
      expect(result.confidence).toBe('low');
    });
  });

  describe('unknown state', () => {
    test('returns unknown for empty pane', () => {
      expect(analyzePaneSemantics('').state).toBe('unknown');
      expect(analyzePaneSemantics('   ').state).toBe('unknown');
    });

    test('returns unknown for unrecognized output', () => {
      const pane = [
        'Some random tool output',
        'Line 1 of many',
        'Line 2 of many',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('unknown');
      expect(result.confidence).toBe('low');
    });
  });

  describe('priority', () => {
    test('permission dialog takes priority over input prompt', () => {
      const pane = [
        '❯',
        '  Allow  Deny  allow-always',
      ].join('\n');

      const result = analyzePaneSemantics(pane);
      expect(result.state).toBe('permission_dialog');
    });
  });
});

describe('PaneSemanticsStrategy', () => {
  const strategy = new PaneSemanticsStrategy();

  test('returns needs_input for input prompt', () => {
    const anomaly = strategy.evaluate('agent-1', {
      paneText: '❯\n─────\n  esc to interrupt',
      realAnomaly: null,
    });
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe('needs_input');
  });

  test('returns needs_input for Codex idle prompt', () => {
    const anomaly = strategy.evaluate('agent-1', {
      paneText: '› Ask Codex to do anything\n\n  gpt-5.4 fast · 100% left · /tmp/project',
      realAnomaly: null,
    });
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe('needs_input');
  });

  test('returns permission_blocked for permission dialog', () => {
    const anomaly = strategy.evaluate('agent-1', {
      paneText: '  Allow  Deny  allow-always',
      realAnomaly: null,
    });
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe('permission_blocked');
  });

  test('returns stale_agent for shell prompt', () => {
    const anomaly = strategy.evaluate('agent-1', {
      paneText: 'Exit.\njean@host:~$',
      realAnomaly: null,
    });
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe('stale_agent');
  });

  test('returns null for unknown state', () => {
    const anomaly = strategy.evaluate('agent-1', {
      paneText: 'Some random output',
      realAnomaly: null,
    });
    expect(anomaly).toBeNull();
  });

  test('returns null for low-confidence streaming', () => {
    const anomaly = strategy.evaluate('agent-1', {
      paneText: '✢ Thinking…',
      realAnomaly: null,
    });
    // Streaming is low confidence — should not produce anomaly
    expect(anomaly).toBeNull();
  });

  test('has correct source', () => {
    expect(strategy.source).toBe('pane_semantics');
  });
});

describe('normalizePaneForActivity', () => {
  test('strips Codex elapsed-time status rows and composer footer noise', () => {
    const pane = [
      '• Working (16s • esc to interrupt)',
      '',
      '› Summarize recent commits',
      '',
      '  gpt-5.4 high · 64% left · ~/git/kookr',
    ].join('\n');

    expect(normalizePaneForActivity(pane)).toBe('› Summarize recent commits');
  });

  test('preserves meaningful output changes', () => {
    const pane = [
      '• Working (16s • esc to interrupt)',
      '',
      'Found the root cause in watchdog.ts',
      '',
      '  gpt-5.4 high · 64% left · ~/git/kookr',
    ].join('\n');

    expect(normalizePaneForActivity(pane)).toBe('Found the root cause in watchdog.ts');
  });
});
