export type AgentType = 'claude-code' | 'codex-cli';

/**
 * Sentinel for the round-robin agent *selection*. Not a real adapter — the
 * server resolves it to a concrete {@link AgentType} at launch time, picking
 * agents in alternation to spread usage across both plans.
 */
export const ROUND_ROBIN_AGENT_TYPE = 'round-robin';

/**
 * A user-facing agent selection: either a concrete agent or the
 * {@link ROUND_ROBIN_AGENT_TYPE} sentinel. `round-robin` only ever appears as
 * a *default*, a launch *request*, or a schedule *definition* — a persisted
 * task or session always carries a concrete {@link AgentType}, because the
 * launch service resolves the sentinel before the task record is created.
 */
export type AgentSelection = AgentType | typeof ROUND_ROBIN_AGENT_TYPE;

export interface AvailableAgentType {
  type: AgentType;
  label: string;
}

/** A selectable agent picker option, including the round-robin meta-option. */
export interface AvailableAgentSelection {
  type: AgentSelection;
  label: string;
}

export const DEFAULT_AGENT_TYPE: AgentType = 'claude-code';

export const AVAILABLE_AGENT_TYPES: AvailableAgentType[] = [
  { type: 'claude-code', label: 'Claude Code' },
  { type: 'codex-cli', label: 'Codex CLI' },
];

/** Picker option representing the round-robin selection. */
export const ROUND_ROBIN_OPTION: AvailableAgentSelection = {
  type: ROUND_ROBIN_AGENT_TYPE,
  label: 'Round robin',
};

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

/**
 * Like {@link normalizeAgentType} but also preserves the
 * {@link ROUND_ROBIN_AGENT_TYPE} sentinel. Use this for values that may
 * legitimately carry a selection (settings default, launch request, schedule
 * definition); use {@link normalizeAgentType} for values that must resolve to
 * a concrete agent (a persisted task or session).
 */
export function normalizeAgentSelection(value: string | undefined | null): AgentSelection {
  if (value === ROUND_ROBIN_AGENT_TYPE) return ROUND_ROBIN_AGENT_TYPE;
  return normalizeAgentType(value);
}

/**
 * Resolve a round-robin launch to a concrete agent. `cursor` is the rotation
 * index for *this* launch; `available` is the set of currently registered
 * adapter types. The canonical order ({@link AVAILABLE_AGENT_TYPES}) is
 * filtered to `available` so the rotation only ever yields a launchable agent
 * — and collapses to a single agent (or {@link DEFAULT_AGENT_TYPE} when none
 * are registered) when fewer than two are present.
 */
export function resolveRoundRobinAgent(
  cursor: number,
  available: readonly AgentType[],
): AgentType {
  const rotation = AVAILABLE_AGENT_TYPES
    .map((entry) => entry.type)
    .filter((type) => available.includes(type));
  if (rotation.length === 0) return DEFAULT_AGENT_TYPE;
  const safeCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const index = safeCursor % rotation.length;
  return rotation[index] ?? DEFAULT_AGENT_TYPE;
}

/**
 * Build the agent-picker option list for the UI. Appends the
 * {@link ROUND_ROBIN_OPTION} only when at least two concrete agents are
 * available — round-robin is meaningless with a single agent.
 */
export function buildAgentSelectionOptions(
  available: readonly AvailableAgentType[],
): AvailableAgentSelection[] {
  const base: AvailableAgentSelection[] =
    available.length > 0 ? [...available] : [...AVAILABLE_AGENT_TYPES];
  return base.length >= 2 ? [...base, ROUND_ROBIN_OPTION] : base;
}
