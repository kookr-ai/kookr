/**
 * Process-environment side of named Claude accounts: which variables a
 * claude-code launch on an account needs, and how to drop ones a process
 * inherited from such a launch. Kept out of `src/core` because it names the
 * provider's secret variables, which the core LLM boundary forbids there.
 */
import {
  CLAUDE_ACCOUNT_MARKER_ENV,
  ClaudeAccountError,
  HOST_CLAUDE_ACCOUNT,
  type ClaudeAccountRegistry,
} from '../core/claude-accounts.js';

/**
 * Environment a launch on `name` needs. `host` needs nothing. A registered
 * account gets its token, and the two variables Claude Code ranks above an
 * OAuth token are blanked: an `ANTHROPIC_API_KEY` inherited from the server's
 * environment would otherwise win and bill the API key instead of the chosen
 * subscription (an empty value counts as unset; verified on 2.1.330).
 */
export function claudeAccountLaunchEnv(
  registry: ClaudeAccountRegistry,
  name: string,
): Record<string, string> {
  if (name === HOST_CLAUDE_ACCOUNT) return {};
  const record = registry.accounts[name];
  if (!record) {
    throw new ClaudeAccountError(
      'unknown_account',
      `this task is pinned to Claude account "${name}", which is no longer registered; ` +
        'add it again with `kookr account add` or switch the task with `kookr account switch`',
    );
  }
  return {
    CLAUDE_CODE_OAUTH_TOKEN: record.token,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    [CLAUDE_ACCOUNT_MARKER_ENV]: name,
  };
}

/**
 * Remove the account selection a process inherited from a Kookr agent on a
 * named account.
 *
 * The Kookr server is often restarted from inside an agent's shell, and then
 * inherits that agent's environment. Without this, a server restarted by an
 * agent on account "work" would hand the work token to every later `host`
 * launch, which injects nothing and so would not override it. Only variables
 * that came with the marker are removed: an operator who authenticates the
 * host with their own `CLAUDE_CODE_OAUTH_TOKEN` keeps it.
 */
export function stripInheritedClaudeAccountEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env[CLAUDE_ACCOUNT_MARKER_ENV] === undefined) return env;
  const next: NodeJS.ProcessEnv = { ...env };
  delete next[CLAUDE_ACCOUNT_MARKER_ENV];
  delete next.CLAUDE_CODE_OAUTH_TOKEN;
  // The account launch blanked these; the empty values are not the operator's.
  if (next.ANTHROPIC_API_KEY === '') delete next.ANTHROPIC_API_KEY;
  if (next.ANTHROPIC_AUTH_TOKEN === '') delete next.ANTHROPIC_AUTH_TOKEN;
  return next;
}
