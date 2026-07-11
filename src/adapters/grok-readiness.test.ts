import { describe, it, expect } from 'vitest';
import { detectGrokBlockingStartupUI } from './grok-readiness.js';

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
