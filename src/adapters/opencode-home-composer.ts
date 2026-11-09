/**
 * Per-session opencode home composer (RFC rfc-opencode-agent-integration §3).
 *
 * Writes an isolated session directory so the operator's real
 * ~/.config/opencode and ~/.local/share/opencode are never read or modified:
 *
 *   <sessionDir>/opencode.json
 *   <sessionDir>/cfg/plugins/kookr.js   (hook emitter)
 *   <sessionDir>/cfg/AGENTS.md          (only when instructions given)
 *   <sessionDir>/data, <sessionDir>/xdg-config  (XDG roots)
 *
 * The provider apiKey is always an `{env:NAME}` reference, never a literal.
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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
}

export interface ComposedOpenCodeSession {
  dir: string;
  configPath: string;
  configDir: string;
  dataHome: string;
  pluginPath: string;
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
  const dataHome = join(dir, 'data');
  const xdgConfigHome = join(dir, 'xdg-config');
  for (const d of [dir, configDir, pluginsDir, dataHome, xdgConfigHome]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
    await chmod(d, 0o700);
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
    env: {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
  };
}
