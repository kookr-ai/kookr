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

/** Every agent selection accepted at launch time, including the round-robin sentinel. */
export const AGENT_SELECTIONS = [...AGENT_TYPES, ROUND_ROBIN_AGENT_TYPE] as const;

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
 *   xhigh, max, ultra. Default Codex launches use GPT-5.6-Sol with no effort
 *   override (model-native default); set `KOOKR_CODEX_MODEL` / `agentEffort`
 *   to change. An explicit `ultra` request always selects GPT-5.6-Sol because
 *   Luna's supported ceiling is `max`.
 *
 * Effort is only meaningful relative to an agent type: `max` is valid for
 * both Claude Code and codex-cli; `minimal`/`none`/`ultra` are valid for
 * codex-cli but not claude-code. There is no shared canonical scale across
 * all possible agent binaries — always validate against
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

/**
 * Known model ids Kookr accepts as a per-task / per-schedule pin (#1518).
 *
 * - `claude-code`: Claude Code CLI `--model` ids. Includes the issue's
 *   high-stakes pins (`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`)
 *   plus the other Anthropic ids already priced in `MODEL_PRICING`. Dated
 *   suffixes (e.g. `claude-haiku-4-5-20251001`) match via prefix against an
 *   allowlisted base id — see {@link isValidModelForAgent}.
 * - `codex-cli` / `grok-build`: empty for now. Those agents keep their
 *   existing model selection (`KOOKR_CODEX_MODEL` / `KOOKR_GROK_MODEL`); a
 *   per-task model pin for them is rejected until a follow-up adds their
 *   allowlists. Empty (not Claude inheritance) mirrors the effort pattern.
 */
export const CLAUDE_CODE_MODEL_IDS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;
export const CODEX_CLI_MODEL_IDS = [] as const;
export const GROK_BUILD_MODEL_IDS = [] as const;

export type ClaudeCodeModel = (typeof CLAUDE_CODE_MODEL_IDS)[number];
export type CodexCliModel = (typeof CODEX_CLI_MODEL_IDS)[number];
export type GrokBuildModel = (typeof GROK_BUILD_MODEL_IDS)[number];

/** Any model id. Validity is agent-specific — see {@link isValidModelForAgent}. */
export type ModelId = ClaudeCodeModel | CodexCliModel | GrokBuildModel | string;

/**
 * The allowed model ids for a given agent type. Exhaustive switch so a new
 * agent type cannot silently inherit Claude's allowlist.
 */
export function modelsForAgent(agent: AgentType): readonly string[] {
  switch (agent) {
    case 'claude-code':
      return CLAUDE_CODE_MODEL_IDS;
    case 'codex-cli':
      return CODEX_CLI_MODEL_IDS;
    case 'grok-build':
      return GROK_BUILD_MODEL_IDS;
    default:
      return assertNeverAgentType(agent);
  }
}

/**
 * True when `model` is an id the given agent's CLI accepts as a per-task pin.
 * Exact match against {@link modelsForAgent}, or a dated suffix on an
 * allowlisted base (e.g. `claude-haiku-4-5-20251001` matches `claude-haiku-4-5`).
 */
export function isValidModelForAgent(agent: AgentType, model: string): boolean {
  if (model.length === 0) return false;
  const allowed = modelsForAgent(agent);
  if (allowed.includes(model)) return true;
  return allowed.some((id) => model.startsWith(`${id}-`));
}

/**
 * Union of every agent's known model ids — CLI fast-fail before the concrete
 * agent is known. Authoritative agent-specific check still runs server-side.
 */
export const ALL_MODEL_IDS: readonly string[] = [
  ...new Set<string>([
    ...CLAUDE_CODE_MODEL_IDS,
    ...CODEX_CLI_MODEL_IDS,
    ...GROK_BUILD_MODEL_IDS,
  ]),
];

