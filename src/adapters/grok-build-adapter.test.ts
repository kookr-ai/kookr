import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import {
  GrokBuildAdapter,
  GrokLaunchRefusedError,
  GrokAgentBootTimeoutError,
  GROK_STOP_LAST_MESSAGE_MAX_CHARS,
  GROK_INITIAL_PROMPT_ACK_MARKER,
  AGENT_BOOT_TIMEOUT_MARGIN_MS,
  computeDefaultAgentBootTimeoutMs,
} from './grok-build-adapter.js';
import type { AgentEvent } from '../core/agent-events.js';
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
  let sourceGrokHome: string;

  const baseEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    TERM: 'xterm-256color',
    GROK_CLAUDE_HOOKS_ENABLED: '1',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    GITHUB_TOKEN: 'ghp_should_not_leak',
  } as NodeJS.ProcessEnv;

  function makeAdapter(overrides: Partial<{ env: NodeJS.ProcessEnv; state: GrokInstalledState }> = {}) {
    return new GrokBuildAdapter(backend, taskStore, {
      env: overrides.env ?? { ...baseEnv },
      installedStateOverride: overrides.state ?? testedState(),
      sourceGrokHome,
      sessionHomeRoot,
      promptBracketedPaste: false,
      promptReadyTimeoutMs: 30,
    });
  }

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    sessionHomeRoot = mkdtempSync(join(tmpdir(), 'grok-adapter-test-'));
    sourceGrokHome = mkdtempSync(join(tmpdir(), 'grok-source-test-'));
    writeFileSync(
      join(sourceGrokHome, 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
          key: 'test-access-token',
          auth_mode: 'oidc',
          create_time: '2026-07-01T00:00:00Z',
          user_id: 'test-user',
          expires_at: '2030-01-01T00:00:00Z',
          refresh_token: 'test-refresh-token',
        },
      }),
    );
    mockGetGitInfo.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    rmSync(sessionHomeRoot, { recursive: true, force: true });
    rmSync(sourceGrokHome, { recursive: true, force: true });
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

  test('launch env is allowlisted: GROK_HOME set, shared GROK_AUTH_PATH, server secrets excluded', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('do it', '/workspace');
    const sessionId = await adapter.launch(task.id, 'do it', '/workspace');
    const env = backend.sessions.get(sessionId)!.spec.env!;

    expect(env.GROK_HOME).toContain('.grok');
    expect(env.GROK_AUTH_PATH).toBe(join(sourceGrokHome, 'auth.json'));
    // Session home must not hold a private auth.json clone (OIDC RT race).
    expect(existsSync(join(env.GROK_HOME, 'auth.json'))).toBe(false);
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(env.GROK_CLAUDE_HOOKS_ENABLED).toBe('1');
    expect(env.KOOKR_TASK_ID).toBe(task.id);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
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

  test('refuses before session creation when the source auth file is missing', async () => {
    rmSync(join(sourceGrokHome, 'auth.json'));
    const adapter = makeAdapter();
    const task = taskStore.createTask('x', '/workspace');

    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(/grok login --device-code/);
    expect(backend.sessions).toHaveLength(0);
    expect(readdirSync(sessionHomeRoot)).toHaveLength(0);
  });

  test('refuses before session creation when the source auth file is expired', async () => {
    writeFileSync(
      join(sourceGrokHome, 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
          key: 'expired-access-token',
          auth_mode: 'oidc',
          create_time: '2020-01-01T00:00:00Z',
          user_id: 'test-user',
          expires_at: '2020-01-01T00:00:00Z',
          refresh_token: 'expired-refresh-token',
        },
      }),
    );
    const adapter = makeAdapter();
    const task = taskStore.createTask('x', '/workspace');

    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(/Grok authentication expired/);
    expect(backend.sessions).toHaveLength(0);
    expect(readdirSync(sessionHomeRoot)).toHaveLength(0);
  });

  test('fails closed instead of resending an unacknowledged bracketed prompt', async () => {
    const adapter = new GrokBuildAdapter(backend, taskStore, {
      env: { ...baseEnv },
      installedStateOverride: testedState(),
      sourceGrokHome,
      sessionHomeRoot,
      promptBracketedPaste: true,
      promptReadyTimeoutMs: 0,
      promptSubmitConfirmTimeoutMs: 0,
      promptSubmitRetries: 0,
      handshakeRetries: 0,
    });
    vi.spyOn(backend, 'captureBytes').mockResolvedValue(new TextEncoder().encode('\x1b[?2004h'));

    const task = taskStore.createTask('x', '/workspace');
    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(/refusing to resend it.*Auth preflight passed/);
    expect([...backend.sessions.values()].every((session) => !session.alive)).toBe(true);
    expect(readdirSync(sessionHomeRoot)).toHaveLength(0);
  });

  test('unconfirmed handshake error names the ack marker and includes a pane excerpt (issue #1808)', async () => {
    const adapter = new GrokBuildAdapter(backend, taskStore, {
      env: { ...baseEnv },
      installedStateOverride: testedState(),
      sourceGrokHome,
      sessionHomeRoot,
      promptBracketedPaste: true,
      promptReadyTimeoutMs: 0,
      promptSubmitConfirmTimeoutMs: 0,
      promptSubmitRetries: 0,
      handshakeRetries: 0,
    });
    const pane = '\x1b[?2004h\n› type a message… (esc to interrupt)\nvisible-composer-state';
    vi.spyOn(backend, 'captureBytes').mockResolvedValue(new TextEncoder().encode(pane));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const task = taskStore.createTask('x', '/workspace');
    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(
      new RegExp(
        `${GROK_INITIAL_PROMPT_ACK_MARKER.replace(/[()]/g, '\\$&')}.*Pane excerpt:.*visible-composer-state`,
        's',
      ),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pane excerpt:'));
    warn.mockRestore();
  });

  test('permission menu after idle handshake Enter still fails closed (not assumed-submitted)', async () => {
    // First confirm sees idle; after handshake Enter the pane is a Grok
    // permission menu. isGrokBusyOrResponding is true for that menu — must
    // not treat it as successful prompt accept.
    const adapter = new GrokBuildAdapter(backend, taskStore, {
      env: { ...baseEnv },
      installedStateOverride: testedState(),
      sourceGrokHome,
      sessionHomeRoot,
      promptBracketedPaste: true,
      promptReadyTimeoutMs: 0,
      promptSubmitConfirmTimeoutMs: 40,
      promptSubmitRetries: 0,
      handshakeRetries: 1,
    });
    const idlePane = '\x1b[?2004h\n› type a message… (esc to interrupt)';
    const permissionPane =
      '\x1b[?2004h\nAllow once\nAlways allow this command\nReject\nNo, and tell Grok what to do differently';
    let captures = 0;
    vi.spyOn(backend, 'captureBytes').mockImplementation(async () => {
      captures += 1;
      // Early captures: idle (deliver unconfirmed + handshake entry).
      // Later: permission after retry Enter.
      const pane = captures < 5 ? idlePane : permissionPane;
      return new TextEncoder().encode(pane);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const task = taskStore.createTask('x', '/workspace');
    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(
      /permission prompt|Allow once|Reject/i,
    );
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('assuming initial prompt submitted')),
    ).toBe(false);
    warn.mockRestore();
  });

  test('assumes submitted when pane is busy/Thinking without UserPromptSubmit hook (overnight launch-storm fix)', async () => {
    const adapter = new GrokBuildAdapter(backend, taskStore, {
      env: { ...baseEnv },
      installedStateOverride: testedState(),
      sourceGrokHome,
      sessionHomeRoot,
      promptBracketedPaste: true,
      promptReadyTimeoutMs: 0,
      promptSubmitConfirmTimeoutMs: 40,
      promptSubmitRetries: 0,
      handshakeRetries: 1,
    });
    // Grok already streaming; UserPromptSubmit never fires. Prior behaviour
    // waited for the hook again then killed a live session.
    const busyPane = '\x1b[?2004h\n◆ Thinking…\nworking on it';
    vi.spyOn(backend, 'captureBytes').mockResolvedValue(new TextEncoder().encode(busyPane));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace');

    expect(backend.sessions.has(sessionId)).toBe(true);
    expect(backend.sessions.get(sessionId)?.alive).toBe(true);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('assuming initial prompt submitted')),
    ).toBe(true);
    warn.mockRestore();
  });

  test('one in-session handshake retry resends Enter on an idle pane and succeeds when the hook arrives (issue #1808)', async () => {
    // After the first confirm wait times out the adapter logs "ack pending" and
    // starts the in-session retry wait. Poll for that log (not a fixed sleep)
    // so the test is independent of DEFAULT_PROMPT_SUBMIT_DELAY_MS (500ms).
    const adapter = new GrokBuildAdapter(backend, taskStore, {
      env: { ...baseEnv },
      installedStateOverride: testedState(),
      sourceGrokHome,
      sessionHomeRoot,
      promptBracketedPaste: true,
      promptReadyTimeoutMs: 0,
      // Long enough that after we observe the "ack pending" warn we still have
      // time to inject the hook into the handshake-retry confirm window.
      promptSubmitConfirmTimeoutMs: 500,
      promptSubmitRetries: 0,
      handshakeRetries: 1,
    });
    const idlePane = '\x1b[?2004h\n› type a message… (esc to interrupt)';
    vi.spyOn(backend, 'captureBytes').mockResolvedValue(new TextEncoder().encode(idlePane));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const task = taskStore.createTask('x', '/workspace');
    const launchPromise = adapter.launch(task.id, 'x', '/workspace');

    const pollDeadline = Date.now() + 5_000;
    while (Date.now() < pollDeadline && warn.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('initial-prompt ack pending'));

    const sessions = [...backend.sessions.keys()];
    expect(sessions.length).toBe(1);
    // Inject during the handshake-retry confirm window.
    adapter.injectHookEvent(
      sessions[0],
      JSON.stringify({ hookEventName: 'user_prompt_submit', sessionId: 'S1', prompt: 'x' }),
    );
    const sessionId = await launchPromise;
    expect(sessionId).toBe(sessions[0]);
    warn.mockRestore();
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

  describe('agent-boot wall-clock bound (issue #1642)', () => {
    test('computeDefaultAgentBootTimeoutMs sums the nominal wait chain plus a fixed margin', () => {
      // waitForReadyOrAbort's ready wait + deliverInitialPromptToSession's OWN
      // internal ready wait (readyTimeoutMs threaded through twice) + the
      // submit-confirmation retries + default handshakeRetries (1), plus the
      // fixed cushion for the un-timed captureBytes calls/cleanup around them.
      expect(computeDefaultAgentBootTimeoutMs(15_000, 30_000, 0)).toBe(
        15_000 * 2 + 30_000 * (0 + 1 + 1) + AGENT_BOOT_TIMEOUT_MARGIN_MS,
      );
      expect(computeDefaultAgentBootTimeoutMs(15_000, 30_000, 2)).toBe(
        15_000 * 2 + 30_000 * (2 + 1 + 1) + AGENT_BOOT_TIMEOUT_MARGIN_MS,
      );
      expect(computeDefaultAgentBootTimeoutMs(15_000, 30_000, 0, 0)).toBe(
        15_000 * 2 + 30_000 * 1 + AGENT_BOOT_TIMEOUT_MARGIN_MS,
      );
    });

    test('defaults agentBootTimeoutMs from the configured ready/confirm/retry knobs', () => {
      const adapter = new GrokBuildAdapter(backend, taskStore, {
        env: { ...baseEnv },
        installedStateOverride: testedState(),
        sourceGrokHome,
        sessionHomeRoot,
        promptReadyTimeoutMs: 1000,
        promptSubmitConfirmTimeoutMs: 500,
        promptSubmitRetries: 1,
        handshakeRetries: 1,
      });
      expect((adapter as unknown as { agentBootTimeoutMs: number }).agentBootTimeoutMs).toBe(
        computeDefaultAgentBootTimeoutMs(1000, 500, 1, 1),
      );
    });

    test('a hung readiness probe (wedged terminal capture) is ABORTED within agentBootTimeoutMs, not held open indefinitely', async () => {
      const adapter = new GrokBuildAdapter(backend, taskStore, {
        env: { ...baseEnv },
        installedStateOverride: testedState(),
        sourceGrokHome,
        sessionHomeRoot,
        promptBracketedPaste: false,
        promptReadyTimeoutMs: 30,
        agentBootTimeoutMs: 50,
      });
      // Simulate a wedged terminal capture — e.g. a blocked pty under host
      // contention (the mechanism behind issue #1642's grok-build POST
      // /api/tasks >90s hang): captureBytes never resolves, so
      // waitForReadyOrAbort's internal `Date.now() <= deadline` loop check
      // never gets a chance to fire because the awaited call itself hangs.
      vi.spyOn(backend, 'captureBytes').mockImplementation(() => new Promise(() => { /* never settles */ }));

      const task = taskStore.createTask('x', '/workspace');
      const phases: string[] = [];
      const start = Date.now();
      let caught: unknown;
      try {
        await adapter.launch(task.id, 'x', '/workspace', undefined, { onPhase: (p) => phases.push(p) });
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - start;

      expect(caught).toBeInstanceOf(GrokAgentBootTimeoutError);
      expect(caught).toMatchObject({ message: expect.stringContaining('agent-boot did not complete within') });
      // Bounded to roughly agentBootTimeoutMs (50ms), nowhere near an
      // unbounded hang or the 180s top-level launch-service ceiling.
      expect(elapsed).toBeLessThan(5_000);
      // The adapter reported entering agent-boot (so launch-service's phase
      // tracker would mark it as the incompletePhase) but never reached ack.
      expect(phases).toEqual(['session-create', 'agent-boot']);
      // cleanupFailedLaunch ran: no orphaned session or session home dir.
      expect([...backend.sessions.values()].every((session) => !session.alive)).toBe(true);
      expect(readdirSync(sessionHomeRoot)).toHaveLength(0);
    });
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

    test('dispatches permission_denied as permission_request (permission-blocked visibility, issue #1526 Phase C4)', async () => {
      const { adapter, sessionId } = await launched();
      const events: AgentEvent[] = [];
      adapter.onEvent((_id, e) => events.push(e));
      adapter.injectHookEvent(sessionId, JSON.stringify({ hookEventName: 'session_start', sessionId: 'S1', cwd: '/workspace' }));
      const r = adapter.injectHookEvent(
        sessionId,
        JSON.stringify({ hookEventName: 'permission_denied', sessionId: 'S1', toolName: 'search_replace', toolInput: { file_path: '/workspace/a.ts' } }),
      );
      expect(r.parseStatus).toBe('ok');
      const perm = events.find((e) => e.type === 'permission_request');
      expect(perm).toMatchObject({ type: 'permission_request', toolName: 'search_replace' });
    });

    test('stop lastMessage falls back to a bounded tail of the last captured display', async () => {
      const { adapter, sessionId } = await launched();
      const events: AgentEvent[] = [];
      adapter.onEvent((_id, e) => events.push(e));
      backend.setCaptureContent(sessionId, 'intermediate output…\nAll tests pass — task complete.');
      // The server's watchdog tick calls captureDisplay every 5s; model one tick.
      await adapter.captureDisplay(sessionId);
      adapter.injectHookEvent(sessionId, JSON.stringify({ hookEventName: 'stop', sessionId: 'S1', reason: 'end_turn' }));
      const stop = events.find((e) => e.type === 'stop');
      expect(stop && 'lastMessage' in stop ? stop.lastMessage : '').toContain('All tests pass — task complete.');
    });

    test('the pane-tail lastMessage is bounded', async () => {
      const { adapter, sessionId } = await launched();
      const events: AgentEvent[] = [];
      adapter.onEvent((_id, e) => events.push(e));
      backend.setCaptureContent(sessionId, 'x'.repeat(3 * GROK_STOP_LAST_MESSAGE_MAX_CHARS));
      await adapter.captureDisplay(sessionId);
      adapter.injectHookEvent(sessionId, JSON.stringify({ hookEventName: 'stop', sessionId: 'S1', reason: 'end_turn' }));
      const stop = events.find((e) => e.type === 'stop');
      const lastMessage = stop && 'lastMessage' in stop ? stop.lastMessage : '';
      expect(lastMessage.length).toBeGreaterThan(0);
      expect(lastMessage.length).toBeLessThanOrEqual(GROK_STOP_LAST_MESSAGE_MAX_CHARS);
    });

    test('replayed stop events are NOT enriched from the current pane (stable fingerprints)', async () => {
      const { adapter, sessionId } = await launched();
      const events: AgentEvent[] = [];
      adapter.onEvent((_id, e) => events.push(e));
      backend.setCaptureContent(sessionId, 'post-restart pane content that did not exist at stop time');
      await adapter.captureDisplay(sessionId);
      adapter.injectHookEvent(
        sessionId,
        JSON.stringify({ hookEventName: 'stop', sessionId: 'S1', reason: 'end_turn' }),
        7,
        { origin: 'replay' },
      );
      const stop = events.find((e) => e.type === 'stop');
      expect(stop && 'lastMessage' in stop ? stop.lastMessage : 'MISSING').toBe('');
    });

    test('stop lastMessage stays empty when no display was ever captured', async () => {
      const { adapter, sessionId } = await launched();
      const events: AgentEvent[] = [];
      adapter.onEvent((_id, e) => events.push(e));
      adapter.injectHookEvent(sessionId, JSON.stringify({ hookEventName: 'stop', sessionId: 'S1', reason: 'end_turn' }));
      const stop = events.find((e) => e.type === 'stop');
      expect(stop && 'lastMessage' in stop ? stop.lastMessage : 'MISSING').toBe('');
    });
  });

  test('an unacknowledged initial prompt is diagnosed with the visible Grok permission menu', async () => {
    const adapter = new GrokBuildAdapter(backend, taskStore, {
      env: { ...baseEnv },
      installedStateOverride: testedState(),
      sourceGrokHome,
      sessionHomeRoot,
      promptBracketedPaste: true,
      promptReadyTimeoutMs: 0,
      promptSubmitConfirmTimeoutMs: 0,
      promptSubmitRetries: 0,
      handshakeRetries: 0,
    });
    // Ready DECSET present, but the composer is covered by the permission row
    // menu (labels verbatim from the grok 0.2.111 binary's prompter).
    const pane = '\x1b[?2004h\nGrok wants to run run_terminal_command\n❯ Allow once\n  Always allow this command\n  Reject\n';
    vi.spyOn(backend, 'captureBytes').mockResolvedValue(new TextEncoder().encode(pane));

    const task = taskStore.createTask('x', '/workspace');
    await expect(adapter.launch(task.id, 'x', '/workspace')).rejects.toThrow(/permission prompt.*Allow once/);
  });

  test('sendInput clears the line, pastes, and submits', async () => {
    const adapter = makeAdapter();
    const task = taskStore.createTask('x', '/workspace');
    const sessionId = await adapter.launch(task.id, 'x', '/workspace');
    await adapter.sendInput(sessionId, 'hello grok');
    expect(backend.sessions.get(sessionId)!.keysReceived.join('\n')).toContain('hello grok');
  });

  describe('token telemetry (issue #1581)', () => {
    const FIXTURE = fileURLToPath(new URL('./__fixtures__/grok-session-sample.jsonl', import.meta.url));

    function stageTranscript(grokHome: string, cwd: string, sessionId: string): void {
      const dir = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId);
      mkdirSync(dir, { recursive: true });
      copyFileSync(FIXTURE, join(dir, 'updates.jsonl'));
    }

    test('records mapped token usage from the session transcript on stop', async () => {
      const adapter = makeAdapter();
      const task = taskStore.createTask('meter me', '/workspace');
      const sessionId = await adapter.launch(task.id, 'meter me', '/workspace');
      const grokHome = backend.sessions.get(sessionId)!.spec.env!.GROK_HOME!;
      // Grok writes per-turn usage into <GROK_HOME>/sessions/<enc-cwd>/<sid>/updates.jsonl.
      stageTranscript(grokHome, '/workspace', '019f0000-0000-0000-0000-000000000001');

      await adapter.stop(sessionId);

      expect(taskStore.getTask(task.id)!.tokenUsage).toEqual({
        inputTokens: 63287, // 160087 gross − 96800 cached, summed over both turns
        outputTokens: 1358, // outputTokens already includes reasoning — not re-added
        cacheReadTokens: 96800,
        cacheWriteTokens: 0,
        costUsd: 0,
        model: 'grok-4.5-build',
      });
    });

    test('leaves tokenUsage unset when no transcript exists (missing-source fallback)', async () => {
      const adapter = makeAdapter();
      const task = taskStore.createTask('no transcript', '/workspace');
      const sessionId = await adapter.launch(task.id, 'no transcript', '/workspace');

      await expect(adapter.stop(sessionId)).resolves.toBeUndefined();
      expect(taskStore.getTask(task.id)!.tokenUsage).toBeUndefined();
    });
  });
});
