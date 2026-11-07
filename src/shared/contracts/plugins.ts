/**
 * Wire contracts for the fleet Plugin Manager (RFC Layer 1 / `GET /api/plugins`).
 *
 * `ManagedPlugin` is the minimal per-plugin row the Plugin Manager dialog
 * renders for EVERY installed plugin (not only kookr-toolkit). `name` and
 * `marketplace` are derived from `id` client-side, so they are not on the wire.
 */

/** Tri-state plugin enablement — absent from `enabledPlugins` is `default`, NOT `disabled`. */
export type PluginEnablement = 'enabled' | 'disabled' | 'default';

export type StalenessState = 'current' | 'behind' | 'unknown';

/** Where the staleness verdict came from — so the UI never shows a bare "current" that means "couldn't check". */
export type StalenessSource = 'git' | 'catalog';

export interface PluginStaleness {
  state: StalenessState;
  /** Why the state is what it is — populated especially for `unknown`. */
  reason?: string;
  source: StalenessSource;
  /** ISO-8601 time the staleness was observed. */
  observedAt: string;
}

/** Where AGENTS load the plugin from (Layer 2 uses `plugin-dir`); P1 fleet rows are `marketplace`. */
export type PluginLoadSource = 'marketplace' | 'plugin-dir';

export interface ManagedPlugin {
  /** Full plugin id, e.g. "stripe@anthropic-plugin-directory". */
  id: string;
  installedVersion: string | null;
  availableVersion: string | null;
  enablement: PluginEnablement;
  staleness: PluginStaleness;
  loadSource: PluginLoadSource;
  /** Always-on token cost from `claude plugin details`, best-effort; null when unavailable. */
  alwaysOnTokens: number | null;
  /** Server-set: true for plugins Kookr depends on (kookr-toolkit) — never one-click uninstall. */
  uninstallGuard: boolean;
  /**
   * Whether this plugin's marketplace is registered in `known_marketplaces.json`.
   * `false` (real for `stripe@anthropic-plugin-directory`) means marketplace-scoped
   * actions (update / own-session install) must degrade to "open in `/plugin`"
   * rather than erroring (RFC Edge cases). `true` when the marketplace is present
   * OR when Kookr could not read the file (conservative: do not degrade on an
   * unknown — only when the file is readable and the marketplace is genuinely absent).
   */
  marketplaceRegistered: boolean;
}

export interface PluginsReadModel {
  plugins: ManagedPlugin[];
  /**
   * Toolkit install/stale projection for the install banner + TopBar badge,
   * sourced from the same read model (installed version from the registry,
   * available version git-sourced from origin/main). Present even when the
   * toolkit is NOT installed (installedVersion null + availableVersion known)
   * so the banner can nudge a first-time install. Null when it can't be read.
   */
  toolkit: import('./plugin-version.js').PluginVersionStatus | null;
}

/** Success body for `POST /api/plugins/:id/update`. */
export interface PluginUpdateOutcome {
  status: 'updated';
  plugin: ManagedPlugin;
}

/** Error body for plugin routes. */
export interface PluginActionError {
  error: string;
  pluginId?: string;
  /** Present on a 409: the mutation lock holder (operation + start time). */
  lockHolder?: { operation: string; startedAt: string };
}

// ---------------------------------------------------------------------------
// Loadouts (RFC Layer 2 / G1) — Kookr-owned per-scope desired state that the
// launcher resolves into a typed `ResolvedLoadout` and the claude adapter
// renders into a spawned agent's per-session `--settings` `enabledPlugins`.
// Plugin-level only (R3a: no per-skill behaviour toggles — `deniedSkills` stays
// empty everywhere until a concrete harm model is recorded).
// ---------------------------------------------------------------------------

/**
 * Kookr-owned desired state attachable at one scope level. Plugin-level only:
 * a map of full plugin id (`<name>@<marketplace>`) → enabled boolean. A plugin
 * absent from the map carries no opinion at this level (it may be decided by a
 * less specific level, or left at native default).
 */
export interface LoadoutDesiredState {
  plugins: Record<string, boolean>;
}

