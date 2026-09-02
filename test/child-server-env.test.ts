import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizedChildServerEnv } from '../e2e/child-server-env.js';

describe('sanitizedChildServerEnv (#2814)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('removes ambient KOOKR_/CLAUDE_/ANTHROPIC_ overrides, including allowlisted ones', () => {
    vi.stubEnv('KOOKR_RELAY_URL', 'wss://poisoned.example');
    vi.stubEnv('KOOKR_RELAY_TOKEN', 'poisoned-token');
    vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-poisoned');
    // Even a var the Vitest allowlist keeps must be scrubbed for child servers,
    // which carry their own defaults and receive explicit overrides instead.
    vi.stubEnv('KOOKR_LESSON_SPOOL', '1');

    const env = sanitizedChildServerEnv();

    expect(env.KOOKR_RELAY_URL).toBeUndefined();
    expect(env.KOOKR_RELAY_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.KOOKR_LESSON_SPOOL).toBeUndefined();
  });

  it('preserves required OS/CI variables', () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('HOME', '/home/tester');
    vi.stubEnv('TMPDIR', '/tmp/x');
    vi.stubEnv('CI', 'true');
    vi.stubEnv('NODE_ENV', 'test');

    const env = sanitizedChildServerEnv();

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/tester');
    expect(env.TMPDIR).toBe('/tmp/x');
    expect(env.CI).toBe('true');
    expect(env.NODE_ENV).toBe('test');
  });

  it('applies explicit fixture overrides', () => {
    const env = sanitizedChildServerEnv({
      E2E_PORT: '0',
      E2E_WITH_RELAY: '1',
      KOOKR_RELAY_TRUSTED: 'true',
    });

    expect(env.E2E_PORT).toBe('0');
    expect(env.E2E_WITH_RELAY).toBe('1');
    expect(env.KOOKR_RELAY_TRUSTED).toBe('true');
  });

  it('lets an override win over a preserved (non-scrubbed) ambient value', () => {
    // A collision on a preserved key is the only case where spread order
    // actually decides the result — a scrubbed KOOKR_/CLAUDE_/ANTHROPIC_ key is
    // gone before overrides apply, so it cannot exercise precedence. This guards
    // that overrides are spread last.
    vi.stubEnv('E2E_PROMPT_SUBMIT_AUTO_HOOK', 'ambient');

    const env = sanitizedChildServerEnv({ E2E_PROMPT_SUBMIT_AUTO_HOOK: 'override' });

    expect(env.E2E_PROMPT_SUBMIT_AUTO_HOOK).toBe('override');
  });

  it('does not mutate process.env', () => {
    vi.stubEnv('KOOKR_SHOULD_STAY_IN_PARENT', '1');

    sanitizedChildServerEnv({ E2E_PORT: '0' });

    expect(process.env.KOOKR_SHOULD_STAY_IN_PARENT).toBe('1');
    expect(process.env.E2E_PORT).toBeUndefined();
  });
});
