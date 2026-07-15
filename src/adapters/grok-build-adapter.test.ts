import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { GrokBuildAdapter, GrokLaunchRefusedError } from './grok-build-adapter.js';
import type { GrokInstalledState } from './grok-build-preflight.js';
import { GROK_BUILD_KILL_SWITCH_ENV } from './grok-launch-args.js';
import { TaskStore } from '../core/tasks.js';

vi.mock('./git-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-info.js')>();
  return { ...actual, getGitInfo: vi.fn().mockResolvedValue(null) };
});
import { getGitInfo } from './git-info.js';
const mockGetGitInfo = vi.mocked(getGitInfo);

const CANONICAL = '/fake/.grok/bin/grok-0.2.93';

function testedState(): GrokInstalledState {
  return {
    kind: 'ok',
    version: '0.2.93',
    buildId: 'f00f96316d',
    identity: {
      configured: 'grok',
      launcherPath: '/fake/.grok/bin/grok',
      canonicalPath: CANONICAL,
      sha256: '4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135',
      sizeBytes: 159465672,
      mode: 0o755,
      uid: 1000,
      gid: 1000,
    },
    qualification: { status: 'tested', reason: 'matches tested build', evidenceBuildId: '0.2.93 (f00f96316d)' },
  };
}

describe('GrokBuildAdapter', () => {
  let backend: FakeTerminalBackend;
  let taskStore: TaskStore;
  let sessionHomeRoot: string;

  const baseEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    TERM: 'xterm-256color',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    GITHUB_TOKEN: 'ghp_should_not_leak',
  } as NodeJS.ProcessEnv;

  function makeAdapter(overrides: Partial<{ env: NodeJS.ProcessEnv; state: GrokInstalledState }> = {}) {
    return new GrokBuildAdapter(backend, taskStore, {
      env: overrides.env ?? { ...baseEnv },
      installedStateOverride: overrides.state ?? testedState(),
      sourceGrokHome: join(sessionHomeRoot, 'no-such-home'),
      sessionHomeRoot,
      promptBracketedPaste: false,
      promptReadyTimeoutMs: 30,
    });
  }

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    sessionHomeRoot = mkdtempSync(join(tmpdir(), 'grok-adapter-test-'));
    mockGetGitInfo.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    rmSync(sessionHomeRoot, { recursive: true, force: true });
  });

  test('launch execs the exact canonical path with the POC-verified argv', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('do it', '/workspace');
    const sessionId = await adapter.launch(task.id, 'do it', '/workspace');

    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.command).toBe(CANONICAL); // exact resolved path, not the launcher symlink
    expect(spec.args).toEqual(['--no-alt-screen', '--model', 'grok-4.5']);
    expect(spec.envMode).toBe('replace');
  });

  test('launch env is allowlisted: GROK_HOME set, server secrets excluded', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('do it', '/workspace');
    const sessionId = await adapter.launch(task.id, 'do it', '/workspace');
    const env = backend.sessions.get(sessionId)!.spec.env!;

    expect(env.GROK_HOME).toContain('.grok');
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(env.KOOKR_TASK_ID).toBe(task.id);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('the initial prompt is delivered over the terminal, never on argv', async () => {
    const adapter = makeAdapter();
    const big = 'y'.repeat(50_000);
    const task = taskStore.createTask(big, '/workspace');
    const sessionId = await adapter.launch(task.id, big, '/workspace');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args.some((a) => a.includes(big))).toBe(false);
    expect(backend.sessions.get(sessionId)!.keysReceived.join('')).toContain('y');
  });

  test('launch is allowed by default (GA — no opt-in flag)', async () => {
    const adapter = makeAdapter({ env: { ...baseEnv } });
    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace');
    expect(backend.sessions.has(sessionId)).toBe(true);
  });

  test('launch is refused when the kill switch is set', async () => {
    const adapter = makeAdapter({
      env: { ...baseEnv, [GROK_BUILD_KILL_SWITCH_ENV]: 'true' },
    });
    const task = taskStore.createTask('x', '/workspace');
    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(/kill switch/);
  });

  test('launch proceeds on an unqualified (unknown) build with an advisory warning', async () => {
    const state = testedState();
    state.qualification = { status: 'unknown', reason: 'installed binary does not match the tested build' };
    const adapter = makeAdapter({ state });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace');
    expect(backend.sessions.has(sessionId)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unqualified Grok build'));
    warn.mockRestore();
  });

  test('resume request is ignored (Phase-1 policy: disabled) and launches fresh', async () => {
    const adapter = makeAdapter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace', { sessionId: 'prior-uuid' });
    expect(backend.sessions.has(sessionId)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring resume'));
    warn.mockRestore();
  });

  test('stop kills the session and removes the composed GROK_HOME', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace');
    const home = backend.sessions.get(sessionId)!.spec.env!.GROK_HOME!;
    const sessionRoot = join(home, '..');
    expect(existsSync(sessionRoot)).toBe(true);
    await adapter.stop(sessionId);
    expect(backend.sessions.get(sessionId)!.alive).toBe(false);
    expect(existsSync(sessionRoot)).toBe(false);
  });

  test('aborts (refuses) rather than typing into an auth/update startup screen, and cleans up', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('x', '/workspace');
    // Drive the ready-state probe with an auth screen: the DECSET never arrives
    // and the display matches a blocking marker, so waitForReadyOrAbort aborts.
    const authScreen = new TextEncoder().encode('API error: access to the chat endpoint is denied. Log into console.x.ai.');
    vi.spyOn(backend, 'captureBytes').mockResolvedValue(authScreen);
    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(/console\.x\.ai|startup screen/);
    // The composed GROK_HOME is removed on abort (no orphaned session dirs).
    expect(readdirSync(sessionHomeRoot)).toHaveLength(0);
  });

  test('re-resolves installed identity on launch (TOCTOU), not a memoized preflight result', async () => {
    let calls = 0;
    const probeExec = async () => {
      calls += 1;
      const e = new Error('binary vanished') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    };
    const adapter = new GrokBuildAdapter(backend, taskStore, {
      env: { ...baseEnv },
      probeExec, // real resolveInstalledState path (no installedStateOverride)
      sourceGrokHome: join(sessionHomeRoot, 'no-such-home'),
      sessionHomeRoot,
      promptBracketedPaste: false,
      promptReadyTimeoutMs: 30,
    });
    const pf = await adapter.preflight();
    expect(pf.kind).toBe('absent');
    expect(calls).toBe(1);
    const task = taskStore.createTask('x', '/workspace');
    // A PATH swap / auto-update between preflight and launch must be caught:
    // launch re-probes (force) rather than trusting the memoized preflight.
    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toBeInstanceOf(GrokLaunchRefusedError);
    expect(calls).toBe(2);
  });

  test('supervisionStatus reports supported for a tested build', async () => {
    const adapter = makeAdapter();
    const status = await adapter.supervisionStatus();
    expect(status.status).toBe('supported');
    expect(status.evidenceBuildId).toBe('0.2.93 (f00f96316d)');
  });

  test('supervisionStatus reports unsupported when the kill switch is set', async () => {
    const adapter = makeAdapter({ env: { ...baseEnv, [GROK_BUILD_KILL_SWITCH_ENV]: 'true' } });
    const status = await adapter.supervisionStatus();
    expect(status.status).toBe('unsupported');
  });

  test('getEffectiveHookSettings exposes the PascalCase monitoring config', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace');
    const settings = adapter.getEffectiveHookSettings(sessionId);
    expect(settings?.agentType).toBe('grok-build');
    const hooks = (settings?.content as { hooks: Record<string, unknown> }).hooks;
    expect(Object.keys(hooks)).toContain('PreToolUse');
    expect(Object.keys(hooks)).toContain('SubagentStart');
  });

  describe('injectHookEvent', () => {
    async function launched() {
      const adapter = makeAdapter();
      const task = taskStore.createTask('x', '/workspace');
      const sessionId = await adapter.launch(task.id, 'x', '/workspace');
      return { adapter, sessionId, taskId: task.id };
    }

    test('normalizes a camelCase Grok payload and classifies the parent', async () => {
      const { adapter, sessionId } = await launched();
      const events: string[] = [];
      adapter.onEvent((_id, e) => events.push(e.type));
      const start = adapter.injectHookEvent(
        sessionId,
        JSON.stringify({ hookEventName: 'session_start', sessionId: 'S1', cwd: '/workspace' }),
      );
      expect(start.parseStatus).toBe('ok');
      expect(start.parentage).toBe('parent');
      const pre = adapter.injectHookEvent(
        sessionId,
        JSON.stringify({ hookEventName: 'pre_tool_use', sessionId: 'S1', toolName: 'run_terminal_command', toolInput: { command: 'echo hi' } }),
      );
      expect(pre.parseStatus).toBe('ok');
      expect(events).toEqual(['session_start', 'tool_use']);
    });

    test('classifies a subagent (distinct sessionId) as child', async () => {
      const { adapter, sessionId } = await launched();
      adapter.injectHookEvent(sessionId, JSON.stringify({ hookEventName: 'session_start', sessionId: 'PARENT', cwd: '/workspace' }));
      const sub = adapter.injectHookEvent(
        sessionId,
        JSON.stringify({ hookEventName: 'subagent_start', sessionId: 'CHILD', subagentId: 'CHILD', subagentType: 'general-purpose' }),
      );
      expect(sub.parentage).toBe('child');
    });

    test('returns malformed (never throws) on invalid JSON', async () => {
      const { adapter, sessionId } = await launched();
      const r = adapter.injectHookEvent(sessionId, '{not json');
      expect(r.parseStatus).toBe('malformed');
    });

    test('drops a forged/unknown event cleanly', async () => {
      const { adapter, sessionId } = await launched();
      const r = adapter.injectHookEvent(sessionId, JSON.stringify({ hookEventName: 'made_up', sessionId: 'X' }));
      expect(r.parseStatus).toBe('dropped');
    });

    test('does not decode Claude snake_case payloads', async () => {
      const { adapter, sessionId } = await launched();
      const r = adapter.injectHookEvent(sessionId, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'X', tool_name: 'Bash' }));
      expect(r.parseStatus).toBe('dropped');
    });
  });

  test('sendInput clears the line, pastes, and submits', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace');
    await adapter.sendInput(sessionId, 'hello grok');
    expect(backend.sessions.get(sessionId)!.keysReceived.join('\n')).toContain('hello grok');
  });
});
