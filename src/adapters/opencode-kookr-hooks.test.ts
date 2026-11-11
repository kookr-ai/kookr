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

  it('puts the deliverable gate FIRST in Stop, before nb-retro and nudge', () => {
    const f = fixture(['nb-inject.sh', 'nb-retro.sh', 'bin/kookr-stop-nudge.js', 'bin/kookr-opencode-gate.js']);
    const cfg = defaultKookrClaudeHooks({ pluginHooksDir: f.hooks, binDir: f.bin, deliverable: { kind: 'file', name: 'REVIEW.md' } })!;
    const stop = cfg.hooks.Stop![0]!.hooks;
    expect(stop).toHaveLength(3);
    expect(stop[0]!.command).toContain('kookr-opencode-gate.js');
    expect(stop[0]!.command).toContain("--kind 'file:REVIEW.md'");
    expect(stop[1]!.command).toContain('nb-retro.sh');
    expect(stop[2]!.command).toContain('kookr-stop-nudge.js');
    const pr = defaultKookrClaudeHooks({ pluginHooksDir: f.hooks, binDir: f.bin, deliverable: { kind: 'commit-and-pr-body' } })!;
    expect(pr.hooks.Stop![0]!.hooks[0]!.command).toContain("--kind 'commit-and-pr-body'");
  });

  it('blocks Bash publishing for profiled workers: PreToolUse push guard only when there is a deliverable', () => {
    const f = fixture(['nb-inject.sh', 'nb-retro.sh', 'bin/kookr-stop-nudge.js', 'bin/kookr-opencode-gate.js', 'bin/kookr-opencode-push-guard.js']);
    const base = { pluginHooksDir: f.hooks, binDir: f.bin };
    for (const deliverable of [{ kind: 'commit-and-pr-body' as const }, { kind: 'file' as const, name: 'AUDIT.md' }]) {
      const cfg = defaultKookrClaudeHooks({ ...base, deliverable })!;
      expect(cfg.hooks.PreToolUse).toHaveLength(1);
      expect(cfg.hooks.PreToolUse![0]!.matcher).toBe('Bash');
      expect(cfg.hooks.PreToolUse![0]!.hooks).toHaveLength(1);
      expect(cfg.hooks.PreToolUse![0]!.hooks[0]!.command).toContain('kookr-opencode-push-guard.js');
    }
    // No profile deliverable (or deliverable none): the worker keeps the generic worktree/PR flow.
    expect(defaultKookrClaudeHooks(base)!.hooks.PreToolUse).toBeUndefined();
    expect(defaultKookrClaudeHooks({ ...base, deliverable: { kind: 'none' } })!.hooks.PreToolUse).toBeUndefined();
  });

  it('warns and still returns the rest when the push guard script is missing', () => {
    const f = fixture(['nb-inject.sh', 'nb-retro.sh', 'bin/kookr-stop-nudge.js', 'bin/kookr-opencode-gate.js']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = defaultKookrClaudeHooks({ pluginHooksDir: f.hooks, binDir: f.bin, deliverable: { kind: 'commit-and-pr-body' } })!;
    expect(cfg.hooks.PreToolUse).toBeUndefined();
    expect(cfg.hooks.Stop![0]!.hooks[0]!.command).toContain('kookr-opencode-gate.js');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('push guard skipped'));
    warn.mockRestore();
  });

  it('adds no gate for deliverable none, and warns (still returns the rest) when the gate script is missing', () => {
    const f = fixture(['nb-inject.sh', 'nb-retro.sh', 'bin/kookr-stop-nudge.js']);
    const none = defaultKookrClaudeHooks({ pluginHooksDir: f.hooks, binDir: f.bin, deliverable: { kind: 'none' } })!;
    expect(none.hooks.Stop![0]!.hooks).toHaveLength(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = defaultKookrClaudeHooks({ pluginHooksDir: f.hooks, binDir: f.bin, deliverable: { kind: 'commit-and-pr-body' } })!;
    expect(missing.hooks.Stop![0]!.hooks).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deliverable gate skipped'));
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
