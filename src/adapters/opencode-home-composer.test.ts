import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { composeOpenCodeSession } from './opencode-home-composer.js';

const model = {
  providerId: 'deepinfra',
  modelId: 'deepseek-ai/X',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
};

function opts(dir: string, extra = {}) {
  return { sessionDir: join(dir, 'sess'), sessionId: 's1', cwd: '/w', hookCommand: 'cat', model, ...extra };
}

describe('composeOpenCodeSession', () => {
  it('writes config, plugin, env; apiKey is an env reference', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oc-'));
    process.env.OPENAI_API_KEY = 'sk-SECRET-VALUE';
    const r = await composeOpenCodeSession(opts(tmp, { instructions: 'be nice' }));
    const raw = readFileSync(r.configPath, 'utf8');
    const cfg = JSON.parse(raw);
    expect(cfg.model).toBe('deepinfra/deepseek-ai/X');
    expect(cfg.permission).toEqual({ edit: 'allow', bash: 'allow', external_directory: 'allow' });
    expect(cfg.provider.deepinfra.options.apiKey).toBe('{env:OPENAI_API_KEY}');
    expect(raw).not.toContain('sk-SECRET-VALUE');
    expect(readFileSync(join(r.configDir, 'AGENTS.md'), 'utf8')).toBe('be nice');
    expect(() => new Script(readFileSync(r.pluginPath, 'utf8').replace(/^import .*$/gm, '').replace(/^export const/m, 'const'))).not.toThrow();
    expect(r.env).toMatchObject({
      OPENCODE_CONFIG: r.configPath,
      OPENCODE_CONFIG_DIR: r.configDir,
      XDG_DATA_HOME: r.dataHome,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    expect(r.env.XDG_CONFIG_HOME.startsWith(r.dir)).toBe(true);
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(statSync(r.configPath).mode & 0o777).toBe(0o600);
    delete process.env.OPENAI_API_KEY;
  });

  it('omits AGENTS.md without instructions, supports ask, is idempotent, leaves HOME untouched', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oc-'));
    const home = join(tmp, 'home');
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const a = await composeOpenCodeSession(opts(tmp, { permission: 'ask' }));
      const b = await composeOpenCodeSession(opts(tmp, { permission: 'ask', extraPluginSources: { 'x.js': 'export {}' } }));
      expect(b.dir).toBe(a.dir);
      expect(existsSync(join(a.configDir, 'AGENTS.md'))).toBe(false);
      expect(JSON.parse(readFileSync(a.configPath, 'utf8')).permission.bash).toBe('ask');
      expect(readdirSync(join(a.configDir, 'plugins')).sort()).toEqual(['kookr.js', 'x.js']);
      expect(existsSync(home)).toBe(false);
    } finally {
      process.env.HOME = prev;
    }
  });

  it('rejects relative dirs, bad env names and bad plugin names', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oc-'));
    await expect(composeOpenCodeSession({ ...opts(tmp), sessionDir: 'rel' })).rejects.toThrow();
    await expect(composeOpenCodeSession(opts(tmp, { model: { ...model, apiKeyEnv: 'sk-abc def' } }))).rejects.toThrow();
    await expect(composeOpenCodeSession(opts(tmp, { extraPluginSources: { '../x.js': '' } }))).rejects.toThrow();
  });

  it('seeds both config roots (hardlinks) and sets FAST_BOOT only when seeded; ramLimitMb sets BUN_JSC_forceRAMSize', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oc-'));
    const seed = join(tmp, 'seed');
    mkdirSync(join(seed, 'node_modules', 'p'), { recursive: true });
    for (const f of ['package.json', 'package-lock.json', '.gitignore', '.seed-ready']) writeFileSync(join(seed, f), '1');
    writeFileSync(join(seed, 'node_modules', 'p', 'a.js'), 'x');
    const seeded = await composeOpenCodeSession(opts(tmp, { seedDir: seed, ramLimitMb: 512, fastBoot: true }));
    expect(seeded.seeded).toBe(true);
    expect(seeded.env.OPENCODE_FAST_BOOT).toBe('1');
    const noFast = await composeOpenCodeSession({ ...opts(tmp), sessionDir: join(tmp, 'sess3'), seedDir: seed });
    expect(noFast.seeded).toBe(true);
    expect(noFast.env.OPENCODE_FAST_BOOT).toBeUndefined();
    expect(seeded.env.BUN_JSC_forceRAMSize).toBe(String(512 * 1024 * 1024));
    expect(statSync(join(seeded.configDir, 'node_modules/p/a.js')).ino).toBe(statSync(join(seed, 'node_modules/p/a.js')).ino);
    expect(existsSync(join(seeded.env.XDG_CONFIG_HOME, 'opencode', 'package-lock.json'))).toBe(true);

    const plain = await composeOpenCodeSession({ ...opts(tmp), sessionDir: join(tmp, 'sess2'), seedDir: join(tmp, 'missing') });
    expect(plain.seeded).toBe(false);
    expect(plain.env.OPENCODE_FAST_BOOT).toBeUndefined();
    expect(plain.env.BUN_JSC_forceRAMSize).toBeUndefined();
    expect(existsSync(join(plain.configDir, 'node_modules'))).toBe(false);
  });
});
