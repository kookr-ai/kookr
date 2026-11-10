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

  test('an explicit specEnv value wins over the strip', () => {
    const env = composeSessionSpawnEnv({
      processEnv,
      specEnv: { CLAUDE_CODE_CHILD_SESSION: '1' },
    });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('1');
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

  test('does not mutate the supplied process environment', () => {
    const input = { ...processEnv };
    composeSessionSpawnEnv({ processEnv: input, specEnv: { PATH: '/opt/bin' } });
    expect(input.CLAUDE_CODE_CHILD_SESSION).toBe('1');
    expect(input.PATH).toBe('/usr/bin');
  });
});
