/**
 * Marketplace-plugin version status — wire contract for the `plugin` field on
 * GET /api/deploy/status. Lets the dashboard nudge the user to install (or
 * update) the kookr-toolkit marketplace plugin. Computed by the server's
 * plugin-version-status module; consumed by the TopBar badge popover and the
 * PluginInstallBanner.
 */
export interface PluginVersionStatus {
  /** Marketplace plugin identifier, e.g. "kookr-toolkit@kookr". */
  pluginId: string;
  /** Version recorded in ~/.claude/plugins/installed_plugins.json, or null if not installed via the marketplace. */
  installedVersion: string | null;
  /** Latest published version (from origin/main's plugin manifest), or null if unknown. */
  availableVersion: string | null;
  /** True when a marketplace install exists and is strictly behind the available version. */
  stale: boolean;
}

export interface PluginUpdateCommands {
  /** Slash commands for a user already inside Claude Code. */
  slash: string[];
  /** Equivalent non-interactive CLI commands used by Kookr's backend. */
  cli: string[];
}

export interface PluginUpdateResult {
  status: 'updated';
  plugin: PluginVersionStatus;
  commands: PluginUpdateCommands;
}

export interface PluginUpdateError {
  error: string;
  commands: PluginUpdateCommands;
  plugin?: PluginVersionStatus;
}

export interface PluginInstallResult {
  status: 'installed';
  plugin: PluginVersionStatus;
  commands: PluginUpdateCommands;
}

export function pluginInstallCommands(pluginId: string, marketplaceSlug: string): PluginUpdateCommands {
  return {
    slash: [`/plugin marketplace add ${marketplaceSlug}`, `/plugin install ${pluginId}`],
    cli: [`claude plugin marketplace add ${marketplaceSlug}`, `claude plugin install ${pluginId}`],
  };
}

export function marketplaceNameFromPluginId(pluginId: string): string {
  const [, marketplace] = pluginId.split('@');
  return marketplace?.trim() || 'kookr';
}

export function pluginUpdateCommands(pluginId: string, marketplace: string): PluginUpdateCommands {
  return {
    slash: [`/plugin marketplace update ${marketplace}`, `/plugin update ${pluginId}`],
    cli: [`claude plugin marketplace update ${marketplace}`, `claude plugin update ${pluginId}`],
  };
}

/**
 * GitHub repo slug for `/plugin marketplace add`. Not recoverable from the
 * plugin/marketplace manifests (which only carry the marketplace *name*), so it
 * is pinned here as the single source for the install instructions shown in the
 * TopBar popover and the install banner — keeping the two surfaces from drifting.
 */
export const TOOLKIT_MARKETPLACE_SLUG = 'kookr-ai/kookr';
