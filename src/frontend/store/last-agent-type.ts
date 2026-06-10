import type { AgentSelection } from '../../shared/protocol.js';

/**
 * Persists the user's last-used agent selection from the Launch dialog
 * (RFC F6): the dialog previously defaulted to the server-configured agent,
 * which can silently change (e.g. round-robin flipping to Codex CLI) and
 * surprise the user. The default chain is:
 * explicit prop → last-used → server default → 'claude-code'.
 */
export const LAST_AGENT_TYPE_KEY = 'kookr:lastAgentType';

const KNOWN_SELECTIONS: readonly string[] = ['claude-code', 'codex-cli', 'round-robin'];

export function loadLastAgentType(): AgentSelection | null {
  try {
    const raw = localStorage.getItem(LAST_AGENT_TYPE_KEY);
    if (raw && KNOWN_SELECTIONS.includes(raw)) return raw as AgentSelection;
    return null;
  } catch {
    return null;
  }
}

export function saveLastAgentType(value: AgentSelection): void {
  try {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, value);
  } catch {
    // Quota exceeded / private browsing — silently ignore.
  }
}
