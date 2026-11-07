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
}

export interface PluginsReadModel {
  plugins: ManagedPlugin[];
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