/**
 * The three scope levels a loadout attaches to, ordered MOST SPECIFIC FIRST.
 * Resolution is per-plugin: the most specific level that expresses an opinion
 * for a given plugin wins.
 */
export type LoadoutLevel = 'task-type' | 'playbook' | 'project';
export const LOADOUT_LEVELS_MOST_SPECIFIC_FIRST: readonly LoadoutLevel[] = [
  'task-type',
  'playbook',
  'project',
] as const;

/**
 * The resolved, typed loadout the launcher hands the adapter. Spawn-mode aware
 * (RFC round-2 F3): `enabledOverrides` is the normal-mode override of the user
 * scope; `enabledSet` is the bypass-mode allowlist (the FULL set of plugin ids
 * to enable, since bypass drops the base layer so there is nothing to diff
 * against). `deniedSkills` is always empty under R3a.
 */
export interface ResolvedLoadout {
  /** Bypass-mode allowlist: the full set of plugin ids to enable (not a diff). */
  enabledSet?: string[];
  /** Normal-mode override of the user scope: plugin id → enabled boolean. */
  enabledOverrides: Record<string, boolean>;
  /** Always `[]` under R3a. Present so the shape is stable when Layer 3 ships. */
  deniedSkills: string[];
}

/** Which spawn mode a loadout was resolved for — the fields mean different things. */
export type LoadoutSpawnMode = 'normal' | 'bypass';

/** Answerability metadata recorded alongside a resolution (RFC Layer 2 operability). */
export interface ResolvedLoadoutProvenance {
  /** The most specific level that supplied any plugin opinion; `none` when empty. */
  winningLevel: LoadoutLevel | 'none';
  /** The spawn mode the resolution targeted. */
  mode: LoadoutSpawnMode;
}

/**
 * The record stored on the task for answerability (RFC Layer 2). Carries the
 * resolved loadout (the INTENT), which level won, the spawn mode, a hash of the
 * written per-session settings file, and a link to it. Resume replays THIS
 * record verbatim — it is never re-resolved.
 */
export interface TaskLoadoutRecord extends ResolvedLoadoutProvenance {
  resolved: ResolvedLoadout;
  /** SHA-256 of the written per-session `--settings` file, or null if not yet applied. */
  settingsHash: string | null;
  /** Absolute path to that session settings file, or null if not yet applied. */
  settingsPath: string | null;
  /** ISO-8601 time the loadout was recorded. */
  recordedAt: string;
}

/** An empty resolved loadout — the default-off / nothing-attached shape. Byte-identity baseline. */
export function emptyResolvedLoadout(): ResolvedLoadout {
  return { enabledOverrides: {}, deniedSkills: [] };
}

/** True when a resolved loadout expresses no opinion (renders to no `enabledPlugins`). */
export function isEmptyResolvedLoadout(loadout: ResolvedLoadout): boolean {
  return (
    Object.keys(loadout.enabledOverrides).length === 0 &&
    (loadout.enabledSet === undefined || loadout.enabledSet.length === 0) &&
    loadout.deniedSkills.length === 0
  );
}

