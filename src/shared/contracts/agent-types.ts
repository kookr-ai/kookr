/** Every concrete agent type accepted by persisted and runtime contracts. */
export const AGENT_TYPES = ['claude-code', 'codex-cli', 'grok-build'] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/** True when a runtime value is one of the concrete agent types. */
export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && AGENT_TYPES.includes(value as AgentType);
}

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
  { type: 'grok-build', label: 'Grok Build' },
];

/**
 * Reasoning-effort levels, per agent type (#681). Each set describes the
 * levels Kookr exposes for the configured agent policy; model-specific
 * selection is handled by the adapter:
 *
 * - `claude --effort <level>` accepts: low, medium, high, xhigh, max
 *   (verified: `claude --effort __bogus__` → "It must be one of: low, medium,
 *   high, xhigh, max").
 * - `codex -c model_reasoning_effort=<level>` takes the model's advertised
 *   reasoning-effort values. Kookr exposes: none, minimal, low, medium, high,
 *   xhigh, max, ultra. The adapter selects GPT-5.6-Sol for an explicit
 *   `ultra` request because Luna's supported ceiling is `max`.
 *
 * Effort is only meaningful relative to an agent type: `max` is valid for
 * both Claude Code and Kookr's Luna-backed codex-cli; `minimal`/`none`/`ultra`
 * are valid for codex-cli but not claude-code. There is no shared canonical
 * scale across all possible agent binaries — always validate against
 * {@link effortLevelsForAgent} / {@link isValidEffortForAgent}.
 */
export const CLAUDE_CODE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_CLI_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
/**
 * Grok Build exposes NO validated effort levels (issue #1343 / RFC "Grok Build
 * adapter"). Grok advertises a `--reasoning-effort` flag, but POC-A did not
 * validate its accepted values, so Kookr passes no effort lever to Grok at all
 * until a follow-up empirically qualifies the exact tokens. Keeping this empty
 * (rather than reusing Claude's levels) is the whole point of the exhaustive
 * per-agent map below: a new agent type must NOT silently inherit Claude effort
 * values. `isValidEffortForAgent('grok-build', …)` is therefore always false and
 * the adapter never emits an effort flag.
 */
export const GROK_BUILD_EFFORT_LEVELS = [] as const;

export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_LEVELS)[number];
export type CodexCliEffort = (typeof CODEX_CLI_EFFORT_LEVELS)[number];
export type GrokBuildEffort = (typeof GROK_BUILD_EFFORT_LEVELS)[number];

/** Any effort token. Validity is agent-specific — see {@link isValidEffortForAgent}. */
export type EffortLevel = ClaudeCodeEffort | CodexCliEffort | GrokBuildEffort;

/**
 * Per-agent-type effort defaults, as persisted in kookr settings (`agentEffort`).
 * Sparse by design: an agent absent from the map means "no configured effort"
 * — the agent CLI's own effort default applies and Kookr passes no
 * `model_reasoning_effort` override; model selection remains explicit in the
 * adapter. Settings normalize a missing or legacy-empty map before validation.
 */
export type AgentEffortMap = Partial<Record<AgentType, EffortLevel>>;

/**
 * The allowed effort levels for a given agent type.
 *
 * EXHAUSTIVE per-agent switch (issue #1343): the previous binary
 * `codex-cli ? CODEX : CLAUDE` fallback meant any newly added agent type would
 * silently inherit Claude Code's effort levels. A `default: assertNever` now
 * forces every future agent type to declare its own set here, so `grok-build`
 * correctly resolves to its (empty) set rather than Claude's.
 */
export function effortLevelsForAgent(agent: AgentType): readonly string[] {
  switch (agent) {
    case 'claude-code':
      return CLAUDE_CODE_EFFORT_LEVELS;
    case 'codex-cli':
      return CODEX_CLI_EFFORT_LEVELS;
    case 'grok-build':
      return GROK_BUILD_EFFORT_LEVELS;
    default:
      return assertNeverAgentType(agent);
  }
}

/**
 * Exhaustiveness guard for {@link AgentType} switches. Returns `never` so the
 * compiler flags any unhandled agent type at build time; throws at runtime if
 * an out-of-contract value is somehow reached.
 */
function assertNeverAgentType(agent: never): never {
  throw new Error(`Unhandled agent type: ${String(agent)}`);
}

/** True when `effort` is a level the given agent's CLI accepts. */
export function isValidEffortForAgent(agent: AgentType, effort: string): boolean {
  return effortLevelsForAgent(agent).includes(effort);
}

/**
 * Union of every agent's allowed levels — for cross-agent fast-fail validation
 * before the concrete agent is known (e.g. the `kookr-spawn` CLI, which cannot
 * know which agent a `round-robin` launch resolves to). The authoritative,
 * agent-specific check still runs server-side once the agent is resolved.
 */
export const ALL_EFFORT_LEVELS: readonly string[] = [
  ...new Set<string>([
    ...CLAUDE_CODE_EFFORT_LEVELS,
    ...CODEX_CLI_EFFORT_LEVELS,
    ...GROK_BUILD_EFFORT_LEVELS,
  ]),
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
    case 'grok':
    case 'grok-build':
      return 'grok-build';
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
