import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_ENV_PREFIX_VARS,
  scrubAmbientAgentEnv,
  shouldScrubEnvKey,
} from './setup-env.js';

describe('shouldScrubEnvKey', () => {
  it('scrubs non-allowlisted KOOKR_/CLAUDE_/ANTHROPIC_ keys', () => {
    expect(shouldScrubEnvKey('KOOKR_FOO')).toBe(true);
    expect(shouldScrubEnvKey('CLAUDE_CODE_DISABLE_AUTO_MEMORY')).toBe(true);
    expect(shouldScrubEnvKey('ANTHROPIC_API_KEY')).toBe(true);
  });

  it('preserves allowlisted keys and unrelated env', () => {
    for (const key of ALLOWED_ENV_PREFIX_VARS) {
      expect(shouldScrubEnvKey(key)).toBe(false);
    }
    expect(shouldScrubEnvKey('PATH')).toBe(false);
    expect(shouldScrubEnvKey('HOME')).toBe(false);
    expect(shouldScrubEnvKey('NODE_ENV')).toBe(false);
  });
});

describe('scrubAmbientAgentEnv', () => {
  it('deletes ambient agent env while keeping allowlist + unrelated keys', () => {
    const env: NodeJS.ProcessEnv = {
      KOOKR_FOO: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ANTHROPIC_API_KEY: 'sk-test',
      KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE: '0',
      KOOKR_LESSON_SPOOL: '0',
      PATH: '/usr/bin',
      HOME: '/home/x',
    };

    const deleted = scrubAmbientAgentEnv(env);

    expect(env.KOOKR_FOO).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE).toBe('0');
    expect(env.KOOKR_LESSON_SPOOL).toBe('0');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(deleted).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'KOOKR_FOO',
    ]);
  });

  it('is idempotent on an already-scrubbed env', () => {
    const env: NodeJS.ProcessEnv = {
      KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE: '0',
      PATH: '/usr/bin',
    };
    expect(scrubAmbientAgentEnv(env)).toEqual([]);
    expect(scrubAmbientAgentEnv(env)).toEqual([]);
  });
});

describe('setupFiles live worker scrub (#1372)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hides a planted ambient KOOKR_FOO from the worker process.env', () => {
    // Parent shell can plant KOOKR_FOO=1; setupFiles must have deleted it
    // before this file's tests run. Re-running the focused suite as
    // `KOOKR_FOO=1 pnpm exec vitest run test/setup-env.test.ts` is the
    // empirical check.
    expect(process.env.KOOKR_FOO).toBeUndefined();
  });

  it('keeps vitest.config.ts test.env allowlist values', () => {
    expect(process.env.KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE).toBe('0');
    expect(process.env.KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS).toBe('0');
    expect(process.env.KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS).toBe('0');
    expect(process.env.KOOKR_SESSION_BRIDGE_LIVE_REDRAW_NUDGE_MS).toBe('0');
    expect(process.env.KOOKR_LESSON_SPOOL).toBe('0');
    expect(process.env.KOOKR_SIGNAL_OUTBOX).toBe('0');
    expect(process.env.KOOKR_PROD_SMOKE_TICK).toBe('0');
    expect(process.env.KOOKR_DEPLOY_LAG_DETECTOR).toBe('0');
    expect(process.env.KOOKR_RELAY_DIE_WITH_PARENT).toBe('1');
    expect(process.env.KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS).toBe('250');
  });

  it('still allows vi.stubEnv after the scrub', () => {
    expect(process.env.KOOKR_FOO).toBeUndefined();
    vi.stubEnv('KOOKR_FOO', 'planted-by-test');
    expect(process.env.KOOKR_FOO).toBe('planted-by-test');
    vi.unstubAllEnvs();
    expect(process.env.KOOKR_FOO).toBeUndefined();
  });
});
