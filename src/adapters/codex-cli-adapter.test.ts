import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { CodexCliAdapter } from './codex-cli-adapter.js';
import { TaskStore } from '../core/tasks.js';
import { resolveAndPrepareCheckpointDir } from '../core/checkpoint-path.js';
import type { AgentEvent } from '../core/types.js';

const CODEX_SUPPORTED_HOOK_TYPES = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'UserPromptSubmit',
  'SessionEnd',
] as const;

const CLAUDE_ONLY_HOOK_TYPES_MISSING_FROM_CODEX = [
  'SubagentStart',
  'SubagentStop',
] as const;

// Mock getGitInfo
vi.mock('./git-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-info.js')>();
  return {
    ...actual,
    getGitInfo: vi.fn().mockResolvedValue(null),
  };
});

import { getGitInfo } from './git-info.js';
const mockGetGitInfo = vi.mocked(getGitInfo);

/** Probe stub: a kookr-fork codex advertising both --plugin-dir and --prompt-file. */
const forkProbeExec: import('./probe-agent-binary.js').ProbeExecRunner = async (_file, args) => {
  if (args.includes('--help')) {
    return {
      stdout: 'Usage: codex [OPTIONS] [PROMPT]\n      --plugin-dir <DIR>\n      --prompt-file <PATH>\n',
      stderr: '',
    };
  }
  return { stdout: 'codex 0.125.0\n', stderr: '' };
};

/** Probe stub: a stock upstream codex advertising neither fork flag. */
const stockProbeExec: import('./probe-agent-binary.js').ProbeExecRunner = async (_file, args) => {
  if (args.includes('--help')) {
    return { stdout: 'Usage: codex [OPTIONS] [PROMPT]\n      --add-dir <DIR>\n', stderr: '' };
  }
  return { stdout: 'codex 0.125.0\n', stderr: '' };
};

