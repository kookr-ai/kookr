import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectStandalonePlugin,
  settingsFilePaths,
} from './ralph-plugin-coexistence.js';

async function makeFakeHome(): Promise<{ home: string; cwd: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'ralph-coexistence-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(cwd, '.claude'), { recursive: true });
  return {
    home,
    cwd,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe('settingsFilePaths', () => {
  it('returns the four documented files in precedence order', () => {
    const paths = settingsFilePaths('/projects/foo', '/home/jean');
    expect(paths).toEqual([
      '/projects/foo/.claude/settings.local.json',
      '/projects/foo/.claude/settings.json',
      '/home/jean/.claude/settings.local.json',
      '/home/jean/.claude/settings.json',
    ]);
  });
});

describe('detectStandalonePlugin', () => {
  let env: { home: string; cwd: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    env = await makeFakeHome();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns detected=false when no settings files exist', async () => {
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(false);
    expect(result.matchedFiles).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it('detects enabledPlugins entry in user settings', async () => {
    await writeFile(
      join(env.home, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'ralph-wiggum@claude-code-plugins': true },
      }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(true);
    expect(result.matchedFiles).toHaveLength(1);
    expect(result.matchedFiles[0]).toBe(join(env.home, '.claude', 'settings.json'));
    expect(result.reasons[0]).toContain('ralph-wiggum@claude-code-plugins');
  });

  it('detects entry under different marketplace suffix', async () => {
    await writeFile(
      join(env.home, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'ralph-wiggum@some-other-marketplace': true },
      }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(true);
  });

  it('does not match when enabled flag is false', async () => {
    await writeFile(
      join(env.home, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'ralph-wiggum@claude-code-plugins': false },
      }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(false);
  });

  it('does not match unrelated plugin entries', async () => {
    await writeFile(
      join(env.home, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'kookr-toolkit@kookr': true, 'something-else': true },
      }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(false);
  });

  it('detects Stop hook command referencing ralph-wiggum', async () => {
    await writeFile(
      join(env.cwd, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: '/some/path/ralph-wiggum/hooks/stop-hook.sh' },
              ],
            },
          ],
        },
      }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(true);
    expect(result.reasons[0]).toContain('ralph-wiggum');
  });

  it('reports every matched file when the plugin is enabled in multiple places', async () => {
    await writeFile(
      join(env.cwd, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'ralph-wiggum@a': true } }),
    );
    await writeFile(
      join(env.home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'ralph-wiggum@b': true } }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(true);
    expect(result.matchedFiles).toHaveLength(2);
  });

  it('skips malformed JSON files silently', async () => {
    await writeFile(join(env.home, '.claude', 'settings.json'), 'not valid json {{{');
    await writeFile(
      join(env.cwd, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'ralph-wiggum@a': true } }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    // The malformed file is skipped, the valid match still wins.
    expect(result.detected).toBe(true);
    expect(result.matchedFiles).toEqual([join(env.cwd, '.claude', 'settings.json')]);
  });

  it('handles settings file that is valid JSON but not an object', async () => {
    await writeFile(join(env.home, '.claude', 'settings.json'), '"just a string"');
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(false);
  });

  it('handles enabledPlugins that is missing or wrong shape', async () => {
    await writeFile(
      join(env.home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: null }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(false);
  });

  it('handles Stop hook entries with missing inner hooks', async () => {
    await writeFile(
      join(env.cwd, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{}] } }),
    );
    const result = await detectStandalonePlugin(env.cwd, env.home);
    expect(result.detected).toBe(false);
  });
});
