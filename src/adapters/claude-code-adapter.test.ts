import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { ClaudeCodeAdapter, resolvePluginDir } from './claude-code-adapter.js';
import type { ProbeExecRunner } from './probe-agent-binary.js';
import { DEFAULT_PROMPT_SUBMIT_DELAY_MS } from './agent-launch-context.js';
import { TaskStore } from '../core/tasks.js';
import type { AgentEvent } from '../core/types.js';
import type { TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';

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

  test('launch delivers a large initial prompt through stdin instead of argv', async () => {
    const largePrompt = 'x'.repeat(200_000);
    const task = taskStore.createTask(largePrompt, '/workspace/project');
    const sessionId = await adapter.launch(task.id, largePrompt, '/workspace/project');

    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args.some((arg) => arg.includes(largePrompt))).toBe(false);
    const written = backend.getWrittenText(sessionId);
    expect(written.length).toBe(largePrompt.length + 1);
    expect(written.startsWith(largePrompt)).toBe(true);
    expect(written.endsWith('\r')).toBe(true);
  });

  test('launch submits the initial prompt as a bracketed paste with a separate Enter', async () => {
    // Claude Code's UI folds a carriage return that arrives inside a paste
    // burst into a literal newline, leaving the prompt unsubmitted in the
    // input box. The adapter wraps the body in ANSI bracketed-paste markers
    // so the trailing Enter is parsed as an unambiguous keystroke. See
    // deliverInitialPromptToSession.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 5_000,
      promptSubmitRetries: 0,
    });
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');

    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Fix bug', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    expect(backend.getWrittenText(pendingSessionId)).toBe('');
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: 'shape-test-session',
      transcript_path: '/tmp/claude/transcripts/shape.jsonl',
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Fix bug',
    }));
    const sessionId = await launchPromise;

    // Body wrapped in ESC[200~ … ESC[201~; Enter is a separate write
    // carrying exactly the CR (0x0d) byte — never bundled with the body.
    expect(backend.getWrittenText(sessionId)).toBe('\x1b[200~Fix bug\x1b[201~\r');
    expect(writeSeqSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(writeSpy.mock.calls[0][1])).toEqual([0x0d]);
    expect(writeSeqSpy.mock.invocationCallOrder[0]).toBeLessThan(
      writeSpy.mock.invocationCallOrder[0],
    );
  });

  test('launch defaults to bracketed-paste submission when no env override is set', async () => {
    // Production default: with no explicit option and the env var unset,
    // the adapter opts into bracketed paste. (The unit suite otherwise sets
    // KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE=0 — see vitest.config.ts — so this
    // test clears it to exercise the real default.)
    vi.stubEnv('KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE', undefined);
    try {
      const defaultAdapter = new ClaudeCodeAdapter(backend, taskStore, {
        promptSubmitConfirmTimeoutMs: 5_000,
        promptSubmitRetries: 0,
      });
      const writeSpy = vi.spyOn(backend, 'write');
      const task = taskStore.createTask('Fix bug', '/cwd');
      const launchPromise = defaultAdapter.launch(task.id, 'Fix bug', '/cwd');
      await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
      const pendingSessionId = [...backend.sessions.keys()][0]!;
      expect(backend.getWrittenText(pendingSessionId)).toBe('');
      backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');
      await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
      defaultAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
        session_id: 'default-test-session',
        transcript_path: '/tmp/claude/transcripts/default.jsonl',
        cwd: '/cwd',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Fix bug',
      }));
      const sessionId = await launchPromise;
      expect(backend.getWrittenText(sessionId)).toBe('\x1b[200~Fix bug\x1b[201~\r');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('bracketed-paste launch short-circuits the confirmation wait when a UserPromptSubmit hook arrives', async () => {
    // Closed-loop verification of the submission path: with a generous confirm
    // window and many retries, the launch promise must still resolve quickly
    // once Claude Code emits a parent UserPromptSubmit hook — proving the
    // launch path observes the hook and stops waiting (rather than always
    // burning the full timeout). This is the primary defence against the
    // "prompt visible in input box, never submitted" stall.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 5_000,
      promptSubmitRetries: 3,
    });
    const writeSpy = vi.spyOn(backend, 'write');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');

    // Wait for delivery to have written the Enter — by that point the launch
    // is inside its awaitSubmit loop, so the next two injected hooks resolve
    // the deferred and let launch complete.
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));

    // SessionStart establishes parent identity so the subsequent
    // UserPromptSubmit classifies as parentage='parent'.
    const rawSessionId = '00000000-0000-0000-0000-aaaaaaaaaaaa';
    const transcriptPath = '/tmp/claude/transcripts/parent.jsonl';
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: transcriptPath,
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }));
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: transcriptPath,
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Submit me',
    }));

    const sessionId = await launchPromise;
    expect(sessionId).toBe(pendingSessionId);
    // Exactly one Enter — the hook short-circuited the retry loop.
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test('bracketed-paste launch resolves after a retry Enter when the hook arrives on the second attempt', async () => {
    // End-to-end coverage of the retry-then-confirm path THROUGH the
    // adapter wiring (resolver registration, parentage classification,
    // awaitSubmit predicate, retry loop). Helper-level tests already cover
    // the same behavior with a stubbed awaitSubmit; this one proves the
    // adapter's hook → resolver → predicate chain works across a retry
    // boundary, which the test reviewer flagged as the only path not yet
    // exercised at this layer.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 200,
      promptSubmitRetries: 2,
    });
    const writeSpy = vi.spyOn(backend, 'write');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');

    // Wait for the first retry to land (writes = initial + 1 retry = 2).
    // Timeout budget covers paste→Enter cushion (DEFAULT_PROMPT_SUBMIT_DELAY_MS,
    // 500ms) + one confirm window (200ms) + scheduling slop. By the time
    // this resolves the adapter is inside its second confirm await — the
    // injected hook below short-circuits it before the next 200ms expires.
    await vi.waitFor(
      () => expect(writeSpy).toHaveBeenCalledTimes(2),
      { timeout: 3_000 },
    );
    const rawSessionId = '00000000-0000-0000-0000-bbbbbbbbbbbb';
    const transcriptPath = '/tmp/claude/transcripts/parent.jsonl';
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: transcriptPath,
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }));
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: transcriptPath,
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Submit me',
    }));

    await launchPromise;
    // No third Enter — the hook fired before submitConfirmTimeoutMs elapsed.
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  test('bracketed-paste launch falls back to plain delivery when bracketed paste never confirms', async () => {
    // Claude Code v2.1.156 can enable bracketed-paste mode but still drop the
    // wrapped startup prompt. The adapter should then try the plain write path
    // before failing closed, and the same UserPromptSubmit waiter should
    // confirm that fallback submission.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 500,
      promptSubmitRetries: 0,
    });
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');

    // First writeSequence is bracketed paste; after its single confirm
    // timeout, fallback sends a second writeSequence with plain text+Enter.
    await vi.waitFor(
      () => expect(writeSeqSpy).toHaveBeenCalledTimes(2),
      { timeout: 2_000 },
    );

    const rawSessionId = '00000000-0000-0000-0000-dddddddddddd';
    const transcriptPath = '/tmp/claude/transcripts/fallback-parent.jsonl';
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: transcriptPath,
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }));
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: transcriptPath,
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Submit me',
    }));

    await launchPromise;
    expect(writeSeqSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(backend.getWrittenText(pendingSessionId)).toBe('\x1b[200~Submit me\x1b[201~\rSubmit me\r');
  });

  test('bracketed-paste launch can timeout waiting for paste mode before fallback confirmation', async () => {
    // Adapter-level coverage for the fail-open readiness timeout: if Claude
    // paints the composer but never emits ESC[?2004h, launch should not hang.
    // It proceeds to bracketed delivery, then falls back to plain delivery
    // when no UserPromptSubmit confirms the bracketed attempt.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptReadyTimeoutMs: 20,
      promptReadyPollMs: 5,
      promptSubmitConfirmTimeoutMs: 500,
      promptSubmitRetries: 0,
    });
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, 'ClaudeCode\n❯ ');

    await vi.waitFor(
      () => expect(writeSeqSpy).toHaveBeenCalledTimes(2),
      { timeout: 2_000 },
    );

    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: '00000000-0000-0000-0000-eeeeeeeeeeee',
      transcript_path: '/tmp/claude/transcripts/timeout-fallback-parent.jsonl',
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Submit me',
    }));

    await launchPromise;
    expect(writeSeqSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(backend.getWrittenText(pendingSessionId)).toBe('\x1b[200~Submit me\x1b[201~\rSubmit me\r');
  });

  test('bracketed-paste launch fires the resolver on a UserPromptSubmit that arrives before any SessionStart', async () => {
    // Race coverage for the parentage gate. When the UserPromptSubmit hook
    // POST overtakes the SessionStart POST under load, `classifyHookParentage`
    // returns 'unknown' because the parent identity has not been recorded
    // yet. The launch waiter must still fire — narrowing the gate to
    // `parent` would silently force every launch to ride the retry path.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 5_000,
      promptSubmitRetries: 3,
    });
    const writeSpy = vi.spyOn(backend, 'write');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));

    // Inject UserPromptSubmit WITHOUT a preceding SessionStart so the
    // parentage classifier sees no parent and returns 'unknown'.
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: 'no-session-start-yet',
      transcript_path: '/tmp/orphan.jsonl',
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Submit me',
    }));

    await launchPromise;
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test('bracketed-paste launch ignores a child-session UserPromptSubmit and waits for the parent one', async () => {
    // Symmetric guard: subagent UserPromptSubmit events (parentage='child')
    // must NOT fire the launch resolver, or a fast subagent prompt could
    // falsely declare the launch complete before the user's prompt landed.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 5_000,
      promptSubmitRetries: 3,
    });
    const writeSpy = vi.spyOn(backend, 'write');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));

    // Register parent identity via a parent SessionStart.
    const rawSessionId = '00000000-0000-0000-0000-cccccccccccc';
    const parentTranscript = '/tmp/claude/parent.jsonl';
    const childTranscript = '/tmp/claude/child.jsonl';
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: parentTranscript,
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }));
    // Subagent SessionStart — same session id, different transcript → child.
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: childTranscript,
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      source: 'subagent',
    }));
    // Child user_prompt — must not fire the launch resolver.
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: childTranscript,
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'subagent inner prompt',
    }));

    // The launch is still pending — release it with a parent user_prompt.
    bracketAdapter.injectHookEvent(pendingSessionId, JSON.stringify({
      session_id: rawSessionId,
      transcript_path: parentTranscript,
      cwd: '/cwd',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Submit me',
    }));

    await launchPromise;
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test('stop() during an in-flight bracketed-paste launch releases the launch waiter', async () => {
    // Without the resolver release in stop(), a killed session would leave
    // the launch promise blocked for up to (confirmTimeout × (retries+1))
    // waiting for a hook the dead process can never emit. We give the
    // confirm window an outright minute to prove the release path actually
    // unblocks rather than racing the timeout.
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 60_000,
      promptSubmitRetries: 0,
    });
    const writeSpy = vi.spyOn(backend, 'write');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));

    await bracketAdapter.stop(pendingSessionId);
    // launchPromise must resolve quickly — the 60s window is the canary.
    await launchPromise;
  });

  test('bracketed-paste launch resends Enter then fails when the UserPromptSubmit hook never arrives', async () => {
    const bracketAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      promptBracketedPaste: true,
      promptSubmitConfirmTimeoutMs: 5,
      promptSubmitRetries: 2,
    });
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');
    const killSpy = vi.spyOn(backend, 'killSession');
    const task = taskStore.createTask('Fix bug', '/cwd');
    const launchPromise = bracketAdapter.launch(task.id, 'Submit me', '/cwd');
    await vi.waitFor(() => expect(backend.sessions.size).toBe(1));
    const pendingSessionId = [...backend.sessions.keys()][0]!;
    backend.emit(pendingSessionId, '\x1b[?2004hClaudeCode\n❯ ');

    await expect(launchPromise).rejects.toThrow(/Initial prompt submission was not confirmed/);
    // Bracketed attempt: initial Enter + 2 retries. Plain fallback:
    // prompt+Enter in writeSequence + 2 retry Enters. writeSpy sees only
    // the standalone Enter writes, so 3 + 2 = 5.
    expect(writeSeqSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenCalledTimes(5);
    for (const call of writeSpy.mock.calls) {
      expect(Array.from(call[1])).toEqual([0x0d]);
    }
    expect(killSpy).toHaveBeenCalledWith(pendingSessionId);
    expect(backend.sessions.get(pendingSessionId)?.alive).toBe(false);
  });

  test('launch does NOT include --dangerously-skip-permissions or --setting-sources by default', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
    expect(spec.args).not.toContain('--setting-sources');
  });

  // issue #1562: an unattended/autonomous spawn's injected settings hard-deny
  // interactive tools so a blocking call fails fast instead of hanging.
  test('launch injects interactive-tool deny rules for unattended tasks', async () => {
    const task = taskStore.createTask({ prompt: 'Autonomous work', cwd: '/cwd', unattended: true });
    const sessionId = await adapter.launch(task.id, 'Autonomous work', '/cwd');
    const settings = adapter.getGeneratedSettings(sessionId);
    expect(settings?.permissions?.deny).toEqual(['AskUserQuestion']);
  });

  test('launch does NOT inject deny rules for attended tasks', async () => {
    const task = taskStore.createTask({ prompt: 'Interactive work', cwd: '/cwd' });
    const sessionId = await adapter.launch(task.id, 'Interactive work', '/cwd');
    const settings = adapter.getGeneratedSettings(sessionId);
    expect(settings?.permissions?.deny).toBeUndefined();
    // The allowlist is still present — only the deny key is unattended-gated.
    expect(settings?.permissions?.allow).toContain('Bash(git *)');
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
    const settingsIdx = spec.args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(sourcesIdx);
  });

  test('resumed launches with bypassAllPermissions still include both bypass flags before --resume', async () => {
    const bypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: true,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd', {
      sessionId: '00000000-0000-0000-0000-000000000001',
    });
    const spec = backend.sessions.get(sessionId)!.spec;
    const bypassIdx = spec.args.indexOf('--dangerously-skip-permissions');
    const sourcesIdx = spec.args.indexOf('--setting-sources');
    const resumeIdx = spec.args.indexOf('--resume');
    expect(bypassIdx).toBeGreaterThanOrEqual(0);
    expect(sourcesIdx).toBeGreaterThan(bypassIdx);
    expect(resumeIdx).toBeGreaterThan(sourcesIdx);
    expect(spec.args[sourcesIdx + 1]).toBe('');
  });

  test('launch injects --agents <json> when bypassAllPermissions is true and file-based agents exist', async () => {
    // Synthetic loader returning a user-scope and project-scope agent. The
    // adapter must serialize them to a JSON argv entry so they survive the
    // --setting-sources "" strip. See docs/poc/007-bypass-keeps-file-based-agents.md.
    const bypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: true,
      loadFileBasedAgents: () => ({
        'oss-issue-scout': {
          description: 'Project-scope scout',
          prompt: 'You are the scout.',
          model: 'opus',
        },
        'kb-scout': {
          description: 'User-scope kb scout',
          prompt: 'You are the kb scout.',
          model: 'haiku',
        },
      }),
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;

    const agentsIdx = spec.args.indexOf('--agents');
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    const sourcesIdx = spec.args.indexOf('--setting-sources');
    // --agents must come AFTER --setting-sources '' so the strip-then-inject
    // ordering matches the empirical recipe in PoC 007.
    expect(agentsIdx).toBeGreaterThan(sourcesIdx);
    // --agents must come BEFORE --settings so the CLI parses it as a flag,
    // mirroring how --dangerously-skip-permissions is positioned.
    const settingsIdx = spec.args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(agentsIdx);

    const agentsJson = JSON.parse(spec.args[agentsIdx + 1]);
    expect(agentsJson).toHaveProperty('oss-issue-scout');
    expect(agentsJson).toHaveProperty('kb-scout');
    expect(agentsJson['oss-issue-scout'].model).toBe('opus');
    expect(agentsJson['oss-issue-scout'].prompt).toBe('You are the scout.');
    expect(agentsJson['kb-scout'].description).toBe('User-scope kb scout');
  });

  test('launch omits --agents when bypassAllPermissions is true but no file-based agents found', async () => {
    // Empty loader → no --agents argv entry. Passing an empty JSON object
    // would be harmless but noisy; skipping keeps argv minimal.
    const bypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: true,
      loadFileBasedAgents: () => ({}),
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--agents');
    // Sanity: the rest of the bypass argv is intact.
    expect(spec.args).toContain('--dangerously-skip-permissions');
    expect(spec.args).toContain('--setting-sources');
  });

  test('launch does NOT call the file-based agents loader when bypassAllPermissions is false', async () => {
    // The fix is gated on bypass mode. In normal mode --setting-sources is
    // not stripped, so file-based agents already load via Claude Code's
    // built-in discovery — re-injecting them would duplicate everything.
    const loader = vi.fn(() => ({ foo: { description: '', prompt: 'x' } }));
    const noBypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: false,
      loadFileBasedAgents: loader,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await noBypassAdapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(loader).not.toHaveBeenCalled();
    expect(spec.args).not.toContain('--agents');
  });

  test('resumed launches with bypassAllPermissions still inject --agents between --setting-sources and --resume', async () => {
    // Regression guard for a future refactor that moves the agents block
    // into the non-resume branch. Resumed sessions must still see file-based
    // agents — the spawned Claude has the same need to invoke them.
    const bypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: true,
      loadFileBasedAgents: () => ({
        'oss-issue-scout': {
          description: 'scout',
          prompt: 'You are the scout.',
          model: 'opus',
        },
      }),
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd', {
      sessionId: '00000000-0000-0000-0000-000000000002',
    });
    const spec = backend.sessions.get(sessionId)!.spec;
    const sourcesIdx = spec.args.indexOf('--setting-sources');
    const agentsIdx = spec.args.indexOf('--agents');
    const resumeIdx = spec.args.indexOf('--resume');
    expect(sourcesIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThan(sourcesIdx);
    expect(resumeIdx).toBeGreaterThan(agentsIdx);
    // The injected JSON for resumed sessions matches the fresh-launch shape.
    const agentsJson = JSON.parse(spec.args[agentsIdx + 1]);
    expect(agentsJson['oss-issue-scout'].model).toBe('opus');
  });

  test('launch serialises agent prompts containing shell-special characters into a single argv element', async () => {
    // The fix passes --agents <json> as one argv element, so prompt bodies
    // do not need shell escaping. Round-tripping a body with backticks,
    // quotes, newlines, and dollar signs catches any regression that tries
    // to interpolate the JSON through a shell.
    const trickyPrompt = '`backticks` "double" \'single\' $VAR\n```bash\necho ${PATH}\n```';
    const bypassAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      bypassAllPermissions: true,
      loadFileBasedAgents: () => ({
        tricky: { description: 'has $special chars', prompt: trickyPrompt },
      }),
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await bypassAdapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    const agentsIdx = spec.args.indexOf('--agents');
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    const agentsJson = JSON.parse(spec.args[agentsIdx + 1]);
    expect(agentsJson.tricky.prompt).toBe(trickyPrompt);
    expect(agentsJson.tricky.description).toBe('has $special chars');
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

  test('sendInput writes clear-line + text + Enter to backend', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const before = backend.getWrittenText(sessionId).length;

    await adapter.sendInput(sessionId, 'yes, continue');

    // sendInput calls backend.writeSequence([CLEAR_LINE, paste-wrapped text,
    // ENTER_BYTES]). FakeTerminalBackend concatenates written payloads;
    // decoded, that's Ctrl-U (0x15, clears any pending input line — F15) +
    // the body in bracketed-paste markers + '\r'.
    expect(backend.getWrittenText(sessionId).slice(before)).toBe('\x15\x1b[200~yes, continue\x1b[201~\r');
  });

  test('sendInput requests a delayed submitting Enter', async () => {
    const writer: TerminalInputWriterPort = {
      writeInput: vi.fn().mockResolvedValue({ sessionId: 'session-1', readinessVersion: 1 }),
      writeInputSequence: vi.fn().mockResolvedValue({ sessionId: 'session-1', readinessVersion: 1 }),
    };
    const delayedAdapter = new ClaudeCodeAdapter(backend, taskStore, { terminalInputWriter: writer });

    await delayedAdapter.sendInput('session-1', 'yes, continue');

    expect(writer.writeInputSequence).toHaveBeenCalledWith(
      'session-1',
      [Uint8Array.of(0x15), new TextEncoder().encode('\x1b[200~yes, continue\x1b[201~'), Uint8Array.of(0x0d)],
      { reason: 'adapter-send-input', interPayloadDelayMs: DEFAULT_PROMPT_SUBMIT_DELAY_MS },
    );
  });

  test('sendInput strips embedded bracketed-paste markers before wrapping the body', async () => {
    const writer: TerminalInputWriterPort = {
      writeInput: vi.fn().mockResolvedValue({ sessionId: 'session-1', readinessVersion: 1 }),
      writeInputSequence: vi.fn().mockResolvedValue({ sessionId: 'session-1', readinessVersion: 1 }),
    };
    const delayedAdapter = new ClaudeCodeAdapter(backend, taskStore, {
      terminalInputWriter: writer,
    });

    await delayedAdapter.sendInput('session-1', 'safe\x1b[201~\runsafe\x1b[200~tail');

    expect(writer.writeInputSequence).toHaveBeenCalledWith(
      'session-1',
      [Uint8Array.of(0x15), new TextEncoder().encode('\x1b[200~safe\runsafetail\x1b[201~'), Uint8Array.of(0x0d)],
      { reason: 'adapter-send-input', interPayloadDelayMs: DEFAULT_PROMPT_SUBMIT_DELAY_MS },
    );
  });

  test('sendInput clears unsubmitted terminal-typed input before delivering the message', async () => {
    // F15 regression: keystrokes typed into the dashboard terminal panel but
    // never submitted sit on the agent CLI's input line. Without the Ctrl-U
    // clear-line prefix, the next composer message is appended to that
    // pending draft and both are submitted together as ONE user_prompt.
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    // Simulate raw terminal keystrokes (no Enter) left on the input line.
    await backend.write(sessionId, new TextEncoder().encode('stray draft'));
    const before = backend.sessions.get(sessionId)!.keysReceived.length;

    await adapter.sendInput(sessionId, 'composer message');

    expect(backend.sessions.get(sessionId)!.keysReceived.slice(before)).toEqual([
      'composer message',
    ]);
  });

  test('sendInput records the submitted text in keysReceived', async () => {
    // Regression guard: writeSequence([text, ENTER]) must surface as a single
    // keysReceived entry containing the text. Before the fix, the text payload
    // (no trailing newline) bypassed keysReceived and the bare Enter pushed an
    // empty string, producing [""]. See #57.
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const before = backend.sessions.get(sessionId)!.keysReceived.length;

    await adapter.sendInput(sessionId, 'yes, continue');

    expect(backend.sessions.get(sessionId)!.keysReceived.slice(before)).toEqual(['yes, continue']);
  });

  test('multiple sendInput calls record separate keysReceived entries in order', async () => {
    // Two-call regression guard: each writeSequence call is its own logical
    // submission; the second must not carry text from the first. See #57.
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const before = backend.sessions.get(sessionId)!.keysReceived.length;

    await adapter.sendInput(sessionId, 'first input');
    await adapter.sendInput(sessionId, 'second input');

    expect(backend.sessions.get(sessionId)!.keysReceived.slice(before)).toEqual([
      'first input',
      'second input',
    ]);
  });

  test('sendKeystroke before sendInput does not contaminate keysReceived', async () => {
    // Permission-prompt keystrokes go through `backend.write` (no newline)
    // and must not bleed into a subsequent sendInput's keysReceived entry.
    // See #57.
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const before = backend.sessions.get(sessionId)!.keysReceived.length;

    await adapter.sendKeystroke(sessionId, '1');
    await adapter.sendInput(sessionId, 'follow-up message');

    expect(backend.sessions.get(sessionId)!.keysReceived.slice(before)).toEqual(['follow-up message']);
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

  test('parent tool paths can move git metadata from launch cwd to a linked worktree', async () => {
    const refreshCalls: number[] = [];
    adapter.onRefreshNeeded(() => refreshCalls.push(1));

    const task = taskStore.createTask('Fix bug', '/workspace/repo');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/workspace/repo');
    await vi.waitFor(() => expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo'));
    mockGetGitInfo.mockClear();
    mockGetGitInfo.mockResolvedValue({
      branch: 'fix/worktree-branch',
      commit: '1234567',
      isWorktree: true,
      isDetached: false,
      worktreeRoot: '/workspace/repo-fix',
    });

    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'sess-uuid-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/workspace/repo',
      hook_event_name: 'SessionStart',
    }));
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'sess-uuid-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/workspace/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_use_id: 'toolu-edit-1',
      tool_input: {
        file_path: '/workspace/repo-fix/src/core/monitor.ts',
      },
    }));

    await vi.waitFor(() => {
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.cwd).toBe('/workspace/repo-fix');
      expect(session.gitBranch).toBe('fix/worktree-branch');
      expect(session.gitCommit).toBe('1234567');
      expect(session.gitIsWorktree).toBe(true);
    });
    expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo-fix/src/core/monitor.ts');

    mockGetGitInfo.mockClear();
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'sess-uuid-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/workspace/repo',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_use_id: 'toolu-edit-1',
      tool_response: {},
    }));
    adapter.injectHookEvent(sessionId, JSON.stringify({
      session_id: 'sess-uuid-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/workspace/repo',
      hook_event_name: 'Stop',
      last_assistant_message: 'done',
    }));

    await vi.waitFor(() => {
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.cwd).toBe('/workspace/repo-fix');
      expect(session.gitBranch).toBe('fix/worktree-branch');
    });
    expect(mockGetGitInfo).toHaveBeenCalledWith('/workspace/repo-fix/src/core/monitor.ts');
    expect(refreshCalls.length).toBeGreaterThan(0);
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

  describe('extraEnv propagation (rfc-ralph-loop-stall-handling.md §8)', () => {
    test('passes extraEnv through to SessionSpec.env', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, {
        extraEnv: { RALPH_VERDICT_FILE: '/tmp/test/.ralph-verdict-aaaaaaaa.json', FOO: 'bar' },
      });
      const spec = backend.sessions.get(sessionId)!.spec;
      expect(spec.env?.RALPH_VERDICT_FILE).toBe('/tmp/test/.ralph-verdict-aaaaaaaa.json');
      expect(spec.env?.FOO).toBe('bar');
      // Existing launch-context env keys still present (KOOKR_TASK_ID is set by buildAgentLaunchContext).
      expect(spec.env?.KOOKR_TASK_ID).toBe(task.id);
    });

    test('extraEnv overrides launch-context env when keys collide', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, {
        extraEnv: { KOOKR_TASK_ID: 'forced-override' },
      });
      const spec = backend.sessions.get(sessionId)!.spec;
      // Documented precedence: extraEnv wins (caller intent is explicit).
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

  describe('parent runtime session freezing (rfc-activity-log-reliability §2)', () => {
    function sessionStart(sessionId: string, transcriptPath = `/t/${sessionId}.jsonl`) {
      return JSON.stringify({
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
      });
    }

    test('first SessionStart claims parent and freezes it against four reviewer sessions', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

      adapter.injectHookEvent(sessionId, sessionStart('parent-1'));
      for (const id of ['child-1', 'child-2', 'child-3', 'child-4']) {
        adapter.injectHookEvent(sessionId, sessionStart(id));
      }

      const updated = taskStore.getTask(task.id)!;
      const session = updated.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.claudeSessionId).toBe('parent-1');
      expect(session.transcriptPath).toBe('/t/parent-1.jsonl');
      expect(Object.keys(session.childSessionIds ?? {}).sort()).toEqual([
        'child-1', 'child-2', 'child-3', 'child-4',
      ]);
    });

    test('handler receives parent classification for parent SessionStart and child for later ones', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

      const observed: Array<{ raw?: string; parentage: string }> = [];
      adapter.onEvent((_id, _event, meta) => {
        observed.push({ raw: meta.rawSessionId, parentage: meta.parentage });
      });

      adapter.injectHookEvent(sessionId, sessionStart('parent-1'));
      adapter.injectHookEvent(sessionId, sessionStart('child-1'));
      adapter.injectHookEvent(sessionId, JSON.stringify({
        session_id: 'child-1',
        transcript_path: '/t/child-1.jsonl',
        cwd: '/cwd',
        hook_event_name: 'Stop',
        lastMessage: 'done',
      }));

      expect(observed).toEqual([
        { raw: 'parent-1', parentage: 'parent' },
        { raw: 'child-1', parentage: 'child' },
        { raw: 'child-1', parentage: 'child' },
      ]);
    });

    test('classifies same-session-id child prompts by transcript path', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
      const parentTranscript = '/home/jean/.claude/projects/-cwd/parent-1.jsonl';
      const childTranscript = '/home/jean/.claude/projects/-cwd/child-1.jsonl';

      const observed: Array<{ raw?: string; parentage: string; type: string }> = [];
      adapter.onEvent((_id, event, meta) => {
        observed.push({ raw: meta.rawSessionId, parentage: meta.parentage, type: event.type });
      });

      adapter.injectHookEvent(sessionId, sessionStart('parent-1', parentTranscript));
      adapter.injectHookEvent(sessionId, sessionStart('parent-1', childTranscript));
      adapter.injectHookEvent(sessionId, JSON.stringify({
        session_id: 'parent-1',
        transcript_path: childTranscript,
        cwd: '/cwd',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Subagent prompt body',
      }));

      expect(observed).toEqual([
        { raw: 'parent-1', parentage: 'parent', type: 'session_start' },
        { raw: 'parent-1', parentage: 'child', type: 'session_start' },
        { raw: 'parent-1', parentage: 'child', type: 'user_prompt' },
      ]);
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.claudeSessionId).toBe('parent-1');
      expect(session.transcriptPath).toBe(parentTranscript);
      expect(session.childSessionIds?.[`transcript:${childTranscript}`]).toMatchObject({
        transcriptPath: childTranscript,
        reason: 'inherited_settings',
      });
    });

    test('hydrates parent/child identity from TaskStore after restart without launch map', () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-restarted',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date('2026-05-13T12:00:00Z'),
        lastStatus: 'running',
        claudeSessionId: 'parent-1',
        transcriptPath: '/t/parent-1.jsonl',
        childSessionIds: {
          'child-1': {
            firstSeenAt: '2026-05-13T12:00:01.000Z',
            transcriptPath: '/t/child-1.jsonl',
            reason: 'inherited_settings',
          },
        },
      });

      const observed: Array<{ raw?: string; parentage: string }> = [];
      adapter.onEvent((_id, _event, meta) => {
        observed.push({ raw: meta.rawSessionId, parentage: meta.parentage });
      });

      adapter.injectHookEvent('kookr-restarted', JSON.stringify({
        session_id: 'child-1',
        transcript_path: '/t/child-1.jsonl',
        cwd: '/cwd',
        hook_event_name: 'Stop',
        lastMessage: 'done',
      }));

      expect(observed).toEqual([{ raw: 'child-1', parentage: 'child' }]);
      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === 'kookr-restarted')!;
      expect(session.claudeSessionId).toBe('parent-1');
    });

    test('CWD changes from a child session do not move the parent task cwd', async () => {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

      adapter.injectHookEvent(sessionId, sessionStart('parent-1'));
      adapter.injectHookEvent(sessionId, JSON.stringify({
        session_id: 'child-1',
        transcript_path: '/t/child-1.jsonl',
        cwd: '/elsewhere',
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: {},
      }));

      const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === sessionId)!;
      expect(session.cwd).toBe('/cwd');
    });
  });
});

