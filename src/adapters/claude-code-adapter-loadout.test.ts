import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { TaskStore } from '../core/tasks.js';
import type { ResolvedLoadout } from '../shared/contracts/plugins.js';
import type { ResumeContext } from './agent-adapter.js';

// getGitInfo is fire-and-forget on launch; stub it so the test does not shell to git.
vi.mock('./git-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-info.js')>();
  return { ...actual, getGitInfo: vi.fn().mockResolvedValue(null) };
});

/**
 * Drive a minimal non-bracketed launch and return the settings file the adapter
 * wrote for it. A `promptBracketedPaste:false` launch completes without any
 * injected hook (the delivery path assumes submission), so we can read back the
 * `--settings` content synchronously after the launch resolves.
 */
describe('ClaudeCodeAdapter — plugin loadout injection (RFC Layer 2 / slice 2b)', () => {
  let backend: FakeTerminalBackend;
  let taskStore: TaskStore;
  let tmp: string;
  let settingsDir: string;
  let hooksDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    tmp = mkdtempSync(join(tmpdir(), 'kookr-loadout-adapter-'));
    settingsDir = join(tmp, 'settings');
    hooksDir = join(tmp, 'hooks');
    mkdirSync(settingsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeAdapter(opts?: { pluginDir?: string }): { adapter: ClaudeCodeAdapter; written: Map<string, string> } {
    const written = new Map<string, string>();
    const adapter = new ClaudeCodeAdapter(backend, taskStore, {
      settingsDir,
      hooksDir,
      promptBracketedPaste: false,
      writeFile: (path, content) => {
        written.set(path, content);
        return Promise.resolve();
      },
      // Empty string disables --plugin-dir auto-resolution so tests do not pick
      // up the ambient repo's real toolkit dir; pass an explicit dir to exercise
      // the @inline rewrite.
      pluginDir: opts?.pluginDir ?? '',
    });
    return { adapter, written };
  }

  async function launchAndRead(
    adapter: ClaudeCodeAdapter,
    written: Map<string, string>,
    opts?: { resolvedLoadout?: ResolvedLoadout; resume?: ResumeContext; onLoadoutApplied?: (a: { settingsHash: string; settingsPath: string }) => void },
  ): Promise<{ raw: string; parsed: Record<string, unknown> }> {
    const task = taskStore.createTask('t', join(tmp, 'proj'));
    const tmuxName = `kookr-fixed-${Math.random().toString(36).slice(2, 8)}`;
    await adapter.launch(task.id, 'do it', join(tmp, 'proj'), opts?.resume, {
      tmuxName,
      ...(opts?.resolvedLoadout ? { resolvedLoadout: opts.resolvedLoadout } : {}),
      ...(opts?.onLoadoutApplied ? { onLoadoutApplied: opts.onLoadoutApplied } : {}),
    });
    const raw = written.get(join(settingsDir, `${tmuxName}.json`))!;
    return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
  }

  const disableToolkit: ResolvedLoadout = {
    enabledOverrides: { 'kookr-toolkit@kookr': false },
    enabledSet: [],
    deniedSkills: [],
  };

  test('flag OFF + loadout passed → settings byte-identical to no-loadout (no enabledPlugins)', async () => {
    const { adapter, written } = makeAdapter();
    const base = await launchAndRead(adapter, written); // no loadout at all
    const withLoadoutFlagOff = await launchAndRead(adapter, written, { resolvedLoadout: disableToolkit });
    expect(base.parsed.enabledPlugins).toBeUndefined();
    expect(withLoadoutFlagOff.parsed.enabledPlugins).toBeUndefined();
    // Byte-for-byte identical (the two differ only by the tmuxName in hook paths,
    // so compare after normalizing that out).
    const strip = (s: string) => s.replace(/kookr-fixed-[a-z0-9]+/g, 'SID');
    expect(strip(withLoadoutFlagOff.raw)).toBe(strip(base.raw));
  });

  test('flag ON + empty loadout → settings byte-identical to no-loadout (kill-switch)', async () => {
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '1');
    const { adapter, written } = makeAdapter();
    const base = await launchAndRead(adapter, written);
    const empty: ResolvedLoadout = { enabledOverrides: {}, enabledSet: [], deniedSkills: [] };
    const res = await launchAndRead(adapter, written, { resolvedLoadout: empty });
    expect(res.parsed.enabledPlugins).toBeUndefined();
    const strip = (s: string) => s.replace(/kookr-fixed-[a-z0-9]+/g, 'SID');
    expect(strip(res.raw)).toBe(strip(base.raw));
  });

  test('flag ON + plugin-level loadout → rendered into enabledPlugins', async () => {
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '1');
    const { adapter, written } = makeAdapter();
    const res = await launchAndRead(adapter, written, {
      resolvedLoadout: { enabledOverrides: { 'stripe@mkt': false }, enabledSet: [], deniedSkills: [] },
    });
    expect(res.parsed.enabledPlugins).toEqual({ 'stripe@mkt': false });
    // Pre-existing keys still present and unchanged in shape.
    expect(res.parsed.hooks).toBeDefined();
  });

  test('flag ON + dir-loaded toolkit → override rewritten to @inline (P2 probe)', async () => {
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '1');
    const pluginDir = join(tmp, 'plugin');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'kookr-toolkit', version: '1.0.0' }),
    );
    const { adapter, written } = makeAdapter({ pluginDir });
    const res = await launchAndRead(adapter, written, { resolvedLoadout: disableToolkit });
    expect(res.parsed.enabledPlugins).toEqual({ 'kookr-toolkit@inline': false });
  });

  test('onLoadoutApplied fires with a hash + path only when a loadout renders', async () => {
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '1');
    const { adapter, written } = makeAdapter();
    const applied: Array<{ settingsHash: string; settingsPath: string }> = [];
    await launchAndRead(adapter, written, {
      resolvedLoadout: { enabledOverrides: { 'stripe@mkt': false }, enabledSet: [], deniedSkills: [] },
      onLoadoutApplied: (a) => applied.push(a),
    });
    expect(applied).toHaveLength(1);
    expect(applied[0].settingsPath).toContain('.json');
    // The hash must be the sha256 of the ACTUAL written settings file, so a
    // hash-over-wrong-content regression is caught (not just "some sha256").
    const writtenContent = written.get(applied[0].settingsPath)!;
    expect(applied[0].settingsHash).toBe(createHash('sha256').update(writtenContent).digest('hex'));
  });

  test('onLoadoutApplied does NOT fire for an empty loadout', async () => {
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '1');
    const { adapter, written } = makeAdapter();
    const applied: unknown[] = [];
    await launchAndRead(adapter, written, {
      resolvedLoadout: { enabledOverrides: {}, enabledSet: [], deniedSkills: [] },
      onLoadoutApplied: (a) => applied.push(a),
    });
    expect(applied).toHaveLength(0);
  });

  test('resume launch replays the passed loadout into the forked session settings', async () => {
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '1');
    const { adapter, written } = makeAdapter();
    // A resume context with a sessionId and no transcriptPath takes the resume
    // branch, which still writes the --settings file. The launcher passes the
    // RECORDED loadout here; the adapter must render it (not drop it).
    const res = await launchAndRead(adapter, written, {
      resume: { sessionId: '00000000-0000-0000-0000-000000000001' },
      resolvedLoadout: disableToolkit,
    });
    expect(res.parsed.enabledPlugins).toEqual({ 'kookr-toolkit@kookr': false });
  });
});
