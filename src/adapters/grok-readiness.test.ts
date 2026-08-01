import { describe, it, expect } from 'vitest';
import {
  detectGrokBlockingStartupUI,
  detectGrokPermissionPromptUI,
  formatGrokPaneExcerpt,
  isGrokBusyOrResponding,
  GROK_HANDSHAKE_PANE_EXCERPT_MAX_CHARS,
} from './grok-readiness.js';

describe('detectGrokBlockingStartupUI', () => {
  it('returns null for a normal ready composer / benign output', () => {
    expect(detectGrokBlockingStartupUI('$ grok --no-alt-screen --model grok-build')).toBeNull();
    expect(detectGrokBlockingStartupUI('› type a message… (esc to interrupt)')).toBeNull();
    expect(detectGrokBlockingStartupUI('')).toBeNull();
  });

  it.each([
    ['console.x.ai', 'Access denied. Please log into console.x.ai and update permissions.'],
    ['sign in', 'Please Sign In to continue'],
    ['log in to', 'You must log in to Grok first'],
    ['authenticate', 'Authenticate with your xAI account'],
    ['oauth', 'Starting OAuth device flow…'],
    ['enter your api key', 'Enter your API key:'],
    ['update available', 'Update available: run grok upgrade'],
    ['a new version of grok', 'A new version of Grok is ready to install'],
    ['access to the chat endpoint is denied', 'API error: access to the chat endpoint is denied'],
  ])('aborts on the %s auth/update marker', (marker, display) => {
    const reason = detectGrokBlockingStartupUI(display);
    expect(reason).not.toBeNull();
    expect(reason).toContain(marker);
  });

  it('matches case-insensitively and through ANSI control sequences', () => {
    const withAnsi = '\x1b[1m\x1b[31mSIGN IN\x1b[0m to console.x.ai';
    expect(detectGrokBlockingStartupUI(withAnsi)).not.toBeNull();
  });

  it('does not false-positive on ordinary task prose mentioning "sign"', () => {
    expect(detectGrokBlockingStartupUI('Refactor the signup form component')).toBeNull();
  });
});

describe('detectGrokPermissionPromptUI (issue #1526 Phase C4)', () => {
  // Row labels are verbatim strings from the grok 0.2.111 binary's permission
  // prompter (crates/…/permission/prompter.rs); see shared/pane-semantics.ts.
  it('detects the Allow once / Reject row menu', () => {
    const pane = [
      'Grok wants to run run_terminal_command',
      '❯ Allow once',
      '  Always allow this command',
      '  Reject',
    ].join('\n');
    const reason = detectGrokPermissionPromptUI(pane);
    expect(reason).not.toBeNull();
    expect(reason).toContain('Allow once');
  });

  it('detects the bash-command Yes/No variant', () => {
    const pane = [
      "❯ Yes, and don't ask again for bash commands",
      "  No, and don't run bash commands",
    ].join('\n');
    expect(detectGrokPermissionPromptUI(pane)).not.toBeNull();
  });

  it('sees through ANSI control sequences', () => {
    const pane = '\x1b[?2004h\x1b[1m❯ Allow once\x1b[0m\n  \x1b[31mReject\x1b[0m';
    expect(detectGrokPermissionPromptUI(pane)).not.toBeNull();
  });

  it('returns null for the ready composer and ordinary output', () => {
    expect(detectGrokPermissionPromptUI('› type a message… (esc to interrupt)')).toBeNull();
    expect(detectGrokPermissionPromptUI('$ grok --no-alt-screen')).toBeNull();
    expect(detectGrokPermissionPromptUI('')).toBeNull();
  });

  it('does not fire on a single quoted row label without a reject row', () => {
    expect(detectGrokPermissionPromptUI('The "Allow once" row approves a single invocation')).toBeNull();
  });
});

describe('isGrokBusyOrResponding (issue #1808 handshake retry safety)', () => {
  it('is false for the idle Grok composer (which contains "esc to interrupt")', () => {
    expect(isGrokBusyOrResponding('› type a message… (esc to interrupt)')).toBe(false);
    expect(isGrokBusyOrResponding('$ grok --no-alt-screen --model grok-build')).toBe(false);
    expect(isGrokBusyOrResponding('')).toBe(false);
  });

  it('is true for streaming / thinking indicators', () => {
    expect(isGrokBusyOrResponding('Thinking…\n(esc to interrupt)')).toBe(true);
    expect(isGrokBusyOrResponding('Running… tool call')).toBe(true);
  });

  it('is true for a timed active status line', () => {
    expect(isGrokBusyOrResponding('• Working on it (12s · esc to interrupt)')).toBe(true);
  });

  it('is true for the permission row menu', () => {
    const pane = ['❯ Allow once', '  Always allow this command', '  Reject'].join('\n');
    expect(isGrokBusyOrResponding(pane)).toBe(true);
  });
});

describe('formatGrokPaneExcerpt', () => {
  it('returns (empty) for blank panes and strips ANSI', () => {
    expect(formatGrokPaneExcerpt('')).toBe('(empty)');
    expect(formatGrokPaneExcerpt('   ')).toBe('(empty)');
    expect(formatGrokPaneExcerpt('\x1b[1mready\x1b[0m')).toBe('ready');
  });

  it('keeps a short pane whole and tails a long one', () => {
    expect(formatGrokPaneExcerpt('composer ready')).toBe('composer ready');
    const long = 'a'.repeat(GROK_HANDSHAKE_PANE_EXCERPT_MAX_CHARS + 50);
    const excerpt = formatGrokPaneExcerpt(long);
    expect(excerpt.length).toBe(GROK_HANDSHAKE_PANE_EXCERPT_MAX_CHARS);
    expect(excerpt).toBe(long.slice(-GROK_HANDSHAKE_PANE_EXCERPT_MAX_CHARS));
  });
});