describe('ClaudeCodeAdapter reasoning effort (#681)', () => {
  let backend: FakeTerminalBackend;
  let taskStore: TaskStore;

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    mockGetGitInfo.mockReset().mockResolvedValue(null);
  });

  test('no configured default and no override → argv is byte-identical (no --effort)', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore);
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--effort');
  });

  test('per-agent-type default getter → pushes --effort <level>', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore, {
      resolveDefaultEffort: () => 'high',
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    const idx = spec.args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spec.args[idx + 1]).toBe('high');
  });

  test('per-task override (opts.effort) wins over the configured default', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore, {
      resolveDefaultEffort: () => 'high',
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, { effort: 'max' });
    const spec = backend.sessions.get(sessionId)!.spec;
    const idx = spec.args.indexOf('--effort');
    expect(spec.args[idx + 1]).toBe('max');
    // The default must not also be present.
    expect(spec.args.filter((a) => a === '--effort')).toHaveLength(1);
  });

  test('a default getter returning undefined passes no --effort', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore, {
      resolveDefaultEffort: () => undefined,
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--effort');
  });

  test('an effort invalid for claude-code is skipped (defensive guard), not passed', async () => {
    // `minimal`/`none` are codex-only; `max` is the claude-only top. A value
    // outside claude's set must never reach the argv (it would break launch).
    const adapter = new ClaudeCodeAdapter(backend, taskStore, {
      resolveDefaultEffort: () => 'minimal',
    });
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--effort');
  });
});

