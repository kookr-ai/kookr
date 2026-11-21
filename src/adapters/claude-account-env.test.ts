import { describe, expect, test } from 'vitest';
import {
  HOST_CLAUDE_ACCOUNT,
  emptyClaudeAccountRegistry,
  withAccount,
  withoutAccount,
} from '../core/claude-accounts.js';
import { claudeAccountLaunchEnv, stripInheritedClaudeAccountEnv } from './claude-account-env.js';

const TOKEN_A = 'sk-ant-oat01-' + 'a'.repeat(30) + 'AAAA';
const TOKEN_B = 'sk-ant-oat01-' + 'b'.repeat(30) + 'BBBB';

describe('claude account launch env', () => {
  test('host needs no environment', () => {
    expect(claudeAccountLaunchEnv(emptyClaudeAccountRegistry(), HOST_CLAUDE_ACCOUNT)).toEqual({});
  });

  test('a registered account selects its token and blanks the variables that outrank it', () => {
    const registry = withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A);
    expect(claudeAccountLaunchEnv(registry, 'work')).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      KOOKR_CLAUDE_ACCOUNT: 'work',
    });
  });

  test('a process that inherited an account launch env drops it, an operator token stays', () => {
    const inherited = {
      PATH: '/bin',
      ...claudeAccountLaunchEnv(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A), 'work'),
    };
    expect(stripInheritedClaudeAccountEnv(inherited)).toEqual({ PATH: '/bin' });
    const operator = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B, ANTHROPIC_API_KEY: 'sk-ant-api03-real' };
    expect(stripInheritedClaudeAccountEnv(operator)).toEqual(operator);
  });

  test('a removed account refuses to launch instead of falling back to host', () => {
    const registry = withoutAccount(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A), 'work');
    expect(() => claudeAccountLaunchEnv(registry, 'work')).toThrow(/no longer registered/);
  });
});