/** Derive the human plugin name from a full id ("stripe@mkt" → "stripe"). */
export function pluginNameFromId(id: string): string {
  const at = id.indexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

/** Derive the marketplace from a full id ("stripe@mkt" → "mkt"), or null when absent. */
export function pluginMarketplaceFromId(id: string): string | null {
  const at = id.indexOf('@');
  return at === -1 ? null : id.slice(at + 1);
}

// ---------------------------------------------------------------------------
// Own-session assist (RFC "Own-session assist (G3)" / R4) — mutating the
// operator's OWN interactive Claude Code sessions (distinct from P2 loadouts,
// which target Kookr-SPAWNED agents). Parity with native `/plugin`: all config
// format knowledge lives in the P1 Layer-0 seams (ClaudeSettingsStore,
// ClaudePluginCli), never here.
// ---------------------------------------------------------------------------

/**
 * The blast-radius disclosure shown BEFORE any own-session mutation applies
 * (R4). A single source of truth so the UI and any copy stay consistent. New
 * sessions pick up the edit automatically; running ones need `/reload-plugins`
 * (there is no supported programmatic reload — a Non-Goal).
 */
export const OWN_SESSION_BLAST_RADIUS =
  'This affects all of your Claude Code sessions. New sessions pick it up automatically; run /reload-plugins in any session that is already running.';

/**
 * Kookr cannot see the operator's own Claude Code sessions in external
 * terminals — the drift surface states this rather than implying coverage
 * (RFC "Surfacing reload drift": "external TUIs are invisible to Kookr").
 */
export const EXTERNAL_TUI_COVERAGE_NOTE =
  'Kookr only tracks the sessions it manages. Your own Claude Code sessions in external terminals are invisible to Kookr — restart those yourself (or run /reload-plugins in them).';

/** The scope an own-session enable/disable targets. Mirrors ClaudeSettingsStore scopes; default `user`. */
export type OwnSessionScope = 'user' | 'userLocal' | 'project' | 'projectLocal';

/** Request to enable/disable/reset a plugin for the operator's own sessions. */
export interface OwnSessionEnablementRequest {
  pluginId: string;
  /** true = enable, false = disable, null = reset to native default (remove the key). */
  value: boolean | null;
  /** Default `user` when omitted. */
  scope?: OwnSessionScope;
}

/** Result of an own-session enable/disable (carries the inverse-undo value + new epoch). */
export interface OwnSessionEnablementResult {
  status: 'applied';
  pluginId: string;
  scope: OwnSessionScope;
  enablement: PluginEnablement;
  /** The value before the edit, for an inverse single-key undo; null means it was at native default. */
  previousValue: boolean | null;
  /** Where the pre-write settings backup landed, or null when the file did not exist. */
  backupPath: string | null;
  /** The config epoch after this change (bumped on every own-session mutation). */
  epoch: number;
}

/** Request to add a marketplace for the operator's own sessions. */
export interface OwnSessionMarketplaceRequest {
  /** A `claude plugin marketplace add` source (e.g. `owner/repo` or `owner/repo#ref`). */
  source: string;
}

/** Request to install a plugin for the operator's own sessions (combined plugins+settings op, R8). */
export interface OwnSessionInstallRequest {
  /** Full plugin id `<name>@<marketplace>`. */
  pluginId: string;
  /** Optional marketplace source to add first (degrade to "open in /plugin" when unknown). */
  marketplaceSource?: string;
  /** When true, also write `enabledPlugins[pluginId]=true` at `scope` after install. */
  enableAfterInstall?: boolean;
  /** Scope for the post-install enable (default `user`). */
  scope?: OwnSessionScope;
}

/** Generic success body for own-session marketplace/install actions. */
export interface OwnSessionActionResult {
  status: 'applied';
  epoch: number;
  /** Advisory note, e.g. the blast-radius reminder or a degraded-path hint. */
  note?: string;
}

/** Error body for own-session actions (409 carries the lock holder). */
export interface OwnSessionActionError {
  error: string;
  /** Present when the action degraded instead of mutating (e.g. unknown marketplace → open in /plugin). */
  degraded?: boolean;
  lockHolder?: { operation: string; startedAt: string };
}

// ---------------------------------------------------------------------------
// Config-epoch drift surface (RFC "Surfacing reload drift"). A config epoch is a
// counter bumped on any Kookr plugin/settings change; each Kookr-managed session
// is stamped with the epoch it started under. The dashboard surfaces the
// sessions that started before the latest change, with a restart action.
// ---------------------------------------------------------------------------

/** One Kookr-managed session that started under an older config epoch. */
export interface DriftedSession {
  taskId: string;
  /** The config epoch this session was stamped with at its first spawn. */
  startedEpoch: number;
  /** ISO-8601 time the session started (for ordering/display). */
  startedAt: string;
  /** Human title, when known. */
  title?: string;
}

/** The reload-drift surface (RFC "Surfacing reload drift"). */
export interface ConfigDriftSurface {
  /** The current config epoch (the number new sessions are stamped with). */
  currentEpoch: number;
  /** Non-terminal Kookr-managed sessions whose start epoch is behind `currentEpoch`, newest first. */
  staleSessions: DriftedSession[];
  /** `staleSessions.length`, for a quick "N sessions started before your last change". */
  staleCount: number;
  /** Always set: Kookr's external-TUI blind spot, stated rather than implied. */
  externalCoverageNote: string;
}

// ---------------------------------------------------------------------------
// Fleet-aware, idle-gated, safe auto-update (RFC Layer 4 / R6). Per-plugin
// policy `off | notify | apply-when-idle`; `apply-when-idle` runs
// `claude plugin update <id>` through the shared PluginMutationService lock +
// backup ONLY when no non-terminal task depends on the plugin, verifies the new
// version, bumps the config epoch on success, and rolls back (scoped, not
// whole-dir) on a verify failure. R3a still holds everywhere: no per-skill
// toggles, `deniedSkills` stays empty.
// ---------------------------------------------------------------------------

/**
 * Per-plugin auto-update policy. `off` (the default when unset) never touches
 * the plugin. `notify` only surfaces staleness in the fleet view (the P1 read
 * model already computes it) — it is NOT evaluated by the auto-update runner.
 * `apply-when-idle` auto-applies an available update when the idle predicate
 * holds, through the shared lock + backup.
 */
export type AutoUpdatePolicy = 'off' | 'notify' | 'apply-when-idle';
export const AUTO_UPDATE_POLICIES: readonly AutoUpdatePolicy[] = ['off', 'notify', 'apply-when-idle'];
/** The policy a plugin has when it carries no stored entry. */
export const DEFAULT_AUTO_UPDATE_POLICY: AutoUpdatePolicy = 'off';

/** Why an auto-update evaluation did NOT apply (the audit skip reasons). */
export type AutoUpdateSkipReason = 'busy' | 'no-update' | 'policy-off' | 'check-failed';

/**
 * Terminal state of one auto-update evaluation (the audit state machine's
 * accepting states). `skipped` carries a {@link AutoUpdateSkipReason}; the rest
 * are apply outcomes. `verify-failed` always transitions to a rollback
 * (`rolled-back` or `rollback-failed`); it is recorded on its own first so the
 * audit trail shows the verify failure distinctly from its recovery.
 */
export type AutoUpdateEvalState =
  | 'skipped'
  | 'applied'
  | 'failed'
  | 'verify-failed'
  | 'rolled-back'
  | 'rollback-failed';

/** One durable auto-update decision record (written for every evaluation, incl. skips). */
export interface AutoUpdateDecision {
  pluginId: string;
  /** ISO-8601 time the evaluation finished. */
  evaluatedAt: string;
  /** The policy in force at evaluation time. */
  policy: AutoUpdatePolicy;
  /** The evaluation's terminal state. */
  state: AutoUpdateEvalState;
  /** Present when `state === 'skipped'`: why it skipped. */
  reason?: AutoUpdateSkipReason;
  /** For `reason === 'busy'`: the non-terminal task ids that hold the plugin busy. */
  busyTaskIds?: string[];
  /** Installed version before an apply ran (for `applied`/`failed`/`verify-failed`/rollback states). */
  fromVersion?: string | null;
  /** Installed version after a successful apply, or the version the apply targeted. */
  toVersion?: string | null;
  /** Human detail (an error message, the verify failure, a rollback note). */
  detail?: string;
}

/** A persistent operator-facing banner raised by the auto-updater (survives restarts until dismissed). */
export interface AutoUpdateBanner {
  pluginId: string;
  /**
   * `verify-failed`: the applied update did not load; it was rolled back and the
   * policy dropped to `notify`. `rollback-failed`: the rollback itself failed —
   * the retained snapshot path is named for manual recovery. `post-session`: a
   * rollback ran after sessions had already started on the new version — they
   * need a restart (surfaced via the config-epoch drift surface).
   */
  kind: 'verify-failed' | 'rollback-failed' | 'post-session';
  message: string;
  raisedAt: string;
  /** For `rollback-failed`: where the pre-update snapshot is preserved. */
  snapshotPath?: string;
}

/** Metadata for a retained, scoped pre-update snapshot (the plugin's own install dir only). */
export interface AutoUpdateSnapshotMeta {
  pluginId: string;
  /** The plugin's install dir that was snapshotted (scoped — NOT the whole plugins dir). */
  installPath: string;
  /** Where the snapshot copy lives. */
  snapshotPath: string;
  /** Installed version at snapshot time (what a rollback restores to). */
  fromVersion: string | null;
  takenAt: string;
  /** ISO-8601 time after which the snapshot is eligible for pruning (the stated retention window). */
  retainUntil: string;
}

/**
 * Records that Kookr has taken over the native per-marketplace `autoUpdate`
 * flag, with the value it found BEFORE taking over so release restores EXACTLY
 * that (never clobbering an operator's own explicit flag). Presence of a key ⇒
 * Kookr currently owns the flag for that marketplace.
 */
export interface AutoUpdateFlagOwnership {
  /** The `autoUpdate` value present before Kookr took over: `null` = the key was absent. */
  previousValue: boolean | null;
}

/** On-disk shape of the per-plugin auto-update store (versioned JSON, `<kookrDir>/plugin-auto-update.json`). */
export interface AutoUpdateStoreData {
  version: number;
  /** pluginId → policy. Absent ⇒ {@link DEFAULT_AUTO_UPDATE_POLICY}. */
  policies: Record<string, AutoUpdatePolicy>;
  /** pluginId → the last installed version Kookr observed (external-change detection baseline). */
  observed: Record<string, string | null>;
  /** pluginId → persistent banner (verify-failure / rollback-failure / post-session restart). */
  banners: Record<string, AutoUpdateBanner>;
  /** pluginId → retained pre-update snapshot metadata (for a scoped rollback within the window). */
  snapshots: Record<string, AutoUpdateSnapshotMeta>;
  /** marketplace → Kookr's `autoUpdate` takeover record (dual-writer ownership provenance). */
  autoUpdateOwnership: Record<string, AutoUpdateFlagOwnership>;
}

/** A logged external-version-change event (the installed version moved with no Kookr action). */
export interface AutoUpdateExternalChange {
  pluginId: string;
  fromVersion: string | null;
  toVersion: string | null;
  detectedAt: string;
}

/** Request to set a plugin's auto-update policy (`PUT /api/plugins/:id/auto-update`). */
export interface AutoUpdatePolicyRequest {
  policy: AutoUpdatePolicy;
}

/** Per-plugin auto-update view the dialog renders (policy + last decision + banner). */
export interface AutoUpdatePluginView {
  pluginId: string;
  policy: AutoUpdatePolicy;
  /** The most recent decision for this plugin, when one exists. */
  lastDecision: AutoUpdateDecision | null;
  /** A persistent banner for this plugin, when raised. */
  banner: AutoUpdateBanner | null;
  /** Whether a retained snapshot is available to roll back to right now. */
  rollbackAvailable: boolean;
  /**
   * The EFFECTIVE native `autoUpdate` for this plugin's marketplace — the
   * explicit flag when a scope sets one, else the documented default (ON for
   * official/claude.ai, OFF otherwise), read NOT assumed. Shows the operator
   * whether Claude Code's own updater is active for the plugin.
   */
  nativeAutoUpdate: boolean;
}

/** `GET /api/plugins/auto-update` body: the fleet auto-update surface. */
export interface AutoUpdateSurface {
  plugins: AutoUpdatePluginView[];
  /** The recent audit trail (most recent first, capped). */
  recentDecisions: AutoUpdateDecision[];
  /** Whether the auto-apply runner is enabled for this process (the default-off env gate). */
  applyEnabled: boolean;
}

/** Success body for setting a policy / running an evaluation / rolling back. */
export interface AutoUpdateActionResult {
  status: 'ok';
  plugin: AutoUpdatePluginView;
}

/** Error body for auto-update routes (409 carries the lock holder). */
export interface AutoUpdateActionError {
  error: string;
  pluginId?: string;
  lockHolder?: { operation: string; startedAt: string };
}
