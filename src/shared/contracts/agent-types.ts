export type AgentType = 'claude-code' | 'codex-cli';

export interface AvailableAgentType {
  type: AgentType;
  label: string;
}

export const DEFAULT_AGENT_TYPE: AgentType = 'claude-code';

export const AVAILABLE_AGENT_TYPES: AvailableAgentType[] = [
  { type: 'claude-code', label: 'Claude Code' },
  { type: 'codex-cli', label: 'Codex CLI' },
];

export function normalizeAgentType(value: string | undefined | null): AgentType {
  switch (value) {
    case 'claude':
    case 'claude-code':
      return 'claude-code';
    case 'codex':
    case 'codex-cli':
      return 'codex-cli';
    default:
      return DEFAULT_AGENT_TYPE;
  }
}