describe('ClaudeCodeAdapter model pin (#1518)', () => {
  let backend: FakeTerminalBackend;
  let taskStore: TaskStore;

  beforeEach(() => {
    backend = new FakeTerminalBackend();
    taskStore = new TaskStore();
    mockGetGitInfo.mockReset().mockResolvedValue(null);
  });

  test('no model override → argv has no --model', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore);
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--model');
  });

  test('per-task model pin pushes --model <id>', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore);
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, {
      model: 'claude-fable-5',
    });
    const spec = backend.sessions.get(sessionId)!.spec;
    const idx = spec.args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spec.args[idx + 1]).toBe('claude-fable-5');
  });

  test('model and effort can both be present', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore);
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, {
      model: 'claude-fable-5',
      effort: 'max',
    });
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('claude-fable-5');
    expect(spec.args[spec.args.indexOf('--effort') + 1]).toBe('max');
  });

  test('an invalid model is skipped (defensive guard), not passed', async () => {
    const adapter = new ClaudeCodeAdapter(backend, taskStore);
    const task = taskStore.createTask('Fix bug', '/cwd');
    const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd', undefined, {
      model: 'not-a-model',
    });
    const spec = backend.sessions.get(sessionId)!.spec;
    expect(spec.args).not.toContain('--model');
  });

  describe('preflight', () => {
    test('reports the extracted version and --version probe path when --version succeeds', async () => {
      const probeExec: ProbeExecRunner = async (_file, args) => {
        if (args.join(' ') === '--version') return { stdout: '2.1.220 (Claude Code)\n', stderr: '' };
        throw new Error(`unexpected probe: ${args.join(' ')}`);
      };
      const pfAdapter = new ClaudeCodeAdapter(backend, taskStore, { probeExec });
      const result = await pfAdapter.preflight();
      expect(result).toMatchObject({ kind: 'ok', version: '2.1.220', probePath: '--version' });
    });

    test('reports unknown (never usage text) and --help path when --version fails and --help is usage text', async () => {
      const probeExec: ProbeExecRunner = async (_file, args) => {
        if (args.join(' ') === '--version') throw Object.assign(new Error('cold'), { code: 'ETIMEDOUT' });
        return { stdout: 'Usage: claude [options] [command] [prompt]\n', stderr: '' };
      };
      const pfAdapter = new ClaudeCodeAdapter(backend, taskStore, { probeExec });
      const result = await pfAdapter.preflight();
      expect(result).toMatchObject({ kind: 'ok', version: 'unknown', probePath: '--help' });
      if (result.kind === 'ok') expect(result.version).not.toContain('Usage');
    });
  });
});
