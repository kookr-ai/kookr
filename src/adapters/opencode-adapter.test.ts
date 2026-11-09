import { gitExecEnv } from '../core/git-helpers.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { LaunchAbortedError } from './launch-abort.js';
import { composeOpenCodeSession } from './opencode-home-composer.js';
import { OpenCodeAdapter, OpenCodeSessionUnreadableError, parseRamLimitMb, type OpenCodeAdapterOptions } from './opencode-adapter.js';
import type { OpenCodeProfile } from './opencode-kookr-hooks.js';
import type { ProbeExecRunner } from './probe-agent-binary.js';
import type { AgentEvent } from '../core/types.js';
import { TaskStore } from '../core/tasks.js';

vi.mock('./git-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-info.js')>();
  return { ...actual, getGitInfo: vi.fn().mockResolvedValue(null) };
});

const hook = (name: string, extra: Record<string, unknown> = {}, sessionId = 'kookr-oc1') =>
  JSON.stringify({ session_id: sessionId, hook_event_name: name, cwd: '/workspace', transcript_path: '', ...extra });

describe('OpenCodeAdapter', () => {
  let backend: FakeTerminalBackend;
  let taskStore: TaskStore;
  let sessionRoot: string;

  function makeAdapter(overrides: Partial<OpenCodeAdapterOptions> = {}) {
    return new OpenCodeAdapter(backend, taskStore, {
      env: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
      agentBin: '/opt/opencode',
      sessionRoot,
      dataRoot: join(sessionRoot, 'opencode-data'),
      dataDoneTtlHours: 0,
      postStopSweepDelayMs: 0,
      promptBracketedPaste: false,
      promptReadyTimeoutMs: 20,
      promptSubmitConfirmTimeoutMs: 40,
      shelfShow: async () => '', // never read the host's real notebooks
      ...overrides,
    });
  }

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    sessionRoot = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'));
  });

  afterEach(() => {
    rmSync(sessionRoot, { recursive: true, force: true });
  });

  async function launch(adapter: OpenCodeAdapter, opts?: Parameters<OpenCodeAdapter['launch']>[4]) {
    const task = taskStore.createTask('do it', '/workspace');
    const id = await adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1', ...opts });
    return { task, id };
  }

  test('launches `<bin> <cwd>` with composed session env and registers the session', async () => {
    const adapter = makeAdapter();
    const { task, id } = await launch(adapter, { extraEnv: { RALPH_ITERATION: '2' } });
    const spec = backend.sessions.get(id)!.spec;
    expect(spec.command).toBe('/opt/opencode');
    expect(spec.args).toEqual(['/workspace']);
    expect(spec.cwd).toBe('/workspace');
    expect(spec.size).toEqual({ cols: 200, rows: 50 });
    expect(spec.env).toMatchObject({
      KOOKR_TASK_ID: task.id,
      RALPH_ITERATION: '2',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    expect(spec.env!.OPENCODE_CONFIG).toMatch(/opencode\.json$/);
    expect(spec.env!.OPENCODE_CONFIG_DIR).toBeDefined();
    expect(spec.env!.XDG_DATA_HOME).toBeDefined();
    const session = taskStore.getTask(task.id)!.sessions[0]!;
    expect(session).toMatchObject({ tmuxSession: id, agentType: 'opencode' });
    expect(adapter.getEffectiveHookSettings(id)?.agentType).toBe('opencode');
  });

  test('profile instructions, claudeHooks and hookEnv reach the composed session', async () => {
    const profile: OpenCodeProfile = {
      instructions: 'be terse',
      hookEnv: { NB_DIR: '/tmp/nb' },
      claudeHooks: { env: { CLAUDE_PLUGIN_ROOT: '/p' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
    };
    const adapter = makeAdapter({ profile });
    const { id } = await launch(adapter);
    const env = backend.sessions.get(id)!.spec.env!;
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'AGENTS.md'), 'utf-8')).toBe('be terse');
    const plugin = readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'kookr.js'), 'utf-8');
    expect(plugin).toContain('"CLAUDE_PLUGIN_ROOT":"/p"');
    expect(plugin).toContain('"NB_DIR":"/tmp/nb"');
  });

  describe('boot-time seed, RAM cap and profile memory', () => {
    const envOf = (id: string) => backend.sessions.get(id)!.spec.env!;

    test('RAM cap defaults to 512 MB, env/option override, 0 disables', async () => {
      const a = await launch(makeAdapter());
      expect(envOf(a.id).BUN_JSC_forceRAMSize).toBe(String(512 * 1024 * 1024));
      const b = await launch(makeAdapter({ env: { PATH: '/bin', KOOKR_OPENCODE_RAM_LIMIT_MB: '256' } as NodeJS.ProcessEnv }), { tmuxName: 'kookr-oc2' });
      expect(envOf(b.id).BUN_JSC_forceRAMSize).toBe(String(256 * 1024 * 1024));
      const c = await launch(makeAdapter({ env: { PATH: '/bin', KOOKR_OPENCODE_RAM_LIMIT_MB: '0' } as NodeJS.ProcessEnv }), { tmuxName: 'kookr-oc3' });
      expect(envOf(c.id).BUN_JSC_forceRAMSize).toBeUndefined();
      expect(parseRamLimitMb('junk')).toBe(512);
    });

    test('seed disabled by default: no seed run, no FAST_BOOT', async () => {
      const prepareSeed = vi.fn();
      const { id } = await launch(makeAdapter({ prepareSeed }));
      expect(prepareSeed).not.toHaveBeenCalled();
      expect(envOf(id).OPENCODE_FAST_BOOT).toBeUndefined();
    });

    test('seeded session links both config roots (FAST_BOOT only when opted in); failed seed boots unseeded', async () => {
      const seedDir = join(sessionRoot, 'seed-template');
      mkdirSync(join(seedDir, 'node_modules', 'p'), { recursive: true });
      for (const f of ['package.json', 'package-lock.json', '.gitignore', '.seed-ready']) writeFileSync(join(seedDir, f), '{}');
      writeFileSync(join(seedDir, 'node_modules', 'p', 'i.js'), 'x');
      const prepareSeed = vi.fn(async () => seedDir);
      const adapter = makeAdapter({ seed: true, prepareSeed });
      const { id } = await launch(adapter);
      const env = envOf(id);
      expect(env.OPENCODE_FAST_BOOT).toBeUndefined(); // FAST_BOOT is opt-in (needs an attached terminal)
      expect(existsSync(join(env.OPENCODE_CONFIG_DIR!, 'node_modules', 'p', 'i.js'))).toBe(true);
      expect(existsSync(join(env.XDG_CONFIG_HOME!, 'opencode', 'node_modules', 'p', 'i.js'))).toBe(true);
      const fast = await launch(makeAdapter({ seed: true, prepareSeed, fastBoot: true }), { tmuxName: 'kookr-oc8' });
      expect(envOf(fast.id).OPENCODE_FAST_BOOT).toBe('1');
      await launch(adapter, { tmuxName: 'kookr-oc9' });
      expect(prepareSeed).toHaveBeenCalledTimes(2); // memoised per adapter

      const failing = makeAdapter({ seed: true, prepareSeed: async () => undefined });
      const f = await launch(failing, { tmuxName: 'kookr-oc4' });
      expect(envOf(f.id).OPENCODE_FAST_BOOT).toBeUndefined();
      expect(existsSync(join(envOf(f.id).OPENCODE_CONFIG_DIR!, 'node_modules'))).toBe(false);
    });

    test('profile shelves are appended to AGENTS.md; only the profile\'s own shelves are read, with the session NB_DIR', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc-prof-'));
      try {
        writeFileSync(join(dir, 'a.md'), '---\nid: pa\ndescription: d\npermission: allow\ndeliverable: none\nshelves: [shelf-a]\n---\nA instructions.\n');
        const seen: Array<[string, string | undefined]> = [];
        const shelfShow = async (shelf: string, env: NodeJS.ProcessEnv) => { seen.push([shelf, env.NB_DIR]); return shelf === 'shelf-a' ? 'lesson MARK-A' : 'lesson MARK-B'; };
        const { id } = await launch(makeAdapter({ profilesDir: dir, shelfShow }), { profile: 'pa', extraEnv: { NB_DIR: '/tmp/nbx' } });
        const agents = readFileSync(join(envOf(id).OPENCODE_CONFIG_DIR!, 'AGENTS.md'), 'utf-8');
        expect(agents).toContain('A instructions.');
        expect(agents).toContain('## Lessons from your shelves');
        expect(agents).toContain('MARK-A');
        expect(agents).not.toContain('MARK-B');
        expect(seen).toEqual([['shelf-a', '/tmp/nbx']]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('a throwing shelf read never blocks the launch', async () => {
      const { id } = await launch(makeAdapter({ shelfShow: async () => { throw new Error('nb gone'); } }), { profile: 'reviewer' });
      expect(readFileSync(join(envOf(id).OPENCODE_CONFIG_DIR!, 'AGENTS.md'), 'utf-8')).not.toContain('Lessons from your shelves');
    });
  });

  describe('worker profiles', () => {
    const pluginOf = (id: string) =>
      readFileSync(join(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG_DIR!, 'plugins', 'kookr.js'), 'utf-8');
    const agentsOf = (id: string) =>
      readFileSync(join(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG_DIR!, 'AGENTS.md'), 'utf-8');

    test('opts.profile loads instructions and puts the deliverable gate first in the Stop hooks', async () => {
      const adapter = makeAdapter({ serverPort: 4801 });
      const { id } = await launch(adapter, { profile: 'reviewer' });
      expect(agentsOf(id)).toContain('You are a code reviewer');
      const plugin = pluginOf(id);
      expect(plugin).toContain('kookr-opencode-gate.js');
      expect(plugin).toContain('file:REVIEW.md');
      expect(plugin.indexOf('kookr-opencode-gate.js')).toBeLessThan(plugin.indexOf('nb-retro.sh'));
      expect(plugin).toContain('"KOOKR_PORT":"4801"');
      expect(plugin).toContain('"KOOKR_SESSION_DIR"');
    });

    test('falls back to the profile persisted on the task record, and the profile supplies the model', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc-prof-'));
      try {
        writeFileSync(join(dir, 'p.md'), '---\nid: pinned\ndescription: d\npermission: ask\ndeliverable: none\nmodel: deepinfra/x/Pinned\n---\nPinned instructions.\n');
        const adapter = makeAdapter({ profilesDir: dir });
        const task = taskStore.createTask({ prompt: 'do it', cwd: '/workspace', metadata: { opencodeProfile: 'pinned' } });
        const id = await adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1' });
        const env = backend.sessions.get(id)!.spec.env!;
        expect(agentsOf(id)).toBe('Pinned instructions.\n');
        const config = JSON.parse(readFileSync(env.OPENCODE_CONFIG!, 'utf-8'));
        expect(config.model).toBe('deepinfra/x/Pinned');
        expect(config.permission.bash).toBe('ask');
        expect(pluginOf(id)).not.toContain('kookr-opencode-gate.js');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('the task issue (opts or persisted metadata) becomes KOOKR_OPENCODE_ISSUE for the gate, beating operator env', async () => {
      const adapter = makeAdapter({ env: { KOOKR_OPENCODE_ISSUE: '99' } });
      const a = await launch(adapter, { profile: 'scoped-fix', issue: 7 });
      expect(pluginOf(a.id)).toContain('"KOOKR_OPENCODE_ISSUE":"7"');
      expect(pluginOf(a.id)).not.toContain('"KOOKR_OPENCODE_ISSUE":"99"');
      const task = taskStore.createTask({ prompt: 'do it', cwd: '/workspace', metadata: { opencodeProfile: 'scoped-fix', opencodeIssue: 12 } });
      const id = await adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc2' });
      expect(pluginOf(id)).toContain('"KOOKR_OPENCODE_ISSUE":"12"');
    });

    test('an unknown profile fails the launch cleanly', async () => {
      const adapter = makeAdapter();
      const task = taskStore.createTask('do it', '/workspace');
      await expect(adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1', profile: 'nope' }))
        .rejects.toThrow(/Unknown opencode profile "nope"/);
      expect(backend.sessions.has('kookr-oc1')).toBe(false);
    });

    test('without a profile the default hooks (nb-inject, nudge, nb-retro) are wired and no gate', async () => {
      const { id } = await launch(makeAdapter());
      const plugin = pluginOf(id);
      expect(plugin).toContain('nb-inject.sh');
      expect(plugin).toContain('nb-retro.sh');
      expect(plugin).not.toContain('kookr-opencode-gate.js');
      expect(existsSync(join(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG_DIR!, 'AGENTS.md'))).toBe(false);
    });

    test('defaultHooks:false composes no hooks', async () => {
      const { id } = await launch(makeAdapter({ defaultHooks: false }));
      expect(pluginOf(id)).not.toContain('nb-retro.sh');
    });
  });

  describe('usage accounting on stop', () => {
    const FIXTURE_DB = fileURLToPath(new URL('./__fixtures__/opencode-session.db', import.meta.url));
    const stageDb = (id: string) => {
      const dbDir = join(backend.sessions.get(id)!.spec.env!.XDG_DATA_HOME!, 'opencode');
      mkdirSync(dbDir, { recursive: true });
      copyFileSync(FIXTURE_DB, join(dbDir, 'opencode.db'));
    };

    test('records token usage on the task before the session dir is deleted', async () => {
      const adapter = makeAdapter();
      const refreshed = vi.fn();
      adapter.onRefreshNeeded(refreshed);
      const { task, id } = await launch(adapter);
      stageDb(id);
      await adapter.stop(id);
      const usage = taskStore.getTask(task.id)!.tokenUsage!;
      expect(usage).toMatchObject({ inputTokens: 5545, outputTokens: 2, cacheReadTokens: 1792 });
      expect(refreshed).toHaveBeenCalled();
    });

    test('a session without a DB leaves usage unset and still tears down', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      await adapter.stop(id);
      expect(taskStore.getTask(task.id)!.tokenUsage).toBeUndefined();
    });
  });

  test('composes the default provider/model and honors a per-task model pin', async () => {
    const adapter = makeAdapter();
    const { id } = await launch(adapter, { model: 'deepinfra/deepseek-ai/Other-Model' });
    const config = JSON.parse(readFileSync(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG!, 'utf-8'));
    expect(config.model).toBe('deepinfra/deepseek-ai/Other-Model');
    expect(config.provider.deepinfra.options).toEqual({
      baseURL: 'https://api.deepinfra.com/v1/openai',
      apiKey: '{env:OPENAI_API_KEY}',
    });
  });

  test('uses the default model when no pin is given', async () => {
    const adapter = makeAdapter();
    const { id } = await launch(adapter);
    const config = JSON.parse(readFileSync(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG!, 'utf-8'));
    expect(config.model).toBe('deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017');
    expect(config.permission).toEqual({ edit: 'allow', bash: 'allow', external_directory: 'allow' });
  });

  test('a per-call bypassPermissions:false switches the permission posture to ask', async () => {
    const adapter = makeAdapter();
    const { id } = await launch(adapter, { bypassPermissions: false });
    const config = JSON.parse(readFileSync(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG!, 'utf-8'));
    expect(config.permission.bash).toBe('ask');
  });

  test('stop kills the terminal and removes the session dir', async () => {
    const adapter = makeAdapter();
    const { id } = await launch(adapter);
    const configPath = backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG!;
    expect(existsSync(configPath)).toBe(true);
    await adapter.stop(id);
    expect(await backend.isAlive(id)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(adapter.getEffectiveHookSettings(id)).toBeUndefined();
  });

  test('a failed composition cleans up and rethrows without creating a session', async () => {
    const adapter = makeAdapter({ composeSession: async () => { throw new Error('compose boom'); } });
    const task = taskStore.createTask('do it', '/workspace');
    await expect(adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1' }))
      .rejects.toThrow('compose boom');
    expect(backend.sessions.has('kookr-oc1')).toBe(false);
    expect(taskStore.getTask(task.id)!.sessions).toHaveLength(0);
  });

  describe('resume (per-task persistent data)', () => {
    const dataHomeOf = (id: string) => backend.sessions.get(id)!.spec.env!.XDG_DATA_HOME!;
    function stageSessions(dataHome: string, rows: Array<[string, string | null, number]>) {
      mkdirSync(join(dataHome, 'opencode'), { recursive: true });
      const db = new Database(join(dataHome, 'opencode', 'opencode.db'));
      db.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, time_updated integer NOT NULL)');
      for (const r of rows) db.prepare('INSERT INTO session VALUES (?, ?, ?)').run(...r);
      db.close();
    }

    test('XDG_DATA_HOME is the per-task dir, outside the session dir, and survives stop', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      const dataHome = dataHomeOf(id);
      expect(dataHome).toBe(join(sessionRoot, 'opencode-data', task.id, 'data'));
      expect(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG!.startsWith(dataHome)).toBe(false);
      await adapter.stop(id);
      expect(existsSync(dataHome)).toBe(true);
      expect(existsSync(backend.sessions.get(id)!.spec.env!.OPENCODE_CONFIG!)).toBe(false);
    });

    test('stop records the opencode session id on the task metadata', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      stageSessions(dataHomeOf(id), [['ses_abc123', null, 5]]);
      await adapter.stop(id);
      expect(taskStore.getTask(task.id)!.metadata?.opencodeSessionId).toBe('ses_abc123');
    });

    test('resume launches `--session <id> <cwd>` against the same data dir and delivers no prompt', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      stageSessions(dataHomeOf(id), [['ses_abc123', null, 5]]);
      const firstData = dataHomeOf(id);
      await adapter.stop(id);

      const id2 = await adapter.launch(task.id, 'do it', '/workspace', { sessionId: 'kookr-oc1' }, { tmuxName: 'kookr-oc2' });
      const spec = backend.sessions.get(id2)!.spec;
      expect(spec.args).toEqual(['--session', 'ses_abc123', '/workspace']);
      expect(spec.env!.XDG_DATA_HOME).toBe(firstData);
      expect(backend.getWrittenBytes(id2)).toHaveLength(0); // no initial prompt re-delivery
      expect(backend.sessions.get(id2)!.paneContent).not.toContain('do it');
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === id2)!;
      expect(session.promptDelivery).toBeUndefined();
      // The session config is re-composed (plugin + hooks env) for the new session.
      expect(readFileSync(join(spec.env!.OPENCODE_CONFIG_DIR!, 'plugins', 'kookr.js'), 'utf8')).toContain('kookr-oc2');
      expect(readFileSync(join(spec.env!.OPENCODE_CONFIG_DIR!, 'plugins', 'kookr.js'), 'utf8')).toContain(task.id);
    });

    test('a SessionStart that arrives before the session is registered still reaches the session record', async () => {
      const adapter = makeAdapter({ promptReadyTimeoutMs: 200 });
      const task = taskStore.createTask('do it', '/workspace');
      const pending = adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1' });
      await vi.waitFor(() => expect(backend.sessions.has('kookr-oc1')).toBe(true));
      // The plugin emits SessionStart as soon as opencode loads, before launch registers the session.
      adapter.injectHookEvent('kookr-oc1', hook('SessionStart', { source: 'startup' }));
      await pending;
      expect(taskStore.getTask(task.id)!.sessions[0]!.claudeSessionId).toBe('kookr-oc1');
    });

    test('a ses_-prefixed resume id wins over the newest session when it exists', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      stageSessions(dataHomeOf(id), [['ses_older', null, 1], ['ses_newer', null, 9]]);
      await adapter.stop(id);
      const id2 = await adapter.launch(task.id, 'x', '/workspace', { sessionId: 'ses_older' }, { tmuxName: 'kookr-oc2' });
      expect(backend.sessions.get(id2)!.spec.args).toEqual(['--session', 'ses_older', '/workspace']);
    });

    test('resume without a stored session warns and launches fresh with the prompt', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const adapter = makeAdapter();
      const task = taskStore.createTask('do it', '/workspace');
      const id = await adapter.launch(task.id, 'do it', '/workspace', { sessionId: 'kookr-gone' }, { tmuxName: 'kookr-oc1' });
      expect(backend.sessions.get(id)!.spec.args).toEqual(['/workspace']);
      expect(backend.sessions.get(id)!.paneContent).toContain('do it');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('launching fresh'));
      warn.mockRestore();
    });

    test('a fresh launch discards stale data left by an earlier conversation of the same task id', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      const stale = join(dataHomeOf(id), 'stale.txt');
      writeFileSync(stale, 'x');
      await adapter.stop(id);
      await adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc2' });
      expect(existsSync(stale)).toBe(false);
    });

    test('a fresh launch refuses (never deletes) a non-Kookr directory already sitting at the task data path', async () => {
      const adapter = makeAdapter();
      const task = taskStore.createTask('do it', '/workspace');
      const foreign = join(sessionRoot, 'opencode-data', task.id);
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, 'precious.txt'), 'keep me');
      await expect(adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc9' })).rejects.toThrow('not created by Kookr');
      expect(readFileSync(join(foreign, 'precious.txt'), 'utf8')).toBe('keep me');
    });

    test('a resumed launch reuses the first launch gate base even after HEAD moved', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'oc-gate-repo-'));
      try {
        const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e.x', ...a], { encoding: 'utf8', env: gitExecEnv() });
        git('init', '-q', '-b', 'main');
        git('commit', '-q', '--allow-empty', '-m', 'one');
        const base = git('rev-parse', 'HEAD').trim();
        const adapter = makeAdapter();
        const task = taskStore.createTask('do it', repo);
        const id = await adapter.launch(task.id, 'do it', repo, undefined, { tmuxName: 'kookr-oc1' });
        stageSessions(dataHomeOf(id), [['ses_abc123', null, 5]]);
        expect(backend.sessions.get(id)!.spec.env!.KOOKR_OPENCODE_GATE_BASE).toBeUndefined(); // env lives in the plugin
        const pluginOf = (i: string) => readFileSync(join(backend.sessions.get(i)!.spec.env!.OPENCODE_CONFIG_DIR!, 'plugins', 'kookr.js'), 'utf8');
        expect(pluginOf(id)).toContain(base);
        await adapter.stop(id);
        git('commit', '-q', '--allow-empty', '-m', 'two');
        const id2 = await adapter.launch(task.id, 'do it', repo, { sessionId: 'kookr-oc1' }, { tmuxName: 'kookr-oc2' });
        expect(pluginOf(id2)).toContain(base);
        expect(pluginOf(id2)).not.toContain(git('rev-parse', 'HEAD').trim());
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('a failed fresh launch removes its data dir; a failed resume keeps it', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      stageSessions(dataHomeOf(id), [['ses_abc123', null, 5]]);
      await adapter.stop(id);
      const taskDir = join(sessionRoot, 'opencode-data', task.id);
      vi.spyOn(backend, 'createSession').mockRejectedValueOnce(new Error('boom'));
      await expect(adapter.launch(task.id, 'x', '/workspace', { sessionId: 'kookr-oc1' }, { tmuxName: 'kookr-oc2' })).rejects.toThrow('boom');
      expect(existsSync(taskDir)).toBe(true);
      vi.spyOn(backend, 'createSession').mockRejectedValueOnce(new Error('boom2'));
      await expect(adapter.launch(task.id, 'x', '/workspace', undefined, { tmuxName: 'kookr-oc3' })).rejects.toThrow('boom2');
      expect(existsSync(taskDir)).toBe(false);
    });

    test('a timed-out launch whose late cleanup runs after a retry recreated the dir does not remove the retry data', async () => {
      const adapter = makeAdapter();
      const task = taskStore.createTask('do it', '/workspace');
      const taskDir = join(sessionRoot, 'opencode-data', task.id);
      let failLate!: (e: Error) => void;
      vi.spyOn(backend, 'createSession').mockImplementationOnce(
        () => new Promise<void>((_, reject) => { failLate = reject; }),
      );
      // Launch A hangs inside createSession (the timeout race already abandoned it).
      const late = adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc2' });
      late.catch(() => undefined);
      await vi.waitFor(() => expect(failLate).toBeDefined());
      // The retry of the SAME task wipes A's dir, recreates and re-marks it, and writes data.
      const id = await adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc3' });
      const retryData = join(dataHomeOf(id), 'retry-data.txt');
      writeFileSync(retryData, 'keep');
      // A's aborted launch now finishes its failure cleanup.
      failLate(new Error('late boom'));
      await expect(late).rejects.toThrow('late boom');
      expect(existsSync(taskDir)).toBe(true);
      expect(readFileSync(retryData, 'utf8')).toBe('keep');
    });

    test('a crash-recovery fresh launch keeps the ORIGINAL gate base after the worker committed', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'oc-gate-repo-'));
      try {
        const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e.x', ...a], { encoding: 'utf8', env: gitExecEnv() });
        git('init', '-q', '-b', 'main');
        git('commit', '-q', '--allow-empty', '-m', 'one');
        const base = git('rev-parse', 'HEAD').trim();
        const adapter = makeAdapter();
        const task = taskStore.createTask('do it', repo);
        const pluginOf = (i: string) => readFileSync(join(backend.sessions.get(i)!.spec.env!.OPENCODE_CONFIG_DIR!, 'plugins', 'kookr.js'), 'utf8');
        const id = await adapter.launch(task.id, 'do it', repo, undefined, { tmuxName: 'kookr-oc1' });
        await adapter.stop(id);
        git('commit', '-q', '--allow-empty', '-m', 'worker commit');
        const head = git('rev-parse', 'HEAD').trim();
        // Fresh (non-resuming) relaunch of the same task: the base must not move to the worker's commit.
        const id2 = await adapter.launch(task.id, 'do it', repo, undefined, { tmuxName: 'kookr-oc2' });
        expect(pluginOf(id2)).toContain(base);
        expect(pluginOf(id2)).not.toContain(head);
        await adapter.stop(id2);
        // A stored base that no longer exists in the repo is replaced by the current HEAD.
        writeFileSync(join(sessionRoot, 'opencode-data', task.id, 'gate-base'), `${'e'.repeat(40)}\n`);
        const id3 = await adapter.launch(task.id, 'do it', repo, undefined, { tmuxName: 'kookr-oc3' });
        expect(pluginOf(id3)).toContain(head);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('resume with an unreadable session DB fails clearly, keeps the data and does not launch fresh', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      const dataHome = dataHomeOf(id);
      await adapter.stop(id);
      mkdirSync(join(dataHome, 'opencode'), { recursive: true });
      writeFileSync(join(dataHome, 'opencode', 'opencode.db'), 'not sqlite');
      writeFileSync(join(dataHome, 'conversation-marker.txt'), 'keep');
      await expect(adapter.launch(task.id, 'x', '/workspace', { sessionId: 'kookr-oc1' }, { tmuxName: 'kookr-oc2' }))
        .rejects.toBeInstanceOf(OpenCodeSessionUnreadableError);
      expect(backend.sessions.has('kookr-oc2')).toBe(false);
      expect(readFileSync(join(dataHome, 'conversation-marker.txt'), 'utf8')).toBe('keep');
      expect((adapter as any).tmuxToTaskId.size).toBe(0);
    });

    test('an already-aborted launch throws LaunchAbortedError and leaks no session bookkeeping', async () => {
      const adapter = makeAdapter();
      const task = taskStore.createTask('do it', '/workspace');
      const ac = new AbortController();
      ac.abort();
      await expect(adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1', signal: ac.signal }))
        .rejects.toBeInstanceOf(LaunchAbortedError);
      const a = adapter as any;
      expect(a.tmuxToTaskId.size).toBe(0);
      expect(a.sessionDirs.size).toBe(0);
      expect(a.dataHomes.size).toBe(0);
      expect(backend.sessions.has('kookr-oc1')).toBe(false);
    });

    test('an abort that lands after the session dir was composed cleans up the dir, data home and bookkeeping', async () => {
      const ac = new AbortController();
      const adapter = makeAdapter({ composeSession: async (o) => { ac.abort(); return composeOpenCodeSession(o); } });
      const task = taskStore.createTask('do it', '/workspace');
      await expect(adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1', signal: ac.signal }))
        .rejects.toBeInstanceOf(LaunchAbortedError);
      const a = adapter as any;
      expect(a.tmuxToTaskId.size).toBe(0);
      expect(a.sessionDirs.size).toBe(0);
      expect(a.dataHomes.size).toBe(0);
      expect(existsSync(join(sessionRoot, 'opencode-data', task.id))).toBe(false); // fresh launch: its data dir goes too
      expect(backend.sessions.has('kookr-oc1')).toBe(false);
    });

    test('stop sweeps the data of a completed task but keeps a terminated task resumable', async () => {
      const adapter = makeAdapter();
      const a = await launch(adapter);
      const dirA = join(sessionRoot, 'opencode-data', a.task.id);
      taskStore.completeTask(a.task.id);
      await adapter.stop(a.id);
      expect(existsSync(dirA)).toBe(false);

      const t2 = taskStore.createTask('two', '/workspace');
      const id2 = await adapter.launch(t2.id, 'two', '/workspace', undefined, { tmuxName: 'kookr-oc9' });
      const dir2 = join(sessionRoot, 'opencode-data', t2.id);
      taskStore.terminateTask(t2.id, { reason: 'unknown' } as never);
      await adapter.stop(id2);
      expect(existsSync(dir2)).toBe(true);
    });
  });

  describe('initial prompt delivery (bracketed paste)', () => {
    test('is confirmed by the UserPromptSubmit hook', async () => {
      const adapter = makeAdapter({ promptBracketedPaste: true, promptSubmitConfirmTimeoutMs: 2000 });
      const task = taskStore.createTask('do it', '/workspace');
      const pending = adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1' });
      await vi.waitFor(() => expect(backend.sessions.has('kookr-oc1')).toBe(true));
      await vi.waitFor(() => expect(backend.sessions.get('kookr-oc1')!.paneContent).toContain('do it'));
      adapter.injectHookEvent('kookr-oc1', hook('UserPromptSubmit', { prompt: 'do it' }));
      await pending;
      expect(taskStore.getTask(task.id)!.sessions[0]!.promptDelivery?.status).toBe('confirmed');
    });

    test('fails closed (and kills the session) when unacknowledged and the pane is idle', async () => {
      const adapter = makeAdapter({ promptBracketedPaste: true });
      const task = taskStore.createTask('do it', '/workspace');
      await expect(adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1' }))
        .rejects.toThrow(/did not acknowledge the initial prompt/);
      expect(await backend.isAlive('kookr-oc1')).toBe(false);
      expect(taskStore.getTask(task.id)!.sessions).toHaveLength(0);
    });

    test('assumes submission when the pane shows a running turn without the hook', async () => {
      const adapter = makeAdapter({ promptBracketedPaste: true });
      const task = taskStore.createTask('do it', '/workspace');
      const pending = adapter.launch(task.id, 'do it', '/workspace', undefined, { tmuxName: 'kookr-oc1' });
      await vi.waitFor(() => expect(backend.sessions.has('kookr-oc1')).toBe(true));
      backend.sessions.get('kookr-oc1')!.paneContent += '\nworking  esc interrupt';
      await pending;
      expect(taskStore.getTask(task.id)!.sessions[0]!.promptDelivery?.status).toBe('assumed-submitted');
    });
  });

  describe('injectHookEvent', () => {
    test('normalises Claude-shaped payloads, dispatches events, and records the parent session', async () => {
      const adapter = makeAdapter();
      const { task, id } = await launch(adapter);
      const events: AgentEvent[] = [];
      adapter.onEvent((_name, event) => events.push(event));

      const start = adapter.injectHookEvent(id, hook('SessionStart', { source: 'startup' }));
      const tool = adapter.injectHookEvent(id, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
      expect(start).toMatchObject({ parseStatus: 'ok', agentType: 'opencode', parentage: 'parent', sequence: 1 });
      expect(tool).toMatchObject({ parseStatus: 'ok', sequence: 2 });
      expect(events.map((e) => e.type)).toEqual(['session_start', 'tool_use']);
      expect(taskStore.getTask(task.id)!.sessions[0]!.claudeSessionId).toBe('kookr-oc1');
    });

    test('never throws on malformed or unknown payloads', async () => {
      const adapter = makeAdapter();
      const { id } = await launch(adapter);
      expect(adapter.injectHookEvent(id, '{not json').parseStatus).toBe('malformed');
      expect(adapter.injectHookEvent(id, hook('SomethingUnknown')).parseStatus).toBe('dropped');
    });
  });

  describe('preflight', () => {
    const exec = (out: string): ProbeExecRunner => async () => ({ stdout: out, stderr: '' });

    test('is ok on the pinned version and memoized', async () => {
      const spy = vi.fn(exec('1.19.5\n'));
      const adapter = makeAdapter({ probeExec: spy });
      expect(await adapter.preflight()).toMatchObject({ kind: 'ok', version: '1.19.5', resolvedPath: '/opt/opencode' });
      await adapter.preflight();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('is absent on another version', async () => {
      const adapter = makeAdapter({ probeExec: exec('2.2.0\n') });
      expect(await adapter.preflight()).toMatchObject({ kind: 'absent', envVarName: 'KOOKR_OPENCODE_BIN' });
    });
  });
});