describe('CodexCliAdapter', () => {
  let backend: FakeTerminalBackend;
  let taskStore: TaskStore;
  let adapter: CodexCliAdapter;
  let writtenFiles: Map<string, string>;

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    writtenFiles = new Map();
    adapter = new CodexCliAdapter(backend, taskStore, {
      trustWorkspace: false,
      probeExec: forkProbeExec,
      writeFile: async (path, content) => {
        writtenFiles.set(path, content);
      },
    });
    mockGetGitInfo.mockReset().mockResolvedValue(null);
  });

  /** Initial prompt as delivered to codex via the --prompt-file launch artifact. */
  function deliveredPrompt(spec: { args: string[] }): string {
    const idx = spec.args.indexOf('--prompt-file');
    expect(idx).toBeGreaterThanOrEqual(0);
    const content = writtenFiles.get(spec.args[idx + 1]);
    expect(content, 'prompt file should have been written').toBeDefined();
    return content!;
  }

  test('agentType is codex-cli', () => {
    expect(adapter.agentType).toBe('codex-cli');
  });

  test('launch creates a session with codex command and the Codex-hook argv', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    expect(sessionId).toMatch(/^kookr-/);
    expect(backend.sessions.has(sessionId)).toBe(true);

    // V8: the backend receives a SessionSpec, not a shell string. Env vars
    // live in spec.env and flags live in spec.args.
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.env?.KOOKR_TASK_ID).toBe(task.id);
    // The binary is argv[0] on its own — no `env VAR=x codex …` shell prefix.
    expect(spec.command).toMatch(/(^|\/)codex$/);
    expect(spec.args).toEqual(expect.arrayContaining(['-c', 'features.codex_hooks=true']));
    expect(spec.args).toContain('--full-auto');
    expect(spec.args).toContain('--settings');
    expect(spec.args).toContain('--prompt-file');
  });

  test('launch delivers the initial prompt via --prompt-file, never argv', async () => {
    // 200 KiB exceeds Linux ARG_MAX headroom — proves the prompt is never an
    // argv entry regardless of size, and is delivered as a file artifact.
    const largePrompt = 'x'.repeat(200_000);
    const task = taskStore.createTask(largePrompt, '/cwd');
    const sessionId = await adapter.launch(task.id, largePrompt, '/cwd');

    const spec = backend.sessions.get(sessionId)!.spec;
    // The prompt itself never travels in argv (no ARG_MAX / E2BIG — see #319).
    expect(spec.args.some((arg) => arg.includes(largePrompt))).toBe(false);
    // It is delivered as a launch-artifact file referenced by --prompt-file.
    const idx = spec.args.indexOf('--prompt-file');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spec.args[idx + 1]).toMatch(/\.prompt\.txt$/);
    expect(deliveredPrompt(spec)).toBe(largePrompt);
    // No terminal write of the prompt — that path raced the TUI startup.
    expect(backend.getWrittenText(sessionId)).not.toContain(largePrompt);
  });

  test('falls back to a positional argv prompt when the binary lacks --prompt-file', async () => {
    // Stock codex (or a kookr-fork built before --prompt-file landed) does not
    // advertise the flag; the prompt is delivered as a trailing positional arg
    // — still race-free (argv, not a terminal write), just bounded by ARG_MAX.
    const stockAdapter = new CodexCliAdapter(backend, taskStore, {
      trustWorkspace: false,
      probeExec: stockProbeExec,
      writeFile: async (path, content) => {
        writtenFiles.set(path, content);
      },
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await stockAdapter.launch(task.id, 'Fix bug', '/cwd');

    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--prompt-file');
    // Prompt delivered as the trailing positional argv entry.
    expect(spec.args[spec.args.length - 1]).toBe('Fix bug');
  });

  test('launch uses --full-auto and NOT the dangerous bypass flag by default', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).toContain('--full-auto');
    expect(spec.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('launch replaces --full-auto with the dangerous bypass flag when bypassAllPermissions is true', async () => {
    const bypassAdapter = new CodexCliAdapter(backend, taskStore, {
      trustWorkspace: false,
      bypassAllPermissions: true,
      probeExec: forkProbeExec,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    // The two flags are mutually exclusive — --full-auto must be absent.
    expect(spec.args).not.toContain('--full-auto');
  });

  test('launch registers session with correct agentType', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const updatedTask = taskStore.getTask(task.id)!;
    const session = updatedTask.sessions.find(s => s.tmuxSession === sessionId);
    expect(session).toBeDefined();
    expect(session!.agentType).toBe('codex-cli');
  });

  test('launch prefixes the prompt with semantic checkpoint fallback instructions when JSON is absent', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-checkpoint-prefix-'));
    try {
      const cwd = join(tempDir, 'repo');
      const gitDir = join(cwd, '.git');
      const kookrDataDir = join(tempDir, '.kookr');
      await mkdir(gitDir, { recursive: true });
      await mkdir(kookrDataDir, { recursive: true });
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/feat-checkpoint-md\n');
      const checkpointDir = await resolveAndPrepareCheckpointDir({ cwd, kookrDataDir });
      expect(checkpointDir).not.toBeNull();
      await writeFile(join(checkpointDir!, 'CHECKPOINT.md'), '# Markdown checkpoint\n');

      const checkpointAdapter = new CodexCliAdapter(backend, taskStore, {
        trustWorkspace: false,
        kookrDataDir,
        probeExec: forkProbeExec,
        writeFile: async (path, content) => {
          writtenFiles.set(path, content);
        },
      });
      const task = taskStore.createTask('Fix bug', cwd);
      const sessionId = await checkpointAdapter.launch(task.id, 'original prompt', cwd);

      const spec = backend.sessions.get(sessionId)!.spec;
      const prompt = deliveredPrompt(spec);
      expect(spec.args).not.toContain('original prompt');
      expect(prompt).toContain('CHECKPOINT.json is not present');
      expect(prompt).toContain('Read $TASK_CHECKPOINT_DIR/CHECKPOINT.md as your very first action');
      expect(prompt).toContain('original prompt');
      // Guard the integration seam: confirm the env var actually reaches the
      // spawned codex process. A regression that dropped `launchContext.env`
      // would leave the prompt-text assertion green while the agent runs
      // without checkpoint state.
      expect(spec.env?.TASK_CHECKPOINT_DIR).toBe(checkpointDir);
      expect(spec.env?.KOOKR_CHECKPOINT_DIR).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('launch generates the widened Codex-compatible hook subscription set', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const settings = adapter.getGeneratedSettings(sessionId);
    expect(settings).toBeDefined();
    expect(Object.keys(settings!.hooks).sort()).toEqual([...CODEX_SUPPORTED_HOOK_TYPES].sort());
    expect(settings!.permissions?.allow).toContain('Bash(git *)');

    for (const hookType of CODEX_SUPPORTED_HOOK_TYPES) {
      const matchers = settings!.hooks[hookType];
      expect(matchers, `${hookType} should be configured`).toBeDefined();
      expect(matchers).toHaveLength(1);
      expect(matchers[0].hooks).toHaveLength(1);
      expect(matchers[0].hooks[0].command).toContain(sessionId);
    }

    expect(settings!.hooks.SessionStart[0].matcher).toBe('*');
    expect(settings!.hooks.PreToolUse[0].matcher).toBe('*');
    expect(settings!.hooks.PostToolUse[0].matcher).toBe('*');
    expect(settings!.hooks.PostToolUseFailure[0].matcher).toBe('*');
    expect(settings!.hooks.Notification[0].matcher).toBe('*');
    expect(settings!.hooks.PermissionRequest[0].matcher).toBe('*');
    expect(settings!.hooks.Stop[0].matcher).toBe('');
    expect(settings!.hooks.StopFailure[0].matcher).toBe('');
    expect(settings!.hooks.UserPromptSubmit[0].matcher).toBe('');
    expect(settings!.hooks.SessionEnd[0].matcher).toBe('');
  });

  test('launch still omits out-of-scope Claude-only subagent hook events', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const settings = adapter.getGeneratedSettings(sessionId);
    expect(settings).toBeDefined();

    for (const hookType of CLAUDE_ONLY_HOOK_TYPES_MISSING_FROM_CODEX) {
      expect(settings!.hooks[hookType], `${hookType} should not be configured for Codex`).toBeUndefined();
    }
  });

  test('getEffectiveHookSettings returns content, agentType codex-cli, and settingsPath for a known session', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const effective = adapter.getEffectiveHookSettings(sessionId);
    expect(effective).toBeDefined();
    expect(effective!.agentType).toBe('codex-cli');
    expect(effective!.settingsPath).toMatch(/\.json$/);
    expect(effective!.settingsPath).toContain(sessionId);
    expect(effective!.content).toBe(adapter.getGeneratedSettings(sessionId));
  });

  test('getEffectiveHookSettings falls back to persisted settings after adapter restart', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-cli-settings-'));
    try {
      const settingsDir = join(tempDir, 'settings');
      await mkdir(settingsDir, { recursive: true });
      const sessionId = 'kookr-restart1';
      const content = {
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }],
        },
      };
      await writeFile(join(settingsDir, `${sessionId}.json`), JSON.stringify(content), 'utf-8');

      const restartedAdapter = new CodexCliAdapter(backend, taskStore, {
        trustWorkspace: false,
        settingsDir,
      });
      const effective = restartedAdapter.getEffectiveHookSettings(sessionId);

      expect(effective).toEqual({
        content,
        agentType: 'codex-cli',
        settingsPath: join(settingsDir, `${sessionId}.json`),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('getEffectiveHookSettings returns undefined for unknown session id', () => {
    expect(adapter.getEffectiveHookSettings('not-a-real-session')).toBeUndefined();
    expect(adapter.getEffectiveHookSettings('../../etc/passwd')).toBeUndefined();
  });

  test('launch pre-trusts the workspace in the Codex config before starting the session', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-cli-adapter-'));
    const settingsDir = join(tempDir, 'settings');
    const hooksDir = join(tempDir, 'hooks');
    const configPath = join(tempDir, '.codex', 'config.toml');
    await mkdir(settingsDir, { recursive: true });
    await mkdir(hooksDir, { recursive: true });

    const trustingAdapter = new CodexCliAdapter(backend, taskStore, {
      settingsDir,
      hooksDir,
      codexConfigPath: configPath,
      probeExec: forkProbeExec,
      writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    });
    const task = taskStore.createTask('Fix bug', '/tmp/project');

    try {
      await trustingAdapter.launch(task.id, 'Fix bug', '/tmp/project');

      expect(await readFile(configPath, 'utf-8')).toContain('[projects."/tmp/project"]');
      expect(await readFile(configPath, 'utf-8')).toContain('trust_level = "trusted"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('injectHookEvent parses Codex CLI events (same format as Claude Code)', () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const events: AgentEvent[] = [];
    adapter.onEvent((_, event) => events.push(event));

    // Simulate Codex CLI launching (to register tmuxToTaskId + session)
    const sessionId = 'kookr-test';
    (adapter as any).tmuxToTaskId.set(sessionId, task.id);
    taskStore.addSession(task.id, {
      tmuxSession: sessionId,
      agentType: 'codex-cli',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    // Codex CLI SessionStart event (same field names as Claude Code)
    const sessionStartJson = JSON.stringify({
      session_id: 'codex-session-123',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'gpt-4',
      permission_mode: 'default',
    });
    adapter.injectHookEvent(sessionId, sessionStartJson);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_start');
    expect(events[0].sessionId).toBe('codex-session-123');
  });

  test('injectHookEvent stores codex hook capabilities from SessionStart', () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = 'kookr-test';
    (adapter as any).tmuxToTaskId.set(sessionId, task.id);
    taskStore.addSession(task.id, {
      tmuxSession: sessionId,
      agentType: 'codex-cli',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-123',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'gpt-5.4',
      codex_hook_capabilities: {
        surface_version: 2,
        supported_events: ['SessionStart', 'Notification', 'Stop'],
        handler_features: { command_if: true },
      },
    }));

    const session = taskStore.getTask(task.id)!.sessions[0];
    expect(session.codexHookCapabilities).toEqual({
      surfaceVersion: 2,
      supportedEvents: ['SessionStart', 'Notification', 'Stop'],
      handlerFeatures: { commandIf: true },
    });
  });

  test('injectHookEvent keeps Codex sessions in legacy mode when capabilities are absent', () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = 'kookr-test';
    (adapter as any).tmuxToTaskId.set(sessionId, task.id);
    taskStore.addSession(task.id, {
      tmuxSession: sessionId,
      agentType: 'codex-cli',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-123',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'gpt-4',
    }));

    const session = taskStore.getTask(task.id)!.sessions[0];
    expect(session.codexHookCapabilities).toBeUndefined();
  });

  test('injectHookEvent handles PreToolUse with Bash tool', () => {
    const events: AgentEvent[] = [];
    adapter.onEvent((_, event) => events.push(event));

    const preToolJson = JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      model: 'gpt-4',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_use_id: 'tu-1',
    });
    adapter.injectHookEvent('kookr-test', preToolJson);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    if (events[0].type === 'tool_use') {
      expect(events[0].toolName).toBe('Bash');
    }
  });

  test('injectHookEvent handles Stop event', () => {
    const events: AgentEvent[] = [];
    adapter.onEvent((_, event) => events.push(event));

    const stopJson = JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/cwd',
      hook_event_name: 'Stop',
      model: 'gpt-4',
      permission_mode: 'default',
      stop_hook_active: true,
      last_assistant_message: 'Done. Fixed the bug.',
    });
    adapter.injectHookEvent('kookr-test', stopJson);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('stop');
  });

  test('injectHookEvent handles PostToolUse', () => {
    const events: AgentEvent[] = [];
    adapter.onEvent((_, event) => events.push(event));

    const postToolJson = JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/cwd',
      hook_event_name: 'PostToolUse',
      model: 'gpt-4',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: { stdout: 'file.txt' },
      tool_use_id: 'tu-1',
    });
    adapter.injectHookEvent('kookr-test', postToolJson);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    if (events[0].type === 'tool_result') {
      expect(events[0].toolName).toBe('Bash');
      expect(events[0].toolResponse).toEqual({ stdout: 'file.txt' });
    }
  });

  test('injectHookEvent handles UserPromptSubmit', () => {
    const events: AgentEvent[] = [];
    adapter.onEvent((_, event) => events.push(event));

    const promptJson = JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      model: 'gpt-4',
      permission_mode: 'default',
      prompt: 'continue with the refactor',
    });
    adapter.injectHookEvent('kookr-test', promptJson);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user_prompt');
    if (events[0].type === 'user_prompt') {
      expect(events[0].prompt).toBe('continue with the refactor');
    }
  });

  test('injectHookEvent handles PermissionRequest', () => {
    const events: AgentEvent[] = [];
    adapter.onEvent((_, event) => events.push(event));

    const permJson = JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/cwd',
      hook_event_name: 'PermissionRequest',
      model: 'gpt-4',
      permission_mode: 'on-request',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build/' },
    });
    adapter.injectHookEvent('kookr-test', permJson);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission_request');
  });

  test('tool workdir paths can move git metadata from launch cwd to a linked worktree', async () => {
    const task = taskStore.createTask('Fix bug', '/workspace/repo');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/workspace/repo');
    await vi.waitFor(() => expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo'));
    mockGetGitInfo.mockClear();
    mockGetGitInfo.mockResolvedValue({
      branch: 'fix/codex-worktree',
      commit: 'abcdef1',
      isWorktree: true,
      isDetached: false,
      worktreeRoot: '/workspace/repo-codex',
    });

    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/workspace/repo',
      hook_event_name: 'SessionStart',
    }));
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/workspace/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu-bash-1',
      tool_input: {
        cmd: 'pnpm test',
        workdir: '/workspace/repo-codex',
      },
    }));

    await vi.waitFor(() => {
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.cwd).toBe('/workspace/repo-codex');
      expect(session.gitBranch).toBe('fix/codex-worktree');
      expect(session.gitCommit).toBe('abcdef1');
      expect(session.gitIsWorktree).toBe(true);
    });
    expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo-codex');

    mockGetGitInfo.mockClear();
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/workspace/repo',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu-bash-1',
      tool_response: { output: 'ok' },
    }));
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-123',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/workspace/repo',
      hook_event_name: 'Stop',
      last_assistant_message: 'done',
    }));

    await vi.waitFor(() => {
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.cwd).toBe('/workspace/repo-codex');
      expect(session.gitBranch).toBe('fix/codex-worktree');
    });
    expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo-codex');
  });

  test('command paths can move git metadata when no workdir is present', async () => {
    const task = taskStore.createTask('Fix bug', '/workspace/repo');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/workspace/repo');
    await vi.waitFor(() => expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo'));
    mockGetGitInfo.mockClear();
    mockGetGitInfo.mockResolvedValue({
      branch: 'fix/codex-command-path',
      commit: '123abcd',
      isWorktree: true,
      isDetached: false,
      worktreeRoot: '/workspace/repo-command',
    });

    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-456',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/workspace/repo',
      hook_event_name: 'SessionStart',
    }));
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'codex-session-456',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: '/workspace/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        cmd: 'cd /workspace/repo-command && pnpm test',
      },
    }));

    await vi.waitFor(() => {
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.cwd).toBe('/workspace/repo-command');
      expect(session.gitBranch).toBe('fix/codex-command-path');
      expect(session.gitCommit).toBe('123abcd');
      expect(session.gitIsWorktree).toBe(true);
    });
    expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo-command');
  });

  test('sendInput writes text and Enter as two distinct payloads in submission order', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const before = backend.getWrittenBytes(sessionId).length;

    await adapter.sendInput(sessionId, 'yes, continue');

    // Codex's TUI distinguishes paste-bursts from typed-then-submit by the
    // syscall boundary. writeSequence([text, ENTER]) must preserve that split
    // inside a single mutex acquisition — the fake captures each payload
    // separately in submission order.
    const written = backend.getWrittenBytes(sessionId).slice(before);
    expect(written).toHaveLength(2);
    expect(new TextDecoder().decode(written[0])).toBe('yes, continue');
    expect(written[1]).toEqual(Uint8Array.of(0x0d));
  });

  test('unknown hook events are silently skipped', () => {
    const events: AgentEvent[] = [];
    adapter.onEvent((_, event) => events.push(event));

    // Codex CLI doesn't have SubagentStart — but even if it arrived, the parser
    // handles it. What matters is truly unknown events are dropped.
    const unknownJson = JSON.stringify({
      session_id: 'codex-session-123',
      cwd: '/cwd',
      hook_event_name: 'SomeFutureEvent',
    });
    adapter.injectHookEvent('kookr-test', unknownJson);

    expect(events).toHaveLength(0);
  });

  test('custom agentBin is used as the SessionSpec command', async () => {
    const customAdapter = new CodexCliAdapter(backend, taskStore, {
      trustWorkspace: false,
      agentBin: '/usr/local/bin/codex-custom',
      probeExec: forkProbeExec,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await customAdapter.launch(task.id, 'Fix bug', '/cwd');

    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.command).toBe('/usr/local/bin/codex-custom');
  });

  test('serverPort enables dual-write hooks (JSONL + HTTP POST)', async () => {
    const adapterWithPort = new CodexCliAdapter(backend, taskStore, {
      trustWorkspace: false,
      serverPort: 4801,
      probeExec: forkProbeExec,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapterWithPort.launch(task.id, 'Fix bug', '/cwd');

    // The spec's argv must still wire the generated settings file.
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).toContain('--settings');
    const settings = adapterWithPort.getGeneratedSettings(sessionId);
    expect(settings!.permissions?.allow).toContain('Bash(curl *KOOKR_API_BASE_URL*api/tasks*)');
    expect(settings!.permissions?.allow).toContain('Bash(curl *http://127.0.0.1:4801/api/tasks*)');
  });

  describe('extraEnv propagation (rfc-ralph-loop-stall-handling.md §8)', () => {
    test('passes extraEnv through to SessionSpec.env', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, {
        extraEnv: { RALPH_VERDICT_FILE: '/tmp/test/.ralph-verdict-aaaaaaaa.json', FOO: 'bar' },
      });
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.env?.RALPH_VERDICT_FILE).toBe('/tmp/test/.ralph-verdict-aaaaaaaa.json');
      expect(spec.env?.FOO).toBe('bar');
      expect(spec.env?.KOOKR_TASK_ID).toBe(task.id);
    });

    test('extraEnv overrides launch-context env when keys collide', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, {
        extraEnv: { KOOKR_TASK_ID: 'forced-override' },
      });
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.env?.KOOKR_TASK_ID).toBe('forced-override');
    });

    test('omitted extraEnv leaves env identical to today', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.env?.RALPH_VERDICT_FILE).toBeUndefined();
      expect(spec.env?.KOOKR_TASK_ID).toBe(task.id);
    });
  });

  describe('--plugin-dir injection', () => {
    let validPluginDir: string;
    let tempRoot: string;
    let backend: FakeTerminalBackend;
    let taskStore: TaskStore;

    // Probe stub that simulates kookr-fork codex (advertises --plugin-dir
    // and --prompt-file — both are kookr-fork capabilities).
    const probeSupported: import('./probe-agent-binary.js').ProbeExecRunner = async (_file, args) => {
      if (args.includes('--help')) {
        return {
          stdout: 'Usage: codex [OPTIONS]\n      --plugin-dir <DIR>\n      --prompt-file <PATH>\n',
          stderr: '',
        };
      }
      return { stdout: 'codex 0.125.0\n', stderr: '' };
    };

    // Probe stub that simulates stock upstream codex (no --plugin-dir).
    const probeUnsupported: import('./probe-agent-binary.js').ProbeExecRunner = async (_file, args) => {
      if (args.includes('--help')) {
        return { stdout: 'Usage: codex [OPTIONS]\n      --add-dir <DIR>\n', stderr: '' };
      }
      return { stdout: 'codex 0.124.0\n', stderr: '' };
    };

    beforeEach(() => {
      backend = new FakeTerminalBackend();
      taskStore = new TaskStore();
      tempRoot = mkdtempSync(join(tmpdir(), 'kookr-codex-plugin-test-'));
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

    test('injects --plugin-dir when binary advertises it AND tree resolves', async () => {
      const a = new CodexCliAdapter(backend, taskStore, {
        pluginDir: validPluginDir,
        trustWorkspace: false,
        probeExec: probeSupported,
      });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 'my-prompt', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      const idx = spec.args.indexOf('--plugin-dir');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(spec.args[idx + 1]).toBe(validPluginDir);
      expect(spec.args).not.toContain('my-prompt');
      expect(spec.args).toContain('--prompt-file');
    });

    test('skips injection when binary does NOT advertise --plugin-dir (stock codex)', async () => {
      const a = new CodexCliAdapter(backend, taskStore, {
        pluginDir: validPluginDir,
        trustWorkspace: false,
        probeExec: probeUnsupported,
      });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 't', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      // Binary doesn't support the flag → no injection, no launch failure.
      expect(spec.args).not.toContain('--plugin-dir');
    });

    test('skips injection when explicit pluginDir path is invalid (no plugin.json)', async () => {
      const bogus = join(tempRoot, 'does-not-exist');
      const a = new CodexCliAdapter(backend, taskStore, {
        pluginDir: bogus,
        trustWorkspace: false,
        probeExec: probeSupported,
      });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 't', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.args).not.toContain('--plugin-dir');
    });

    test('skips injection when pluginDir is explicitly empty string', async () => {
      const a = new CodexCliAdapter(backend, taskStore, {
        pluginDir: '',
        trustWorkspace: false,
        probeExec: probeSupported,
      });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 't', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.args).not.toContain('--plugin-dir');
    });

    test('still injects under bypassAllPermissions=true', async () => {
      const a = new CodexCliAdapter(backend, taskStore, {
        pluginDir: validPluginDir,
        bypassAllPermissions: true,
        trustWorkspace: false,
        probeExec: probeSupported,
      });
      const task = taskStore.createTask('t', '/cwd');
      const sessionId = await a.launch(task.id, 'my-prompt', '/cwd');
      const spec = backend.sessions.get(sessionId)!.spec;
      const idx = spec.args.indexOf('--plugin-dir');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(spec.args[idx + 1]).toBe(validPluginDir);
      // Bypass replaces --full-auto with the dangerous variant.
      expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(spec.args).not.toContain('--full-auto');
      expect(spec.args).not.toContain('my-prompt');
      expect(spec.args).toContain('--prompt-file');
    });

    test('parent SessionStart is frozen against later distinct Codex session ids', async () => {
      const a = new CodexCliAdapter(backend, taskStore, { trustWorkspace: false, probeExec: forkProbeExec });
      const task = taskStore.createTask('reviewer-bug', '/cwd');
      const sessionId = await a.launch(task.id, 'do work', '/cwd');

      const sessionStart = (id: string) => JSON.stringify({
        session_id: id,
        transcript_path: `/t/${id}.jsonl`,
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
      });

      a.injectHookEvent(sessionId, sessionStart('codex-parent'));
      for (const id of ['codex-r1', 'codex-r2', 'codex-r3', 'codex-r4']) {
        a.injectHookEvent(sessionId, sessionStart(id));
      }

      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.claudeSessionId).toBe('codex-parent');
      expect(session.transcriptPath).toBe('/t/codex-parent.jsonl');
      expect(Object.keys(session.childSessionIds ?? {}).sort()).toEqual([
        'codex-r1', 'codex-r2', 'codex-r3', 'codex-r4',
      ]);
    });

    test('classifies same-session-id subagent prompts by transcript path', async () => {
      const a = new CodexCliAdapter(backend, taskStore, { trustWorkspace: false, probeExec: forkProbeExec });
      const task = taskStore.createTask('reviewer-bug', '/cwd');
      const sessionId = await a.launch(task.id, 'do work', '/cwd');
      const parentTranscript = '/home/jean/.codex/sessions/rollout-2026-05-20T21-10-13-codex-parent.jsonl';
      const childTranscript = '/home/jean/.codex/sessions/rollout-2026-05-20T21-10-24-codex-child.jsonl';

      const observed: Array<{ type: string; prompt?: string; parentage: string; raw?: string }> = [];
      a.onEvent((_id, event, meta) => {
        observed.push({
          type: event.type,
          prompt: event.type === 'user_prompt' ? event.prompt : undefined,
          parentage: meta.parentage,
          raw: meta.rawSessionId,
        });
      });

      a.injectHookEvent(sessionId, JSON.stringify({
        session_id: 'codex-parent',
        transcript_path: parentTranscript,
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
      }));
      a.injectHookEvent(sessionId, JSON.stringify({
        session_id: 'codex-parent',
        transcript_path: childTranscript,
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
      }));
      a.injectHookEvent(sessionId, JSON.stringify({
        session_id: 'codex-parent',
        transcript_path: childTranscript,
        cwd: '/cwd',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'You are the subagent. Report findings.',
      }));

      expect(observed).toEqual([
        { type: 'session_start', parentage: 'parent', raw: 'codex-parent', prompt: undefined },
        { type: 'session_start', parentage: 'child', raw: 'codex-parent', prompt: undefined },
        { type: 'user_prompt', parentage: 'child', raw: 'codex-parent', prompt: 'You are the subagent. Report findings.' },
      ]);
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.claudeSessionId).toBe('codex-parent');
      expect(session.transcriptPath).toBe(parentTranscript);
      expect(session.childSessionIds?.[`transcript:${childTranscript}`]).toMatchObject({
        transcriptPath: childTranscript,
        reason: 'inherited_settings',
      });
    });

    test('hydrates parent/child identity from TaskStore after restart without launch map', () => {
      const a = new CodexCliAdapter(backend, taskStore, { trustWorkspace: false });
      const task = taskStore.createTask('reviewer-bug', '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-restarted',
        agentType: 'codex-cli',
        cwd: '/cwd',
        createdAt: new Date('2026-05-13T12:00:00Z'),
        lastStatus: 'running',
        claudeSessionId: 'codex-parent',
        transcriptPath: '/t/codex-parent.jsonl',
        childSessionIds: {
          'codex-r1': {
            firstSeenAt: '2026-05-13T12:00:01.000Z',
            transcriptPath: '/t/codex-r1.jsonl',
            reason: 'inherited_settings',
          },
        },
      });

      const observed: Array<{ raw?: string; parentage: string }> = [];
      a.onEvent((_id, _event, meta) => {
        observed.push({ raw: meta.rawSessionId, parentage: meta.parentage });
      });

      a.injectHookEvent('kookr-restarted', JSON.stringify({
        session_id: 'codex-r1',
        transcript_path: '/t/codex-r1.jsonl',
        cwd: '/cwd',
        hook_event_name: 'Stop',
        lastMessage: 'done',
      }));

      expect(observed).toEqual([{ raw: 'codex-r1', parentage: 'child' }]);
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === 'kookr-restarted')!;
      expect(session.claudeSessionId).toBe('codex-parent');
    });

    test('probes run only once per adapter (memoized across launches)', async () => {
      let helpCalls = 0;
      const counting: import('./probe-agent-binary.js').ProbeExecRunner = async (_file, args) => {
        if (args.includes('--help')) {
          helpCalls += 1;
          return {
            stdout: 'Usage: codex [OPTIONS]\n      --plugin-dir <DIR>\n      --prompt-file <PATH>\n',
            stderr: '',
          };
        }
        return { stdout: 'codex 0.125.0\n', stderr: '' };
      };
      const a = new CodexCliAdapter(backend, taskStore, {
        pluginDir: validPluginDir,
        trustWorkspace: false,
        probeExec: counting,
      });
      const t1 = taskStore.createTask('t1', '/cwd');
      const t2 = taskStore.createTask('t2', '/cwd');
      await a.launch(t1.id, 't1', '/cwd');
      const afterFirstLaunch = helpCalls;
      await a.launch(t2.id, 't2', '/cwd');
      // Two capability probes (--plugin-dir, --prompt-file) each spawn
      // `codex --help` exactly once; both results are memoized, so the
      // second launch re-spawns nothing.
      expect(afterFirstLaunch).toBe(2);
      expect(helpCalls).toBe(afterFirstLaunch);
    });
  });
});
