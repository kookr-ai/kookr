import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode-adapter.js';
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
      promptBracketedPaste: false,
      promptReadyTimeoutMs: 20,
      promptSubmitConfirmTimeoutMs: 40,
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
