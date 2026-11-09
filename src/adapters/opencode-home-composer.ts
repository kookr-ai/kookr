/**
 * Per-session opencode home composer (RFC rfc-opencode-agent-integration §3).
 *
 * Writes an isolated session directory so the operator's real
 * ~/.config/opencode and ~/.local/share/opencode are never read or modified:
 *
 *   <sessionDir>/opencode.json
 *   <sessionDir>/cfg/plugins/kookr.js   (hook emitter)
 *   <sessionDir>/cfg/AGENTS.md          (only when instructions given)
 *   <sessionDir>/data (or opts.dataHome), <sessionDir>/xdg-config  (XDG roots)
 *
 * The provider apiKey is always an `{env:NAME}` reference, never a literal.
 */
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isOpenCodeSeedReady, seedConfigDir } from './opencode-seed.js';
import { buildKookrPluginSource, type ClaudeHooksConfig } from './opencode-instrumentation/kookr-plugin-source.js';

export interface ComposeOpenCodeSessionOptions {
  sessionDir: string;
  sessionId: string;
  cwd: string;
  hookCommand: string;
  model: {
    providerId: string;
    modelId: string;
    displayName?: string;
    baseUrl: string;
    apiKeyEnv: string;
  };
  instructions?: string;
  permission?: 'allow' | 'ask';
  /** Extra plugin files: filename (e.g. `foo.js`) -> source text. */
  extraPluginSources?: Record<string, string>;
  /** Claude-shaped hooks the plugin runs with Claude semantics (block/inject/re-prompt). */
  claudeHooks?: ClaudeHooksConfig;
  /**
   * Absolute XDG_DATA_HOME to use instead of `<sessionDir>/data` (the per-task persistent dir, so the
   * opencode DB survives the session for resume). The caller owns its lifetime.
   */
  dataHome?: string;
  /** Prepared seed template (see opencode-seed.ts). When usable it is hardlinked into both config roots. */
  seedDir?: string;
  /** Also set `OPENCODE_FAST_BOOT=1` (seeded sessions only; see the adapter's `fastBoot`). */
  fastBoot?: boolean;
  /** Cap for the TUI's JS heap via `BUN_JSC_forceRAMSize` (MB). 0/undefined = no cap. */
  ramLimitMb?: number;
}

export interface ComposedOpenCodeSession {
  dir: string;
  configPath: string;
  configDir: string;
  dataHome: string;
  pluginPath: string;
  /** True when the session's config roots were pre-seeded. */
  seeded: boolean;
  env: Record<string, string>;
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function composeOpenCodeSession(
  opts: ComposeOpenCodeSessionOptions,
): Promise<ComposedOpenCodeSession> {
  if (!isAbsolute(opts.sessionDir)) {
    throw new Error(`opencode sessionDir must be absolute: ${opts.sessionDir}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.model.apiKeyEnv)) {
    throw new Error(`invalid apiKeyEnv name: ${opts.model.apiKeyEnv}`);
  }
  const dir = opts.sessionDir;
  const configDir = join(dir, 'cfg');
  const pluginsDir = join(configDir, 'plugins');
  const dataHome = opts.dataHome ?? join(dir, 'data');
  if (!isAbsolute(dataHome)) throw new Error(`opencode dataHome must be absolute: ${dataHome}`);
  const xdgConfigHome = join(dir, 'xdg-config');
  for (const d of [dir, configDir, pluginsDir, dataHome, xdgConfigHome]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
    await chmod(d, 0o700);
  }

  // Pre-seed both config roots opencode installs `@opencode-ai/plugin` into. Any failure => unseeded.
  let seeded = false;
  if (opts.seedDir && isOpenCodeSeedReady(opts.seedDir)) {
    try {
      await seedConfigDir(opts.seedDir, configDir);
      await seedConfigDir(opts.seedDir, join(xdgConfigHome, 'opencode'));
      seeded = true;
    } catch (err) {
      console.warn(`[opencode-home-composer] seeding failed (${(err as Error).message}); booting unseeded`);
      await Promise.all([join(configDir, 'node_modules'), join(xdgConfigHome, 'opencode')].map((d) => rm(d, { recursive: true, force: true })));
      for (const f of ['package.json', 'package-lock.json', '.gitignore']) await rm(join(configDir, f), { force: true });
    }
  }

  const perm = opts.permission ?? 'allow';
  const { providerId, modelId, displayName, baseUrl, apiKeyEnv } = opts.model;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: `${providerId}/${modelId}`,
    permission: { edit: perm, bash: perm, external_directory: perm },
    provider: {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: displayName ?? providerId,
        options: { baseURL: baseUrl, apiKey: `{env:${apiKeyEnv}}` },
        models: { [modelId]: { name: displayName ?? modelId } },
      },
    },
  };
  const configPath = join(dir, 'opencode.json');
  await atomicWrite(configPath, JSON.stringify(config, null, 2));

  const pluginPath = join(pluginsDir, 'kookr.js');
  await atomicWrite(
    pluginPath,
    buildKookrPluginSource({ hookCommand: opts.hookCommand, sessionId: opts.sessionId, cwd: opts.cwd, claudeHooks: opts.claudeHooks }),
  );
  for (const [name, source] of Object.entries(opts.extraPluginSources ?? {})) {
    if (name.includes('/') || name.includes('\\') || name.startsWith('.') || name === 'kookr.js') {
      throw new Error(`invalid extra plugin filename: ${name}`);
    }
    await atomicWrite(join(pluginsDir, name), source);
  }
  if (opts.instructions !== undefined) {
    await atomicWrite(join(configDir, 'AGENTS.md'), opts.instructions);
  }

  return {
    dir,
    configPath,
    configDir,
    dataHome,
    pluginPath,
    seeded,
    env: {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // Opt-in, seeded only: unseeded + FAST_BOOT loses the initial prompt, and it needs an attached terminal.
      ...(seeded && opts.fastBoot ? { OPENCODE_FAST_BOOT: '1' } : {}),
      ...(opts.ramLimitMb && opts.ramLimitMb > 0 ? { BUN_JSC_forceRAMSize: String(Math.floor(opts.ramLimitMb) * 1024 * 1024) } : {}),
    },
  };
}
