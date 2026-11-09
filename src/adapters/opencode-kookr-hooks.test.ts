import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultKookrClaudeHooks, resolveDefaultPluginHooksDir } from './opencode-kookr-hooks.js';

function fixture(files: string[]): { root: string; hooks: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'kookr-ochooks-'));
  const hooks = join(root, 'plugin', 'hooks');
  const bin = join(root, 'bin');
  mkdirSync(hooks, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const f of files) {
    const p = f.startsWith('bin/') ? join(root, f) : join(hooks, f);
    writeFileSync(p, '#!/bin/sh\n');
    chmodSync(p, 0o755);
  }
  return { root, hooks, bin };
}

describe('defaultKookrClaudeHooks', () => {
  it('wires SessionStart nb-inject and Stop [nb-retro, nudge] with CLAUDE_PLUGIN_ROOT, nudge age gate off', () => {
    const f = fixture(['nb-inject.sh', 'nb-retro.sh', 'bin/kookr-stop-nudge.js']);
    const cfg = defaultKookrClaudeHooks({ pluginHooksDir: f.hooks, binDir: f.bin })!;
    expect(cfg.env).toEqual({ CLAUDE_PLUGIN_ROOT: join(f.root, 'plugin'), KOOKR_NUDGE_MIN_TASK_AGE_MS: '0' });
    expect(cfg.hooks.SessionStart![0]!.hooks[0]!.command).toContain('nb-inject.sh');
    const stop = cfg.hooks.Stop![0]!.hooks.map((h) => h.command);
    expect(stop).toHaveLength(2);
    // Retrospective first, completion nudge last: a re-prompt after completion-ready would clear it.
    expect(stop[0]).toContain('nb-retro.sh');
    expect(stop[1]).toContain('kookr-stop-nudge.js');
  });

  it('skips nb hooks with a warning when the hooks dir is missing, keeps the nudge', () => {
    const f = fixture(['bin/kookr-stop-nudge.js']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = defaultKookrClaudeHooks({ pluginHooksDir: join(f.root, 'nope'), binDir: f.bin })!;
    expect(cfg.hooks.SessionStart).toBeUndefined();
    expect(cfg.hooks.Stop![0]!.hooks).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nb hooks skipped'));
    warn.mockRestore();
  });

  it('returns undefined when nothing is available', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(defaultKookrClaudeHooks({})).toBeUndefined();
    warn.mockRestore();
  });

  it('resolveDefaultPluginHooksDir honours KOOKR_OPENCODE_HOOKS_DIR only when nb-inject.sh exists', () => {
    const f = fixture(['nb-inject.sh']);
    expect(resolveDefaultPluginHooksDir({ KOOKR_OPENCODE_HOOKS_DIR: f.hooks })).toBe(f.hooks);
    expect(resolveDefaultPluginHooksDir({ KOOKR_OPENCODE_HOOKS_DIR: join(f.root, 'x') })).toBeUndefined();
  });
});
