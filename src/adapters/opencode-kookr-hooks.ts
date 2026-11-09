/**
 * Session-level configuration an opencode session can be launched with (RFC
 * rfc-opencode-agent-integration §3): instructions for the session's AGENTS.md,
 * Claude-shaped hooks the generated plugin runs with Claude semantics, and extra
 * env for those hook commands.
 */
import type { ClaudeHooksConfig } from './opencode-instrumentation/kookr-plugin-source.js';

export interface OpenCodeProfile {
  /** Written to the session's AGENTS.md. */
  instructions?: string;
  claudeHooks?: ClaudeHooksConfig;
  /** Extra env for hook commands only (merged over `claudeHooks.env`). */
  hookEnv?: Record<string, string>;
}
