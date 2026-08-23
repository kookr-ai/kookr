import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_TERM,
  ensureInteractiveTermEnv,
  isNonInteractiveTerm,
} from './session-term-env.js';

describe('isNonInteractiveTerm', () => {
  it('treats missing, empty, and dumb as non-interactive', () => {
    expect(isNonInteractiveTerm(undefined)).toBe(true);
    expect(isNonInteractiveTerm(null)).toBe(true);
    expect(isNonInteractiveTerm('')).toBe(true);
    expect(isNonInteractiveTerm('   ')).toBe(true);
    expect(isNonInteractiveTerm('dumb')).toBe(true);
    expect(isNonInteractiveTerm('DUMB')).toBe(true);
    expect(isNonInteractiveTerm(' Dumb ')).toBe(true);
  });

  it('accepts real terminal types', () => {
    expect(isNonInteractiveTerm('xterm-256color')).toBe(false);
    expect(isNonInteractiveTerm('screen')).toBe(false);
    expect(isNonInteractiveTerm('tmux-256color')).toBe(false);
  });
});

describe('ensureInteractiveTermEnv', () => {
  it('sets DEFAULT_AGENT_TERM when TERM is missing or dumb', () => {
    expect(ensureInteractiveTermEnv({}).TERM).toBe(DEFAULT_AGENT_TERM);
    expect(ensureInteractiveTermEnv({ TERM: 'dumb' }).TERM).toBe(DEFAULT_AGENT_TERM);
    expect(ensureInteractiveTermEnv({ TERM: '' }).TERM).toBe(DEFAULT_AGENT_TERM);
  });

  it('preserves a usable TERM', () => {
    expect(ensureInteractiveTermEnv({ TERM: 'screen-256color' }).TERM).toBe('screen-256color');
  });

  it('mutates and returns the same object', () => {
    const env: Record<string, string> = { PATH: '/bin', TERM: 'dumb' };
    const out = ensureInteractiveTermEnv(env);
    expect(out).toBe(env);
    expect(env.TERM).toBe(DEFAULT_AGENT_TERM);
  });
});
