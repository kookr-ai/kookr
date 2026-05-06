import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { ClaudeCodeAdapter, resolvePluginDir } from './claude-code-adapter.js';
import { TaskStore } from '../core/tasks.js';
import type { AgentEvent } from '../core/types.js';

// Mock getGitInfo so we can control whether it returns data
vi.mock('./git-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-info.js')>();
  return {
    ...actual,
    getGitInfo: vi.fn().mockResolvedValue(null),
  };
});

// Import after mock setup so we can control the mock
import { getGitInfo } from './git-info.js';
const mockGetGitInfo = vi.mocked(getGitInfo);

describe('ClaudeCodeAdapter', () => {
  let backend: FakeTerminalBackend;
  let taskStore: TaskStore;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    adapter = new ClaudeCodeAdapter(backend, taskStore);
    mockGetGitInfo.mockReset().mockResolvedValue(null);
  });

  test('launch creates a session with correct SessionSpec', async () => {
    const task = taskStore.createTask('Fix auth bug', '/home/user/project');
    const sessionId = await adapter.launch(task.id, 'Fix auth bug', '/home/user/project');

    expect(sessionId).toMatch(/^kookr-/);
    expect(backend.sessions.has(sessionId)).toBe(true);

    const spec = backend.sessions.get(sessionId)!.spec;
    // V8: env is a structured record on SessionSpec, not concatenated into a shell string.
    expect(spec.env?.KOOKR_TASK_ID).toBe(task.id);
    // V8: binary is the first positional of SessionSpec; defaults to 'claude'.
    expect(spec.command).toBe('claude');
    // V8: flags live on argv.
    expect(spec.args).toContain('--settings');
  });

  test('launch does NOT include --dangerously-skip-permissions or --setting-sources by default', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
    expect(spec.args).not.toContain('--setting-sources');
  });

  test('launch includes --dangerously-skip-permissions when bypassAllPermissions is true', async () => {
    const bypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: true,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).toContain('--dangerously-skip-permissions');
    // The flag must appear before --settings in argv so Claude parses it as a CLI option.
    const bypassIdx = spec.args.indexOf('--dangerously-skip-permissions');
    const settingsIdx = spec.args.indexOf('--settings');
    expect(bypassIdx).toBeGreaterThanOrEqual(0);
    expect(settingsIdx).toBeGreaterThan(bypassIdx);
  });

  // Issue #60: --dangerously-skip-permissions only sets the permission mode (rule #4).
  // Without --setting-sources "" the user's permissions.ask rules in ~/.claude/settings.json
  // load and fire at rule #2, before bypass mode is ever consulted. The pair is required.
  test('launch includes --setting-sources "" when bypassAllPermissions is true', async () => {
    const bypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: true,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    const sourcesIdx = spec.args.indexOf('--setting-sources');
    expect(sourcesIdx).toBeGreaterThanOrEqual(0);
    expect(spec.args[sourcesIdx + 1]).toBe('');
    // Must appear before --settings so the per-task CLI settings still loads.
    const settingsIdx = spec.args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(sourcesIdx);
  });

  test('generated settings file path is included in the launch argv', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const spec = backend.sessions.get(sessionId)!.spec;
    // Argv should contain --settings followed by a path ending in .json
    const settingsIdx = spec.args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const settingsPath = spec.args[settingsIdx + 1];
    expect(settingsPath).toMatch(/\.json$/);
    // Settings path should include the session id for uniqueness
    expect(settingsPath).toContain(sessionId);
  });

  test('launch generates settings with correct hook definitions', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    // The adapter should have generated a settings structure
    const settings = adapter.getGeneratedSettings(sessionId);
    expect(settings).toBeDefined();
    expect(settings!.hooks).toBeDefined();
    expect(settings!.permissions?.allow).toContain('Bash(git *)');

    // All hook types must have at least one matcher with a non-empty command
    const expectedHookTypes = [
      'SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest',
      // New hooks from PoC 002 + PoC 003
      'StopFailure', 'Notification', 'UserPromptSubmit', 'SessionEnd',
      'PostToolUseFailure', 'SubagentStart', 'SubagentStop',
    ];
    for (const hookType of expectedHookTypes) {
      const matchers = settings!.hooks[hookType];
      expect(matchers, `${hookType} should have matchers`).toBeDefined();
      expect(matchers.length, `${hookType} should have at least one matcher`).toBeGreaterThan(0);
      expect(matchers[0].hooks.length, `${hookType} matcher should have at least one hook`).toBeGreaterThan(0);
      // The hook command should contain meaningful content — either the JSONL
      // file path pattern (cat >> path) or a curl-based HTTP push
      expect(matchers[0].hooks[0].command, `${hookType} hook command should reference the session JSONL path`).toContain(sessionId);
    }

    // Tool-name hooks use '*' matcher, non-tool hooks use '' matcher
    expect(settings!.hooks.SessionStart[0].matcher).toBe('*');
    expect(settings!.hooks.PreToolUse[0].matcher).toBe('*');
    expect(settings!.hooks.PostToolUseFailure[0].matcher).toBe('*');
    expect(settings!.hooks.Stop[0].matcher).toBe('');
    expect(settings!.hooks.StopFailure[0].matcher).toBe('');
    expect(settings!.hooks.Notification[0].matcher).toBe('');
    expect(settings!.hooks.UserPromptSubmit[0].matcher).toBe('');
    expect(settings!.hooks.SubagentStart[0].matcher).toBe('');
    expect(settings!.hooks.SubagentStop[0].matcher).toBe('');
    expect(settings!.hooks.SessionEnd[0].matcher).toBe('');
  });

  test('getEffectiveHookSettings returns content, agentType, and settingsPath for a known session', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const effective = adapter.getEffectiveHookSettings(sessionId);
    expect(effective).toBeDefined();
    expect(effective!.agentType).toBe('claude-code');
    expect(effective!.settingsPath).toMatch(/\.json$/);
    expect(effective!.settingsPath).toContain(sessionId);
    expect(effective!.content).toBe(adapter.getGeneratedSettings(sessionId));
  });

  test('getEffectiveHookSettings falls back to persisted settings after adapter restart', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'claude-code-settings-'));
    try {
      const settingsDir = join(tempRoot, 'settings');
      mkdirSync(settingsDir, { recursive: true });
      const sessionId = 'kookr-restart1';
      const content = {
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }],
        },
      };
      writeFileSync(join(settingsDir, `${sessionId}.json`), JSON.stringify(content), 'utf-8');

      const restartedAdapter = new ClaudeCodeAdapter(backend, taskStore, { settingsDir });
      const effective = restartedAdapter.getEffectiveHookSettings(sessionId);

      expect(effective).toEqual({
        content,
        agentType: 'claude-code',
        settingsPath: join(settingsDir, `${sessionId}.json`),
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('getEffectiveHookSettings returns undefined for unknown session id', () => {
    expect(adapter.getEffectiveHookSettings('not-a-real-session')).toBeUndefined();
    expect(adapter.getEffectiveHookSettings('../../etc/passwd')).toBeUndefined();
  });

  test('hook events emitted as AgentEvents on event handler', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const events: AgentEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));

    // Simulate receiving a hook event
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'sess-uuid-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'claude-sonnet-4-20250514',
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_start');
    if (events[0].type === 'session_start') {
      expect(events[0].sessionId).toBe('sess-uuid-1');
      expect(events[0].transcriptPath).toBe('/path/to/transcript.jsonl');
    }
  });

  test('onEvent handler receives session id for routing', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const received: Array<{ id: string; type: string }> = [];
    adapter.onEvent((id, event) => received.push({ id, type: event.type }));

    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'sess-uuid-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    }));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(sessionId);
    expect(received[0].type).toBe('session_start');
  });

  test('SessionStart event updates session metadata', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'sess-uuid-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'claude-sonnet-4-20250514',
    }));

    const updatedTask = taskStore.getTask(task.id)!;
    const session = updatedTask.sessions.find((s) => s.tmuxSession === sessionId);
    expect(session).toBeDefined();
    expect(session!.claudeSessionId).toBe('sess-uuid-1');
    expect(session!.transcriptPath).toBe('/path/to/transcript.jsonl');
  });

  test('sendInput writes text + Enter to backend', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await adapter.sendInput(sessionId, 'yes, continue');

    // V8: sendInput calls backend.writeSequence([text_bytes, ENTER_BYTES]).
    // FakeTerminalBackend concatenates written payloads; decoded, that's text + '\r'.
    expect(backend.getWrittenText(sessionId)).toBe('yes, continue\r');
  });

  test('stop terminates the backend session', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await adapter.stop(sessionId);

    expect(await backend.isAlive(sessionId)).toBe(false);
  });

  test('captureDisplay decodes bytes from backend.captureBytes', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    backend.setCaptureContent(sessionId, 'expected display output');
    const output = await adapter.captureDisplay(sessionId);
    expect(output).toBe('expected display output');
  });

  test('launch with writeFile writes settings file to disk', async () => {
    const written: Array<{ path: string; content: string }> = [];
    const adapterWithWrite = new ClaudeCodeAdapter(backend, taskStore, {
      writeFile: async (path, content) => {
        written.push({ path, content });
      },
    });

    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapterWithWrite.launch(task.id, 'Fix bug', '/cwd');

    expect(written).toHaveLength(1);
    expect(written[0].path).toContain('.json');
    const settings = JSON.parse(written[0].content);
    // All 12 hook event types must be subscribed.
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'UserPromptSubmit',
    ].sort());
    const sessionStartCommand = settings.hooks.SessionStart[0].hooks[0].command;
    expect(sessionStartCommand).toContain(`${sessionId}.jsonl`);
  });

  test('injectHookEvent without matching taskId skips metadata update', () => {
    const events: AgentEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));

    // Inject event for unknown session id — no taskId mapped
    adapter.injectHookEvent('unknown-session', JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    }));

    // Event should still be emitted
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_start');
  });

  test('git info fires onRefreshNeeded, not input_received event', async () => {
    mockGetGitInfo.mockResolvedValue({
      branch: 'main',
      commit: 'abc123',
      isWorktree: false,
      isDetached: false,
    });

    const events: AgentEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));

    const refreshCalls: number[] = [];
    adapter.onRefreshNeeded(() => refreshCalls.push(1));

    const task = taskStore.createTask('Fix bug', '/cwd');
    await adapter.launch(task.id, 'Fix bug', '/cwd');

    // Wait for the fire-and-forget git info promise to resolve
    await vi.waitFor(() => {
      expect(refreshCalls.length).toBe(1);
    });

    // No input_received events should have been emitted
    const inputEvents = events.filter((e) => e.type === 'input_received');
    expect(inputEvents).toHaveLength(0);
  });

  test('hook command must not background the pipeline (& causes stdin loss in Claude Code)', async () => {
    // Claude Code runs hooks via a mechanism that redirects stdin from /dev/null
    // when the command is backgrounded with &. This is NOT reproducible with
    // Node's spawnSync (which doesn't lose pipeline stdin with &), so we verify
    // the invariant structurally: the command must never end with &.
    //
    // For a full integration test that catches this with real Claude Code, see
    // e2e/hook-delivery.spec.ts.
    const adapterWithPort = new ClaudeCodeAdapter(backend, taskStore, {
      serverPort: 4800,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapterWithPort.launch(task.id, 'Fix bug', '/cwd');

    const settings = adapterWithPort.getGeneratedSettings(sessionId);
    expect(settings).toBeDefined();
    expect(settings!.permissions?.allow).toContain('Bash(curl *KOOKR_API_BASE_URL*api/tasks*)');
    expect(settings!.permissions?.allow).toContain('Bash(curl *http://127.0.0.1:4800/api/tasks*)');

    // Check ALL hook event types — none should have a trailing &
    for (const [eventType, matchers] of Object.entries(settings!.hooks)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          expect(hook.command, `${eventType} hook command must not end with &`).not.toMatch(/&\s*$/);
        }
      }
    }
  });

  test('agentBin option overrides the binary in the launch spec', async () => {
    const customAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      agentBin: '/home/user/codex-fork/target/release/codex',
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await customAdapter.launch(task.id, 'Fix bug', '/cwd');

    const spec = backend.sessions.get(sessionId)!.spec;
    // V8: binary lives on SessionSpec.command, no longer embedded in a shell string.
    expect(spec.command).toBe('/home/user/codex-fork/target/release/codex');
    expect(spec.command).not.toBe('claude');
  });

  test('git info failure does not fire refresh or events', async () => {
    mockGetGitInfo.mockResolvedValue(null);

    const events: AgentEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));

    const refreshCalls: number[] = [];
    adapter.onRefreshNeeded(() => refreshCalls.push(1));

    const task = taskStore.createTask('Fix bug', '/cwd');
    await adapter.launch(task.id, 'Fix bug', '/cwd');

    // Wait for the fire-and-forget git info promise to resolve
    await vi.waitFor(() => {
      expect(mockGetGitInfo).toHaveBeenCalled();
    });

    expect(refreshCalls).toHaveLength(0);
    const inputEvents = events.filter((e) => e.type === 'input_received');
    expect(inputEvents).toHaveLength(0);
  });

  describe('--plugin-dir injection', () => {
    let validPluginDir: string;
    let tempRoot: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(tmpdir(), 'kookr-plugin-test-'));
      validPluginDir = join(tempRoot, 'plugin');
      mkdirSync(join(validPluginDir, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(validPluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'test-plugin', version: '0.0.1' }),
      );
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    test('injects --plugin-dir when explicit option points to a valid plugin tree', async () => {
      const a = new ClaudeCodeAdapter(backend, taskStore, { pluginDir: validPluginDir });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 't', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      const idx = spec.args.indexOf('--plugin-dir');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(spec.args[idx + 1]).toBe(validPluginDir);
      // Must appear before --settings/prompt
      expect(spec.args.indexOf('--settings')).toBeGreaterThan(idx);
    });

    test('skips injection when explicit pluginDir path is invalid (no plugin.json)', async () => {
      const bogus = join(tempRoot, 'does-not-exist');
      const a = new ClaudeCodeAdapter(backend, taskStore, { pluginDir: bogus });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 't', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.args).not.toContain('--plugin-dir');
    });

    test('skips injection when pluginDir is explicitly empty string', async () => {
      const a = new ClaudeCodeAdapter(backend, taskStore, { pluginDir: '' });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 't', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.args).not.toContain('--plugin-dir');
    });

    test('resolvePluginDir prefers explicit option over env', () => {
      const env = { KOOKR_PLUGIN_DIR: '/env/path' } as NodeJS.ProcessEnv;
      // Explicit valid path wins
      expect(resolvePluginDir(validPluginDir, env)).toBe(validPluginDir);
      // Explicit empty string wins (= disable)
      expect(resolvePluginDir('', env)).toBeUndefined();
    });

    test('resolvePluginDir uses KOOKR_PLUGIN_DIR when no explicit option', () => {
      const env = { KOOKR_PLUGIN_DIR: validPluginDir } as NodeJS.ProcessEnv;
      expect(resolvePluginDir(undefined, env)).toBe(validPluginDir);
      // Invalid env path → undefined (skip injection rather than pass bad path)
      const envBogus = { KOOKR_PLUGIN_DIR: '/no/such/path' } as NodeJS.ProcessEnv;
      expect(resolvePluginDir(undefined, envBogus)).toBeUndefined();
    });

    test('resolvePluginDir auto-resolves from baseDir when no option and no env', () => {
      // Place adapter file at <root>/dist/adapters/<x>.js so ../../plugin = <root>/plugin
      const fakeAdapterDir = join(tempRoot, 'dist', 'adapters');
      mkdirSync(fakeAdapterDir, { recursive: true });
      const resolved = resolvePluginDir(undefined, {} as NodeJS.ProcessEnv, fakeAdapterDir);
      expect(resolved).toBe(validPluginDir);
    });

    test('resolvePluginDir returns undefined when auto-resolution targets a missing tree', () => {
      const isolated = mkdtempSync(join(tmpdir(), 'kookr-plugin-isolated-'));
      const fakeAdapterDir = join(isolated, 'dist', 'adapters');
      mkdirSync(fakeAdapterDir, { recursive: true });
      try {
        expect(resolvePluginDir(undefined, {} as NodeJS.ProcessEnv, fakeAdapterDir)).toBeUndefined();
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    });
  });
});
