import { describe, expect, test } from 'vitest';
import {
  NON_INHERITABLE_AGENT_ENV_VARS,
  stripNonInheritableAgentEnv,
  composeSessionSpawnEnv,
} from './session-spawn-env.js';

describe('stripNonInheritableAgentEnv', () => {
  test('drops the Claude Code child-session marker', () => {
    const stripped = stripNonInheritableAgentEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_CHILD_SESSION: '1',
    });
    expect('CLAUDE_CODE_CHILD_SESSION' in stripped).toBe(false);
  });

  test('keeps everything an agent legitimately needs', () => {
    const stripped = stripNonInheritableAgentEnv({
      PATH: '/usr/bin',
      HOME: '/home/jean',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_MODEL: 'claude-opus-5',
      CLAUDE_CODE_CHILD_SESSION: '1',
    });
    expect(stripped).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/jean',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_MODEL: 'claude-opus-5',
    });
  });

  test('does not mutate the input (process.env must survive intact)', () => {
    const input = { PATH: '/usr/bin', CLAUDE_CODE_CHILD_SESSION: '1' };
    stripNonInheritableAgentEnv(input);
    expect(input.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  });

  test('an env without any marker is returned unchanged', () => {
    const input = { PATH: '/usr/bin', TERM: 'xterm-256color' };
    expect(stripNonInheritableAgentEnv(input)).toEqual(input);
  });

  test('strips every listed variable, not just the first', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const name of NON_INHERITABLE_AGENT_ENV_VARS) env[name] = 'set';
    const stripped = stripNonInheritableAgentEnv(env);
    for (const name of NON_INHERITABLE_AGENT_ENV_VARS) {
      expect(name in stripped).toBe(false);
    }
    expect(stripped.PATH).toBe('/usr/bin');
  });
});

describe('composeSessionSpawnEnv', () => {
  const processEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/jean',
    ANTHROPIC_API_KEY: 'secret',
    CLAUDE_CODE_CHILD_SESSION: '1',
    TERM: 'xterm-256color',
  };

  // The regression this whole change exists for: a server started from inside a
  // Claude Code session carries the marker, and inheriting it turns transcript
  // saving off for every agent Kookr launches, which silently disables resume.
  test('inherit mode strips the child-session marker but keeps credentials and PATH', () => {
    const env = composeSessionSpawnEnv({ processEnv, envMode: 'inherit' });
    expect('CLAUDE_CODE_CHILD_SESSION' in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ANTHROPIC_API_KEY).toBe('secret');
  });

  test('inherit is the default when envMode is omitted', () => {
    const env = composeSessionSpawnEnv({ processEnv });
    expect('CLAUDE_CODE_CHILD_SESSION' in env).toBe(false);
    expect(env.HOME).toBe('/home/jean');
  });

  test('replace mode yields exactly the caller allowlist — nothing inherited', () => {
    const env = composeSessionSpawnEnv({
      processEnv,
      envMode: 'replace',
      specEnv: { PATH: '/opt/bin', TERM: 'xterm-256color' },
    });
    expect(env).toEqual({ PATH: '/opt/bin', TERM: 'xterm-256color' });
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });

  // A distinct value proves precedence rather than passthrough: processEnv has
  // '1', so asserting '1' would also pass if the strip never ran.
  test('an explicit specEnv value wins over the strip', () => {
    const env = composeSessionSpawnEnv({
      processEnv,
      specEnv: { CLAUDE_CODE_CHILD_SESSION: 'explicit' },
    });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('explicit');
  });

  test('specEnv overrides an inherited value', () => {
    const env = composeSessionSpawnEnv({ processEnv, specEnv: { PATH: '/opt/bin' } });
    expect(env.PATH).toBe('/opt/bin');
  });

  test('TERM is normalized last, for both an inherited and an explicit dumb terminal', () => {
    const inherited = composeSessionSpawnEnv({ processEnv: { ...processEnv, TERM: 'dumb' } });
    expect(inherited.TERM).not.toBe('dumb');
    const explicit = composeSessionSpawnEnv({ processEnv, specEnv: { TERM: 'dumb' } });
    expect(explicit.TERM).not.toBe('dumb');
    const replaced = composeSessionSpawnEnv({
      processEnv,
      envMode: 'replace',
      specEnv: { PATH: '/opt/bin', TERM: 'dumb' },
    });
    expect(replaced.TERM).not.toBe('dumb');
  });

  test('replace mode with no specEnv yields only the normalized TERM', () => {
    expect(composeSessionSpawnEnv({ processEnv, envMode: 'replace' })).toEqual({
      TERM: 'xterm-256color',
    });
  });

  test('replace mode keeps a marker the caller put in its allowlist', () => {
    const env = composeSessionSpawnEnv({
      processEnv,
      envMode: 'replace',
      specEnv: { PATH: '/opt/bin', CLAUDE_CODE_CHILD_SESSION: 'explicit' },
    });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('explicit');
  });

  test('replace mode omits PATH when the allowlist omits it', () => {
    const env = composeSessionSpawnEnv({ processEnv, envMode: 'replace', specEnv: {} });
    expect('PATH' in env).toBe(false);
  });

  // Nothing else pins the `processEnv = process.env` default, so swapping it for
  // an empty object would leave every other case in this file green.
  test('defaults to the real process environment', () => {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CODE_CHILD_SESSION');
    const previous = process.env.CLAUDE_CODE_CHILD_SESSION;
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    try {
      const env = composeSessionSpawnEnv({});
      expect('CLAUDE_CODE_CHILD_SESSION' in env).toBe(false);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (had) process.env.CLAUDE_CODE_CHILD_SESSION = previous;
      else delete process.env.CLAUDE_CODE_CHILD_SESSION;
    }
  });

  test('does not mutate the supplied process environment', () => {
    const input = { ...processEnv };
    composeSessionSpawnEnv({ processEnv: input, specEnv: { PATH: '/opt/bin' } });
    expect(input.CLAUDE_CODE_CHILD_SESSION).toBe('1');
    expect(input.PATH).toBe('/usr/bin');
  });
});