/** True when `model` is in the cross-agent allowlist (exact or dated suffix). */
export function isKnownModelId(model: string): boolean {
  if (model.length === 0) return false;
  if (ALL_MODEL_IDS.includes(model)) return true;
  return ALL_MODEL_IDS.some((id) => model.startsWith(`${id}-`));
}

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
 *
 * `deprioritized` is the failover precondition of issue #1898 (WS1.6): agent
 * types whose recent boot-latency signal is unhealthy (see
 * `AgentBootLatencyMonitor`). Such agents are skipped by the rotation — so a
 * boot-unreliable grok-build is not selected only to hang until the fire()
 * wall-clock cap (#1708) trips — BUT only while at least one non-deprioritized
 * agent remains launchable. When every available agent is deprioritized the
 * full rotation is used unchanged: something must launch, and the fire() cap
 * stays the backstop for a sole-but-unhealthy agent.
 */
export function resolveRoundRobinAgent(
  cursor: number,
  available: readonly AgentType[],
  deprioritized: readonly AgentType[] = [],
): AgentType {
  const rotation = AVAILABLE_AGENT_TYPES
    .map((entry) => entry.type)
    .filter((type) => available.includes(type));
  if (rotation.length === 0) return DEFAULT_AGENT_TYPE;
  let effective = rotation;
  if (deprioritized.length > 0) {
    const healthy = rotation.filter((type) => !deprioritized.includes(type));
    if (healthy.length > 0) effective = healthy;
  }
  const safeCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const index = safeCursor % effective.length;
  return effective[index] ?? DEFAULT_AGENT_TYPE;
}

/**
 * Outcome of resolving a *pinned* schedule agent against the currently
 * launchable set (issue #1895 / #1699 WS1.3). Round-robin already filters via
 * {@link resolveRoundRobinAgent}; pinned selections used to pass through and
 * fail at `adapterRegistry.get` as `dispatch_failed`. This is the schedule-
 * level counterpart: keep the pin when it is launchable, substitute a healthy
 * registered alternative when it is not, or report unavailability so the
 * caller can park the fire (WS0 `provider_paused`) instead of dispatching
 * into a known-missing agent.
 *
 * `deprioritized` reuses the #1898 boot-reliability signal: a pin whose agent
 * is registered but currently unhealthy is treated as unavailable while a
 * healthier alternative remains — same rule as round-robin.
 *
 * `policy` (issue #2001) gates *automatic substitutes only* — an explicit pin
 * to a disallowed agent still launches when that agent is healthy. When the
 * pin is unavailable and no *allowed* substitute remains, returns
 * `unavailable` so the caller can park rather than cascade onto a forbidden
 * provider (e.g. silent `codex-cli` landings under quota pressure).
 */
export type PinnedAgentResolution =
  | { kind: 'available'; agentType: AgentType; substituted: false }
  | { kind: 'substituted'; agentType: AgentType; substituted: true; from: AgentType }
  | { kind: 'unavailable'; from: AgentType };

/**
 * Policy for automatic agent fallback / rotation (issue #2001).
 *
 * - `disallow` — never choose these types as substitutes (default: codex-cli).
 * - `allowlist` — when non-empty, *only* these types may be substitutes.
 *
 * Neither filter blocks an explicit pin that is itself healthy and registered.
 */
export interface AgentFallbackPolicy {
  disallow?: readonly AgentType[];
  allowlist?: readonly AgentType[];
}

/**
 * Filter candidate substitutes under {@link AgentFallbackPolicy}. Order is
 * preserved (callers pass canonical order). Empty allowlist = unrestricted.
 */
export function filterFallbackCandidates(
  candidates: readonly AgentType[],
  policy?: AgentFallbackPolicy,
): AgentType[] {
  let out = [...candidates];
  const disallow = policy?.disallow;
  if (disallow && disallow.length > 0) {
    out = out.filter((type) => !disallow.includes(type));
  }
  const allowlist = policy?.allowlist;
  if (allowlist && allowlist.length > 0) {
    out = out.filter((type) => allowlist.includes(type));
  }
  return out;
}

/**
 * Resolve a pinned agent pin against registered (and optionally deprioritized)
 * adapters. Returns the pin unchanged when it is launchable; otherwise the
 * first healthy *allowed* agent in canonical order ({@link AVAILABLE_AGENT_TYPES});
 * or `unavailable` when no substitute can launch (or none remain after
 * {@link AgentFallbackPolicy} filtering — issue #2001).
 */
export function resolvePinnedAgentFallback(
  pinned: AgentType,
  available: readonly AgentType[],
  deprioritized: readonly AgentType[] = [],
  policy?: AgentFallbackPolicy,
): PinnedAgentResolution {
  const registered = AVAILABLE_AGENT_TYPES
    .map((entry) => entry.type)
    .filter((type) => available.includes(type));
  if (registered.length === 0) {
    return { kind: 'unavailable', from: pinned };
  }
  let effective = registered;
  if (deprioritized.length > 0) {
    const healthy = registered.filter((type) => !deprioritized.includes(type));
    if (healthy.length > 0) effective = healthy;
  }
  if (effective.includes(pinned)) {
    return { kind: 'available', agentType: pinned, substituted: false };
  }
  // Issue #2001: only automatic substitutes are filtered. The pin itself was
  // already checked above; remaining candidates must pass the fallback policy.
  const allowed = filterFallbackCandidates(effective, policy);
  const substitute = allowed[0];
  if (!substitute) {
    return { kind: 'unavailable', from: pinned };
  }
  return { kind: 'substituted', agentType: substitute, substituted: true, from: pinned };
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

/**
 * Human label for the picker "Next: {label}" line when the operator selected
 * round-robin. Prefers a server-advertised concrete type that is still in the
 * rotation; otherwise uses {@link resolveRoundRobinAgent} so the hint matches
 * launch-time resolution. Returns undefined when no concrete agent remains.
 */
export function previewRoundRobinNextLabel(
  options: readonly AvailableAgentSelection[],
  opts?: { cursor?: number; advertisedNext?: AgentType },
): string | undefined {
  const rotation = options
    .map((option) => option.type)
    .filter((type): type is AgentType => type !== ROUND_ROBIN_AGENT_TYPE && isAgentType(type));
  if (rotation.length === 0) return undefined;
  const next = opts?.advertisedNext && rotation.includes(opts.advertisedNext)
    ? opts.advertisedNext
    : resolveRoundRobinAgent(opts?.cursor ?? 0, rotation);
  return options.find((option) => option.type === next)?.label;
}
