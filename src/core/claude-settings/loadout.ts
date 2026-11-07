/**
 * Pure loadout resolution + rendering (RFC Layer 2 / G1).
 *
 * Placed in `core` — not `server` — so the claude adapter can import the
 * renderer without an upward dependency, the same reason `ClaudeSettingsStore`
 * lives here (RFC round-2 F1/F5). Both functions are pure: resolution takes the
 * per-level desired state and returns a typed {@link ResolvedLoadout}; rendering
 * turns that into the `enabledPlugins` map the adapter writes into a spawned
 * agent's per-session `--settings` file.
 *
 * Plugin-level only (R3a): `deniedSkills` is never populated here.
 */
import {
  type LoadoutDesiredState,
  type LoadoutLevel,
  type LoadoutSpawnMode,
  type ResolvedLoadout,
  type ResolvedLoadoutProvenance,
  LOADOUT_LEVELS_MOST_SPECIFIC_FIRST,
  emptyResolvedLoadout,
  pluginNameFromId,
} from '../../shared/contracts/plugins.js';

/**
 * The synthetic marketplace id a `--plugin-dir`-loaded plugin presents under.
 * Established by the P2 probe (`docs/rfc/rfc-plugin-skill-manager-p2-probe.md`):
 * a dir-loaded plugin is addressable in `enabledPlugins` ONLY as
 * `<name>@inline`, never under its real marketplace id. Keying a marketplace id
 * for a dir-loaded plugin is a silent no-op.
 */
export const INLINE_MARKETPLACE = 'inline';

/**
 * Resolve the three-level desired state into a typed loadout, most specific
 * level winning PER PLUGIN (task-type → playbook → project). The spawn mode
 * only changes what the fields MEAN (RFC round-2 F3), so the resolution records
 * it and, in bypass mode, emits `enabledSet` as the full allowlist of enabled
 * plugins (not a diff) since bypass drops the base layer.
 *
 * Pure. An all-empty input yields an empty loadout with `winningLevel: 'none'`.
 */
export function resolveLoadout(
  states: Partial<Record<LoadoutLevel, LoadoutDesiredState | undefined>>,
  opts: { mode: LoadoutSpawnMode },
): { loadout: ResolvedLoadout; provenance: ResolvedLoadoutProvenance } {
  const enabledOverrides: Record<string, boolean> = {};
  let winningLevel: LoadoutLevel | 'none' = 'none';

  // Walk LEAST specific → MOST specific so the most specific write wins, while
  // recording the most specific level that contributed any opinion.
  const leastToMost = [...LOADOUT_LEVELS_MOST_SPECIFIC_FIRST].reverse();
  for (const level of leastToMost) {
    const plugins = states[level]?.plugins;
    if (!plugins) continue;
    let contributed = false;
    for (const [id, value] of Object.entries(plugins)) {
      if (typeof value !== 'boolean') continue; // malformed-tolerant
      enabledOverrides[id] = value;
      contributed = true;
    }
    if (contributed) winningLevel = level; // later (more specific) iterations overwrite
  }

  const loadout: ResolvedLoadout = { ...emptyResolvedLoadout(), enabledOverrides };
  if (opts.mode === 'bypass') {
    // Allowlist = the full set of plugin ids resolved to enabled. Emitted even
    // when empty so the bypass contract ("emit the full set, not a diff") is
    // explicit in the record.
    loadout.enabledSet = Object.entries(enabledOverrides)
      .filter(([, v]) => v === true)
      .map(([id]) => id)
      .sort();
  }

  return { loadout, provenance: { winningLevel, mode: opts.mode } };
}

/**
 * Render a resolved loadout into the `enabledPlugins` map the adapter writes
 * into the per-session `--settings` file. Returns `undefined` when the loadout
 * expresses no plugin opinion, so the caller OMITS the key and the written file
 * stays byte-identical to today (the byte-identity contract).
 *
 * `dirLoadedPluginNames` names the plugins the adapter force-loads via
 * `--plugin-dir`. Any override targeting such a plugin (matched by NAME) is
 * rewritten to the `<name>@inline` id — the only id that actually disables a
 * dir-loaded plugin (P2 probe). A marketplace-id key for a dir-loaded plugin
 * would be a silent no-op, so the rewrite is required for the budget lever to
 * work on the toolkit.
 *
 * Pure. The booleans come from `enabledOverrides` in BOTH spawn modes: in
 * bypass the only separately-loadable plugin is the dir-loaded one, which must
 * carry an explicit boolean (an allowlist that merely omits it would NOT remove
 * a force-loaded plugin), and `enabledSet` is recorded metadata, not bytes.
 */
export function renderEnabledPlugins(
  loadout: ResolvedLoadout,
  opts?: { dirLoadedPluginNames?: readonly string[] },
): Record<string, boolean> | undefined {
  const dirNames = new Set(opts?.dirLoadedPluginNames ?? []);
  const out: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(loadout.enabledOverrides)) {
    if (typeof value !== 'boolean') continue;
    const key = dirNames.has(pluginNameFromId(id))
      ? `${pluginNameFromId(id)}@${INLINE_MARKETPLACE}`
      : id;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Env flag gating Phase 2 loadout injection. Default OFF (RFC kill switch). */
export const PLUGIN_LOADOUTS_FLAG = 'KOOKR_PLUGIN_LOADOUTS';

/** True when plugin-loadout injection is enabled for this process. */
export function pluginLoadoutsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[PLUGIN_LOADOUTS_FLAG];
  return v === '1' || v === 'true';
}
