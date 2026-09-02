import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookFileWatcher, selectStaleReplayCheckpointKeys } from './hook-watcher.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { TaskStore } from '../core/tasks.js';
import type { AgentEvent } from '../core/types.js';
import { HookIngestion, type HookEventInjector } from './hook-ingestion.js';
import { createHookParseDegradationEvaluator } from './hook-parse-degradation-rules.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS writer module without bundled types; runtime contract is the public API surface.
import { appendRecord } from '../../bin/kookr-hook-writer.js';

describe('HookFileWatcher', () => {
  let tempDir: string;
  let taskStore: TaskStore;
  let adapter: ClaudeCodeAdapter;
  let watcher: HookFileWatcher;
  let events: AgentEvent[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-hooks-'));
    taskStore = new TaskStore();
    const terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    watcher = new HookFileWatcher(tempDir, adapter);
    events = [];
    adapter.onEvent((_tmux, e) => events.push(e));
  });

  afterEach(() => {
    watcher.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function registerSession(tmuxName: string): void {
    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set(tmuxName, task.id);
    taskStore.addSession(task.id, {
      tmuxSession: tmuxName,
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
  }

  test('isWatching returns false before watch', () => {
    expect(watcher.isWatching('kookr-abc')).toBe(false);
  });

  test('watch starts watching a session', () => {
    // Create the hook file first so watch doesn't need to poll
    writeFileSync(join(tempDir, 'kookr-abc.jsonl'), '');
    watcher.watch('kookr-abc');
    expect(watcher.isWatching('kookr-abc')).toBe(true);
  });

  test('stop removes watcher', () => {
    writeFileSync(join(tempDir, 'kookr-abc.jsonl'), '');
    watcher.watch('kookr-abc');
    watcher.stop('kookr-abc');
    expect(watcher.isWatching('kookr-abc')).toBe(false);
  });

  test('stopAll removes all watchers', () => {
    writeFileSync(join(tempDir, 'kookr-1.jsonl'), '');
    writeFileSync(join(tempDir, 'kookr-2.jsonl'), '');
    watcher.watch('kookr-1');
    watcher.watch('kookr-2');
    watcher.stopAll();
    expect(watcher.isWatching('kookr-1')).toBe(false);
    expect(watcher.isWatching('kookr-2')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Replay-checkpoint prune (issue #2385)
  // ---------------------------------------------------------------------------
  describe('selectStaleReplayCheckpointKeys (issue #2385)', () => {
    const livePath = '/hooks/live.jsonl';
    const missingPath = '/hooks/gone.jsonl';
    const orphanPath = '/hooks/orphan.jsonl';
    const sessions = {
      live: { filePath: livePath },
      gone: { filePath: missingPath },
      orphan: { filePath: orphanPath },
    };
    const existing = new Set([livePath, orphanPath]);
    const fileExists = (p: string) => existing.has(p);

    test('retains live sessions and drops missing-file entries', () => {
      const stale = selectStaleReplayCheckpointKeys({
        sessions,
        retainSessionKeys: new Set(['live']),
        fileExists,
      });
      expect(stale.sort()).toEqual(['gone']);
    });

    test('dropUnwatched also removes non-retained keys whose files still exist', () => {
      const stale = selectStaleReplayCheckpointKeys({
        sessions,
        retainSessionKeys: new Set(['live']),
        fileExists,
        dropUnwatched: true,
      });
      expect(stale.sort()).toEqual(['gone', 'orphan']);
    });

    test('never selects a retained key even when its file is missing', () => {
      const stale = selectStaleReplayCheckpointKeys({
        sessions: { live: { filePath: missingPath } },
        retainSessionKeys: new Set(['live']),
        fileExists,
        dropUnwatched: true,
      });
      expect(stale).toEqual([]);
    });

    test('returns empty when every key is retained', () => {
      const stale = selectStaleReplayCheckpointKeys({
        sessions,
        retainSessionKeys: new Set(['live', 'gone', 'orphan']),
        fileExists,
        dropUnwatched: true,
      });
      expect(stale).toEqual([]);
    });
  });

  test('stop removes the session key from the durable checkpoint map (issue #2385)', async () => {
    const hookFile = join(tempDir, 'kookr-stop-prune.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${event1}\n`);
    registerSession('kookr-stop-prune');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-stop-prune', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(1);
    const before = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(before.sessions['kookr-stop-prune']).toBeDefined();

    watcher.stop('kookr-stop-prune');

    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(0);
    const after = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(after.sessions['kookr-stop-prune']).toBeUndefined();
    expect(Object.keys(after.sessions)).toHaveLength(0);
  });

  test('pruneStaleReplayCheckpoints drops missing-file keys and retains live watches (issue #2385)', async () => {
    const liveHook = join(tempDir, 'kookr-live-prune.jsonl');
    const goneHook = join(tempDir, 'kookr-gone-prune.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints-sweep.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(liveHook, `${event1}\n`);
    writeFileSync(goneHook, `${event1}\n`);
    registerSession('kookr-live-prune');
    registerSession('kookr-gone-prune');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-live-prune', { replayExisting: true, useReplayCheckpoint: true });
    watcher.watch('kookr-gone-prune', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(2);

    // Simulate maintenance prune deleting the gone session's hook file while
    // the watcher is still tracking live only (unwatch gone first without
    // stop() so the durable key would otherwise linger, then delete the file).
    watcher['offsets'].delete('kookr-gone-prune');
    watcher['watchers'].get('kookr-gone-prune')?.close();
    watcher['watchers'].delete('kookr-gone-prune');
    const gonePoll = watcher['pollIntervals'].get('kookr-gone-prune');
    if (gonePoll) {
      clearInterval(gonePoll);
      watcher['pollIntervals'].delete('kookr-gone-prune');
    }
    rmSync(goneHook, { force: true });

    const pruned = watcher.pruneStaleReplayCheckpoints();
    expect(pruned).toBe(1);
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(1);

    const after = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(after.sessions['kookr-live-prune']).toBeDefined();
    expect(after.sessions['kookr-gone-prune']).toBeUndefined();
  });

  test('constructor missing-file sweep removes orphan keys before watches arm (issue #2385)', () => {
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints-boot.json');
    const missingPath = join(tempDir, 'kookr-already-gone.jsonl');
    writeFileSync(checkpointPath, `${JSON.stringify({
      schemaVersion: 'hook-replay-checkpoints.v1',
      sessions: {
        'kookr-already-gone': {
          filePath: missingPath,
          dev: 1,
          ino: 2,
          sizeBytes: 10,
          offsetChars: 10,
          offsetTail: 'x'.repeat(10),
        },
      },
    })}\n`);
    expect(existsSync(missingPath)).toBe(false);

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(0);
    const after = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(after.sessions['kookr-already-gone']).toBeUndefined();
  });

  test('constructor does not dropUnwatched keys whose hook file still exists (issue #2385)', () => {
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints-boot-retain.json');
    const missingPath = join(tempDir, 'kookr-boot-gone.jsonl');
    const keepPath = join(tempDir, 'kookr-boot-keep.jsonl');
    writeFileSync(keepPath, '{}\n');
    writeFileSync(checkpointPath, `${JSON.stringify({
      schemaVersion: 'hook-replay-checkpoints.v1',
      sessions: {
        'kookr-boot-gone': {
          filePath: missingPath,
          dev: 1,
          ino: 2,
          sizeBytes: 10,
          offsetChars: 10,
          offsetTail: 'x'.repeat(10),
        },
        'kookr-boot-keep': {
          filePath: keepPath,
          dev: 1,
          ino: 3,
          sizeBytes: 3,
          offsetChars: 3,
          offsetTail: '{}\n',
        },
      },
    })}\n`);

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(1);
    const after = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(after.sessions['kookr-boot-gone']).toBeUndefined();
    expect(after.sessions['kookr-boot-keep']).toBeDefined();
  });

  test('stopAll preserves durable checkpoints for restart resume (issue #2385)', async () => {
    const hookFile = join(tempDir, 'kookr-stopall-keep.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints-stopall.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${event1}\n`);
    registerSession('kookr-stopall-keep');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-stopall-keep', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(1);

    watcher.stopAll();
    expect(watcher.isWatching('kookr-stopall-keep')).toBe(false);
    // Durable map and file must retain the key so a process restart can resume.
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(1);
    const after = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(after.sessions['kookr-stopall-keep']).toBeDefined();
  });

  test('pruneStaleReplayCheckpoints dropUnwatched removes non-watched keys with files present (issue #2385)', async () => {
    const liveHook = join(tempDir, 'kookr-drop-live.jsonl');
    const orphanHook = join(tempDir, 'kookr-drop-orphan.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints-drop-unwatched.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(liveHook, `${event1}\n`);
    writeFileSync(orphanHook, `${event1}\n`);
    registerSession('kookr-drop-live');
    registerSession('kookr-drop-orphan');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-drop-live', { replayExisting: true, useReplayCheckpoint: true });
    watcher.watch('kookr-drop-orphan', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(2);

    // Unwatch orphan without stop() so the durable key remains, file still present.
    watcher['offsets'].delete('kookr-drop-orphan');
    watcher['watchers'].get('kookr-drop-orphan')?.close();
    watcher['watchers'].delete('kookr-drop-orphan');
    const orphanPoll = watcher['pollIntervals'].get('kookr-drop-orphan');
    if (orphanPoll) {
      clearInterval(orphanPoll);
      watcher['pollIntervals'].delete('kookr-drop-orphan');
    }
    expect(existsSync(orphanHook)).toBe(true);

    const pruned = watcher.pruneStaleReplayCheckpoints({ dropUnwatched: true });
    expect(pruned).toBe(1);
    expect(watcher.getReplayCheckpointStats()?.sessionCount).toBe(1);
    const after = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(after.sessions['kookr-drop-live']).toBeDefined();
    expect(after.sessions['kookr-drop-orphan']).toBeUndefined();
  });

  test('detects new lines appended to hook file', async () => {
    const hookFile = join(tempDir, 'kookr-abc.jsonl');
    writeFileSync(hookFile, '');

    // Register the tmux name with the adapter so injectHookEvent works
    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-abc', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-abc',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    watcher.watch('kookr-abc');

    // Append a hook event
    const hookJson = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'claude-sonnet-4-20250514',
    });
    appendFileSync(hookFile, hookJson + '\n');

    // fs.watch is platform-dependent (unreliable on WSL2).
    // Poll until event arrives or timeout.
    const deadline = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // On WSL2, fs.watch may not fire for appends. Skip assertion if so.
    if (events.length === 0) {
      console.warn('SKIPPED: fs.watch did not detect file change (likely WSL2)');
      return;
    }

    expect(events[0].type).toBe('session_start');
  });

  test('replayExisting=true replays existing content on watch', async () => {
    const hookFile = join(tempDir, 'kookr-replay.jsonl');

    // Pre-populate file with events before watching
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'claude-sonnet-4-20250514',
    });
    const event2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      permission_mode: 'acceptEdits',
    });
    writeFileSync(hookFile, event1 + '\n' + event2 + '\n');

    // Register so injectHookEvent works
    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-replay', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-replay',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    // Watch with replay — should immediately read existing events
    watcher.watch('kookr-replay', { replayExisting: true });

    // readNewLines is async, wait briefly
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(2);
    expect(events[0].type).toBe('session_start');
    expect(events[1].type).toBe('tool_use');
  });

  test('replayExisting=true resumes from a matching replay checkpoint', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');

    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'claude-sonnet-4-20250514',
    });
    const event2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      permission_mode: 'acceptEdits',
    });
    writeFileSync(hookFile, `${event1}\n${event2}\n`);

    registerSession('kookr-checkpoint');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    expect(events.map((event) => event.type)).toEqual(['session_start', 'tool_use']);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as {
      sessions: Record<string, { offsetChars: number }>;
    };
    expect(checkpoint.sessions['kookr-checkpoint'].offsetChars).toBe(`${event1}\n${event2}\n`.length);

    watcher.stopAll();
    events = [];
    const event3 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout: 'ok' },
    });
    appendFileSync(hookFile, `${event3}\n`);

    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect(watcher.getOffset('kookr-checkpoint')).toBe(`${event1}\n${event2}\n${event3}\n`.length);
  });

  test('replay checkpoint invalidates when the hook file is truncated', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint-trunc.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');

    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      note: 'x'.repeat(400),
    });
    const event2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    });
    writeFileSync(hookFile, `${event1}\n${event2}\n`);

    registerSession('kookr-checkpoint-trunc');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-trunc', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(2);

    watcher.stopAll();
    events = [];
    const event3 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'Notification',
      message: 'fresh shorter file',
    });
    writeFileSync(hookFile, `${event3}\n`);

    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-trunc', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('notification');
    expect(watcher.getOffset('kookr-checkpoint-trunc')).toBe(`${event3}\n`.length);
  });

  test('replay checkpoint invalidates when the hook file truncates and regrows past the old offset', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint-regrow.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');

    const oldEvent = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      note: 'old'.repeat(200),
    });
    writeFileSync(hookFile, `${oldEvent}\n`);
    registerSession('kookr-checkpoint-regrow');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-regrow', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(1);

    watcher.stopAll();
    events = [];
    const newEvent1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'Notification',
      message: 'fresh after truncate',
    });
    const newEvent2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'true' },
      note: 'new'.repeat(300),
    });
    writeFileSync(hookFile, `${newEvent1}\n${newEvent2}\n`);
    expect(`${newEvent1}\n${newEvent2}\n`.length).toBeGreaterThan(`${oldEvent}\n`.length);

    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-regrow', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    expect(events.map((event) => event.type)).toEqual(['notification', 'tool_use']);
  });

  test('replay checkpoint falls back to offset zero when the checkpoint file is invalid', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint-invalid.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${event1}\n`);
    writeFileSync(checkpointPath, 'not json');

    registerSession('kookr-checkpoint-invalid');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-invalid', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_start');
    expect(watcher.getOffset('kookr-checkpoint-invalid')).toBe(`${event1}\n`.length);
  });

  // ---------------------------------------------------------------------------
  // getReplayCheckpointStats (issue #2281)
  // ---------------------------------------------------------------------------
  test('getReplayCheckpointStats returns null when checkpoints are disabled', () => {
    // Default constructor leaves replayCheckpointPath unset.
    expect(watcher.getReplayCheckpointStats()).toBeNull();
  });

  test('getReplayCheckpointStats reports zero fileBytes when the checkpoint file is missing', () => {
    const checkpointPath = join(tempDir, 'missing-hook-replay-checkpoints.json');
    expect(existsSync(checkpointPath)).toBe(false);
    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    expect(watcher.getReplayCheckpointStats()).toEqual({
      sessionCount: 0,
      fileBytes: 0,
    });
  });

  test('getReplayCheckpointStats uses in-memory session count and stat size (issue #2281)', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint-stats.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${event1}\n`);
    registerSession('kookr-checkpoint-stats');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-stats', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    const stats = watcher.getReplayCheckpointStats();
    expect(stats).not.toBeNull();
    expect(stats!.sessionCount).toBe(1);
    expect(stats!.fileBytes).toBe(statSync(checkpointPath).size);
    expect(stats!.fileBytes).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Compact checkpoint serialize (issue #2298)
  // ---------------------------------------------------------------------------
  test('writeReplayCheckpoint emits compact JSON smaller than pretty form (issue #2298)', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint-compact.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${event1}\n`);
    registerSession('kookr-checkpoint-compact');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-compact', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    const raw = readFileSync(checkpointPath, 'utf-8');
    const parsed = JSON.parse(raw) as { sessions: Record<string, unknown> };
    expect(parsed.sessions['kookr-checkpoint-compact']).toBeDefined();

    // Compact form: single-line body (optional trailing newline only).
    expect(raw.trimEnd()).not.toMatch(/\n\s+/);
    const compactBytes = Buffer.byteLength(raw, 'utf-8');
    const prettyBytes = Buffer.byteLength(`${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    expect(compactBytes).toBeLessThan(prettyBytes);
    expect(raw).toBe(`${JSON.stringify(parsed)}\n`);
  });

  // ---------------------------------------------------------------------------
  // Checkpoint file mode (issue #2365)
  // ---------------------------------------------------------------------------
  test('writeReplayCheckpoint creates the durable file with mode 0o600 (issue #2365)', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint-mode.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${event1}\n`);
    registerSession('kookr-checkpoint-mode');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-mode', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    expect(existsSync(checkpointPath)).toBe(true);
    const mode = statSync(checkpointPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('startup replay malformed records stay quiet but later live malformed records alert once', async () => {
    const hookFile = join(tempDir, 'kookr-startup-replay.jsonl');
    writeFileSync(hookFile, '{"old":true}\n');
    const alerts: Array<Extract<ServerMessage, { type: 'alert' }>> = [];
    const queue = new AttentionQueue();
    const evaluator = createHookParseDegradationEvaluator();
    const malformedAdapter: HookEventInjector = {
      injectHookEvent(_tmux, _raw, sequence, options) {
        return {
          parseStatus: 'malformed',
          agentType: 'claude-code',
          error: 'bad hook record',
          sequence: sequence ?? 0,
          origin: options?.origin,
        };
      },
    };
    const ingestion = new HookIngestion({
      adapter: malformedAdapter,
      now: () => Date.parse('2026-06-11T10:00:00.000Z'),
      onParseDegradation: (event) => {
        const evaluation = evaluator.evaluate(event);
        if (!evaluation) return;
        queue.enqueue(event.kookrSessionId, evaluation.anomaly);
        alerts.push(evaluation.alert);
      },
    });
    const optionWatcher = new HookFileWatcher(tempDir, ingestion);

    try {
      optionWatcher.watch('kookr-startup-replay', {
        replayExisting: true,
        suppressParseAlertsForExisting: true,
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(alerts).toEqual([]);
      expect(queue.peek('kookr-startup-replay')).toBeNull();
      expect(ingestion.getActivityMeta('kookr-startup-replay')?.malformedRecordCount).toBe(1);

      appendFileSync(hookFile, '{"live":true}\n');
      await optionWatcher.drainNow('kookr-startup-replay');

      expect(alerts).toHaveLength(1);
      expect(alerts[0].details).toContain('{"live":true}');
      expect(alerts[0].details).toContain('Event: evt_');
      const alertEventId = alerts[0].details.match(/Event: (evt_[^ ]+)/)?.[1];
      expect(alertEventId).toBeDefined();
      expect(queue.peek('kookr-startup-replay')).toMatchObject({
        type: 'hook_parse_degraded',
        eventId: alertEventId,
      });

      appendFileSync(hookFile, '{"live":2}\n');
      await optionWatcher.drainNow('kookr-startup-replay');

      expect(alerts).toHaveLength(1);
      expect(queue.peek('kookr-startup-replay')?.type).toBe('hook_parse_degraded');
      expect(ingestion.getActivityMeta('kookr-startup-replay')?.malformedRecordCount).toBe(3);
    } finally {
      optionWatcher.stopAll();
    }
  });

  test('replayExisting=true replays concatenated hook records', async () => {
    const hookFile = join(tempDir, 'kookr-concat.jsonl');

    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      model: 'claude-sonnet-4-20250514',
    });
    const event2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      permission_mode: 'acceptEdits',
    });
    writeFileSync(hookFile, event1 + event2);

    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-concat', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-concat',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    watcher.watch('kookr-concat', { replayExisting: true });

    await new Promise((r) => setTimeout(r, 200));

    expect(events.map((event) => event.type)).toEqual(['session_start', 'tool_use']);
  });

  test('handles malformed hook event lines gracefully', async () => {
    const hookFile = join(tempDir, 'kookr-malformed.jsonl');
    // Write malformed JSON content
    writeFileSync(hookFile, 'not json at all\n{"also bad\n');

    // Register the tmux name
    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-malformed', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-malformed',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    // Watch with replay — should try to parse malformed JSON without crashing
    watcher.watch('kookr-malformed', { replayExisting: true });

    await new Promise((r) => setTimeout(r, 200));

    // Should not crash; no valid events parsed
    expect(events).toHaveLength(0);
  });

  test('polls for non-existent file until it appears', async () => {
    // Watch without creating file first — should enter polling mode
    watcher.watch('kookr-poll');
    expect(watcher.isWatching('kookr-poll')).toBe(true);

    // Create the file after a short delay
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(tempDir, 'kookr-poll.jsonl'), '');

    // Wait for poll cycle (1s interval + buffer)
    await new Promise((r) => setTimeout(r, 1500));

    // Should still be watching after file appeared and re-registered
    expect(watcher.isWatching('kookr-poll')).toBe(true);
  }, 5000);

  test('stopAll cleans up polling sentinels', () => {
    // Watch non-existent file to start polling
    watcher.watch('kookr-sentinel');
    expect(watcher.isWatching('kookr-sentinel')).toBe(true);

    watcher.stopAll();
    expect(watcher.isWatching('kookr-sentinel')).toBe(false);
  });

  test('drainNow is a no-op when session is not registered', async () => {
    // Never called watch() — drainNow should return without touching anything
    await expect(watcher.drainNow('unknown')).resolves.toBeUndefined();
    expect(events.length).toBe(0);
  });

  test('drainNow reads any new lines appended since last offset', async () => {
    const hookFile = join(tempDir, 'kookr-drain.jsonl');
    writeFileSync(hookFile, '');

    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-drain', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-drain',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    watcher.watch('kookr-drain');
    // Baseline offset recorded; no events yet.
    expect(events.length).toBe(0);

    // Append after watch started; rely on drainNow (not fs.watch, which is
    // flaky on WSL2) to deliver the event — this is the exact recovery path
    // the watchdog tick uses.
    const hookJson = JSON.stringify({
      session_id: 'sess-drain',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    appendFileSync(hookFile, hookJson + '\n');

    await watcher.drainNow('kookr-drain');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('session_start');

    // Second drain with no new data should not re-deliver.
    await watcher.drainNow('kookr-drain');
    expect(events.length).toBe(1);
  });

  test('getRetentionMetrics tracks watched sessions and cumulative read volume (#1612)', async () => {
    const hookFile = join(tempDir, 'kookr-mem.jsonl');
    writeFileSync(hookFile, '');
    registerSession('kookr-mem');
    watcher.watch('kookr-mem');

    const initial = watcher.getRetentionMetrics();
    expect(initial.watchedSessions).toBe(1);
    expect(initial.offsets).toBe(1);

    const line = JSON.stringify({
      session_id: 'sess-mem',
      transcript_path: '/t.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    }) + '\n';
    appendFileSync(hookFile, line);
    await watcher.drainNow('kookr-mem');

    const after = watcher.getRetentionMetrics();
    // The whole-file read charged its length to the cumulative counter — the
    // metric that reveals the re-read volume under a soak.
    expect(after.cumulativeReadChars).toBeGreaterThanOrEqual(line.length);
    expect(after.readCount).toBeGreaterThanOrEqual(1);
  });

  test('no record is lost or duplicated when the writer rotates the active file (#1433)', async () => {
    // Models the incremental-read regime that production's fast paths maintain
    // (fs.watch / the 3s poll / the watchdog drain / the HTTP push): each record
    // is read while it is still the newest line in the active file, so rotation
    // only ever moves already-ingested history out. Under that regime — the
    // common one — every record reaches ingestion exactly once via the file path
    // and the active file the watcher re-reads on each event stays under the cap.
    // (The lagging-reader regime — where rotation moves an un-read tail into
    // `<file>.1` — is covered by the dedicated recovery test below, issue #1566.)
    const session = 'kookr-rotate';
    const hookFile = join(tempDir, `${session}.jsonl`);
    writeFileSync(hookFile, '');

    // Use the real HookIngestion (not a mock of the unit under test) so its
    // content-hash dedup would collapse any boundary overlap the rotation's
    // reset-to-0 re-read produced. Clean rotation has no overlap, so dedup is a
    // safety net here rather than load-bearing. The stub adapter parse-oks each
    // record and is only invoked on a first observation (duplicates
    // short-circuit before the adapter call), so `dispatched` counts uniques.
    const dispatched: number[] = [];
    let seq = 0;
    const stub: HookEventInjector = {
      injectHookEvent(_tmux, raw, sequence) {
        dispatched.push((JSON.parse(raw) as { n: number }).n);
        return { parseStatus: 'ok', agentType: 'claude-code', parentage: 'parent', sequence: sequence ?? ++seq };
      },
    };
    const ingestion = new HookIngestion({ adapter: stub });
    const rotatingWatcher = new HookFileWatcher(tempDir, ingestion);
    try {
      rotatingWatcher.watch(session); // tail mode: offset 0 on the empty file

      const cap = 512; // ~120-byte records → rotates every few writes
      const keep = 4;
      const total = 40;
      for (let n = 0; n < total; n += 1) {
        await appendRecord(hookFile, JSON.stringify({ session_id: session, n, pad: 'x'.repeat(90) }), {
          maxBytes: cap,
          keep,
        });
        // Read while the record is still the newest line in the active file —
        // exactly what the incremental production readers guarantee.
        await rotatingWatcher.drainNow(session);
        // The active file the watcher re-reads never exceeds the cap.
        expect(statSync(hookFile).size).toBeLessThanOrEqual(cap);
      }

      // Rotation actually happened during the run.
      expect(statSync(`${hookFile}.1`).size).toBeGreaterThan(0);
      // Every record reached ingestion exactly once — no loss, no duplicate.
      expect(dispatched.slice().sort((a, b) => a - b)).toEqual(
        Array.from({ length: total }, (_v, i) => i),
      );
    } finally {
      rotatingWatcher.stopAll();
    }
  });

  // INV-1 (no silent skip): a live reader that lags more than a full cap behind
  // recovers the un-read tail the writer rotation moved into `<file>.1`, so every
  // appended record still reaches ingestion — issue #1566, the residual of #1433.
  test('recovers the un-read tail a writer rotation moved into <file>.1 (#1566)', async () => {
    const session = 'kookr-rotate-lag';
    const hookFile = join(tempDir, `${session}.jsonl`);
    writeFileSync(hookFile, '');

    const dispatched: number[] = [];
    let seq = 0;
    const stub: HookEventInjector = {
      injectHookEvent(_tmux, raw, sequence) {
        dispatched.push((JSON.parse(raw) as { n: number }).n);
        return { parseStatus: 'ok', agentType: 'claude-code', parentage: 'parent', sequence: sequence ?? ++seq };
      },
    };
    const ingestion = new HookIngestion({ adapter: stub });
    const laggingWatcher = new HookFileWatcher(tempDir, ingestion);
    const cap = 400;
    const rec = (n: number): string => JSON.stringify({ session_id: session, n, pad: 'x'.repeat(90) });

    // Consume record 0, recording the active file's inode + a non-zero offset,
    // WITHOUT starting fs.watch/poll — so the lag set up below is deterministic
    // and never raced by a background read. Reaching into private state mirrors
    // the adapter['tmuxToTaskId'] pattern used throughout this suite.
    await appendRecord(hookFile, rec(0), { maxBytes: cap, keep: 4 });
    laggingWatcher['offsets'].set(session, readFileSync(hookFile, 'utf-8').length);
    laggingWatcher['inodes'].set(session, statSync(hookFile).ino);

    try {
      // Lag: append (no draining) until the first rotation appears. `<file>.1`
      // then holds records the reader never saw, and the fresh `<file>` holds
      // the record that triggered the rotation.
      const appended: number[] = [];
      let n = 0;
      while (!existsSync(`${hookFile}.1`)) {
        n += 1;
        await appendRecord(hookFile, rec(n), { maxBytes: cap, keep: 4 });
        appended.push(n);
      }
      // Guard the single-rotation regime this test asserts against: a second
      // rotation would age record 1's generation past `.1`, out of recovery range.
      expect(existsSync(`${hookFile}.2`)).toBe(false);
      expect(appended.length).toBeGreaterThan(1); // at least one record is in the rotated tail

      // A single drain must recover EVERY lagged record — the tail in `.1` plus
      // the fresh active file — with none silently skipped.
      await laggingWatcher.drainNow(session);
      expect(dispatched.slice().sort((a, b) => a - b)).toEqual(appended);

      // The recovery is surfaced for operators, not silent.
      const health = laggingWatcher.getHealthSnapshot().sessions.find((s) => s.tmuxName === session);
      expect(health?.rotatedTailRecoveredCount).toBeGreaterThan(0);
    } finally {
      laggingWatcher.stopAll();
    }
  });

  // INV-2 (rotation vs truncation): an in-place truncation keeps the inode, so a
  // leftover generation from an EARLIER rotation must NOT be re-read — otherwise a
  // plain truncate would replay stale history as phantom events (issue #1566).
  test('does not re-read a stale <file>.1 on an in-place truncation', async () => {
    const session = 'kookr-trunc-stale';
    const hookFile = join(tempDir, `${session}.jsonl`);
    writeFileSync(hookFile, '');

    const dispatched: string[] = [];
    let seq = 0;
    const stub: HookEventInjector = {
      injectHookEvent(_tmux, raw, sequence) {
        dispatched.push((JSON.parse(raw) as { tag: string }).tag);
        return { parseStatus: 'ok', agentType: 'claude-code', parentage: 'parent', sequence: sequence ?? ++seq };
      },
    };
    const w = new HookFileWatcher(tempDir, new HookIngestion({ adapter: stub }));

    // A stale rotated generation sits on disk (already drained by a prior read).
    writeFileSync(`${hookFile}.1`, `${JSON.stringify({ tag: 'stale-from-old-rotation' })}\n`);
    // The active file was read to a non-zero offset; its inode is recorded and
    // matches the current file (NO rotation happened for this file).
    const big = `${JSON.stringify({ tag: 'live', pad: 'x'.repeat(300) })}\n`;
    writeFileSync(hookFile, big);
    w['offsets'].set(session, big.length);
    w['inodes'].set(session, statSync(hookFile).ino);

    try {
      // In-place truncate-and-replace with shorter content: same inode, smaller
      // than the offset → the shrink branch fires but must be classified as a
      // truncation, so the stale `.1` is left untouched.
      const fresh = `${JSON.stringify({ tag: 'post-truncate' })}\n`;
      writeFileSync(hookFile, fresh);
      expect(fresh.length).toBeLessThan(big.length);
      expect(statSync(hookFile).ino).toBe(w['inodes'].get(session)); // in-place → inode unchanged

      await w.drainNow(session);
      // Only the fresh record — never the stale `.1` content.
      expect(dispatched).toEqual(['post-truncate']);
      const health = w.getHealthSnapshot().sessions.find((s) => s.tmuxName === session);
      expect(health?.rotatedTailRecoveredCount ?? 0).toBe(0);
    } finally {
      w.stopAll();
    }
  });

  // INV-4 (replay-checkpoint invalidates across rotation): after a rotation the
  // active file is a fresh inode, so a restart's replay checkpoint (dev/ino match)
  // invalidates and replays the fresh file from offset 0 — never resuming a stale
  // offset into unrelated bytes (issue #1566; same contract as the truncation
  // invalidation tests above).
  test('replay checkpoint invalidates when the hook file is rotated', async () => {
    const hookFile = join(tempDir, 'kookr-checkpoint-rotate.jsonl');
    const checkpointPath = join(tempDir, 'hook-replay-checkpoints.json');

    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      note: 'x'.repeat(400),
    });
    writeFileSync(hookFile, `${event1}\n`);
    registerSession('kookr-checkpoint-rotate');

    watcher.stopAll();
    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-rotate', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(1);

    watcher.stopAll();
    events = [];

    // Rotate the way the writer does: rename the active file out to `.1`, then
    // create a brand-new active file (new inode) with a later record.
    renameSync(hookFile, `${hookFile}.1`);
    const event2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'Notification',
      message: 'fresh generation after rotation',
    });
    writeFileSync(hookFile, `${event2}\n`);

    watcher = new HookFileWatcher(tempDir, adapter, { replayCheckpointPath: checkpointPath });
    watcher.watch('kookr-checkpoint-rotate', { replayExisting: true, useReplayCheckpoint: true });
    await new Promise((r) => setTimeout(r, 200));

    // Inode mismatch invalidates the checkpoint → replay the fresh file from 0,
    // not from the stale offset. Exactly the post-rotation record, no phantom.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('notification');
    expect(watcher.getOffset('kookr-checkpoint-rotate')).toBe(`${event2}\n`.length);
  });

  test('health snapshot reports watcher mode, replay records, and drain latency', async () => {
    const hookFile = join(tempDir, 'kookr-health.jsonl');
    const sessionStart = JSON.stringify({
      session_id: 'health-sess',
      transcript_path: '/health.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${sessionStart}\n`);

    const task = taskStore.createTask('Health', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-health', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-health',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    watcher.watch('kookr-health', { replayExisting: true });
    await new Promise((r) => setTimeout(r, 200));
    await watcher.drainNow('kookr-health');

    const snapshot = watcher.getHealthSnapshot();
    expect(snapshot).toEqual(expect.objectContaining({
      schemaVersion: 'hook-watcher-health.v1',
      sessionCount: 1,
    }));
    expect(snapshot.sessions[0]).toEqual(expect.objectContaining({
      tmuxName: 'kookr-health',
      mode: 'fs_watch',
      pollBackupActive: true,
      replayExisting: true,
      readCount: expect.any(Number),
      recordCount: 1,
      replayRecordCount: 1,
      drainNowCount: 1,
      lastDrainLatencyMs: expect.any(Number),
      maxDrainLatencyMs: expect.any(Number),
      p95DrainLatencyMs: expect.any(Number),
      lastReadAt: expect.any(String),
      lastError: null,
      errorCount: 0,
      lastErrorAt: null,
      lastRecoveredAt: null,
    }));
  });

  test('clears a recovered watcher error after a healthy read but retains cumulative history (#2811)', async () => {
    // An adapter that throws on records carrying the failure marker and
    // succeeds otherwise. A throwing injectHookEvent drives recordHealthError,
    // exactly the error path that used to leave a stale `lastError` stuck on a
    // watcher that had since resumed reading (issue #2811).
    const FAIL = 'FAIL_MARKER';
    const flakyAdapter: HookEventInjector = {
      injectHookEvent(_tmux, raw) {
        if (raw.includes(FAIL)) throw new Error('boom parse error');
        return { parseStatus: 'ok', agentType: 'claude-code', parentage: 'parent', sequence: 0 };
      },
    };
    const w = new HookFileWatcher(tempDir, flakyAdapter);
    const session = 'kookr-recover';
    const hookFile = join(tempDir, `${session}.jsonl`);
    writeFileSync(hookFile, '');

    const health = () => w.getHealthSnapshot().sessions.find((s) => s.tmuxName === session)!;

    try {
      w.watch(session);

      // 1) A record that makes the adapter throw records the current error and
      //    starts the cumulative count; no recovery has happened yet.
      appendFileSync(hookFile, `${JSON.stringify({ marker: FAIL })}\n`);
      await w.drainNow(session);
      expect(health().lastError).toContain('boom');
      expect(health().errorCount).toBe(1);
      expect(health().lastErrorAt).toEqual(expect.any(String));
      expect(health().lastRecoveredAt).toBeNull();
      const firstErrorAt = health().lastErrorAt;

      // 2) A clean record is a proven healthy read: the current error clears and
      //    the recovery is timestamped, but errorCount and lastErrorAt are
      //    retained for history (only lastError is nulled).
      appendFileSync(hookFile, `${JSON.stringify({ hook_event_name: 'SessionStart' })}\n`);
      await w.drainNow(session);
      expect(health().lastError).toBeNull();
      expect(health().errorCount).toBe(1);
      expect(health().lastErrorAt).toBe(firstErrorAt); // history retained across the clear
      expect(health().lastRecoveredAt).toEqual(expect.any(String));

      // 3) A recurring failure after recovery stays visible: lastError re-sets
      //    and the cumulative count advances (partial/flapping watcher signal).
      const recoveredAt = health().lastRecoveredAt;
      appendFileSync(hookFile, `${JSON.stringify({ marker: FAIL })}\n`);
      await w.drainNow(session);
      expect(health().lastError).toContain('boom');
      expect(health().errorCount).toBe(2);
      expect(health().lastRecoveredAt).toBe(recoveredAt); // unchanged — no clear this read
    } finally {
      w.stopAll();
    }
  });

  test('a no-growth drain does not clear a stale watcher error (only a real read proves health, #2811)', async () => {
    // Guards the stat-first early return: a drain that finds no new bytes is not
    // proof of health, so it must NOT clear a recorded error. Without this the
    // "proven healthy read" contract would be an empty read away from a false
    // recovery.
    const FAIL = 'FAIL_MARKER';
    const flakyAdapter: HookEventInjector = {
      injectHookEvent(_tmux, raw) {
        if (raw.includes(FAIL)) throw new Error('boom parse error');
        return { parseStatus: 'ok', agentType: 'claude-code', parentage: 'parent', sequence: 0 };
      },
    };
    const w = new HookFileWatcher(tempDir, flakyAdapter);
    const session = 'kookr-nogrowth';
    const hookFile = join(tempDir, `${session}.jsonl`);
    writeFileSync(hookFile, '');
    const health = () => w.getHealthSnapshot().sessions.find((s) => s.tmuxName === session)!;

    try {
      w.watch(session);

      // Record an error via a failing record.
      appendFileSync(hookFile, `${JSON.stringify({ marker: FAIL })}\n`);
      await w.drainNow(session);
      expect(health().lastError).toContain('boom');
      expect(health().lastRecoveredAt).toBeNull();

      // Drain again with no new bytes appended: the stat-first guard returns
      // before any clear, so the stale error and its null recovery persist.
      await w.drainNow(session);
      expect(health().lastError).toContain('boom');
      expect(health().errorCount).toBe(1);
      expect(health().lastRecoveredAt).toBeNull();
    } finally {
      w.stopAll();
    }
  });

  test('health snapshot reports poll-until-exists mode before a missing hook file appears', () => {
    watcher.watch('kookr-missing-health');

    const snapshot = watcher.getHealthSnapshot();
    expect(snapshot.sessions[0]).toEqual(expect.objectContaining({
      tmuxName: 'kookr-missing-health',
      mode: 'poll_until_exists',
      pollBackupActive: false,
      lastTransitionReason: 'watch_file_missing',
    }));
  });

  test('forwards file mtime metadata to the ingestion adapter', async () => {
    const hookFile = join(tempDir, 'kookr-mtime.jsonl');
    const raw = JSON.stringify({
      session_id: 'mtime-sess',
      transcript_path: '/mtime.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, `${raw}\n`);

    const calls: Array<Parameters<HookEventInjector['injectHookEvent']>> = [];
    const captureAdapter: HookEventInjector = {
      injectHookEvent(...args) {
        calls.push(args);
        return {
          parseStatus: 'ok',
          agentType: 'claude-code',
          parentage: 'parent',
          sequence: args[2] ?? 0,
        };
      },
    };
    const mtimeWatcher = new HookFileWatcher(tempDir, captureAdapter);

    try {
      mtimeWatcher.watch('kookr-mtime', { replayExisting: true });
      await new Promise((r) => setTimeout(r, 200));

      expect(calls).toHaveLength(1);
      expect(calls[0][3]).toEqual(expect.objectContaining({
        fileMtimeMs: expect.any(Number),
      }));
    } finally {
      mtimeWatcher.stopAll();
    }
  });

  test('replayExisting=true is preserved when file appears after watch (pollUntilExists path)', async () => {
    // Regression for the Ralph iteration stall:
    //
    // adapter.launch returns the tmuxName, then registerNewAgent calls
    // hookWatcher.watch(tmuxName, { replayExisting: true }). At that
    // moment the agent process has been spawned but may not have written
    // its first hook yet, so the JSONL file does not exist and fs.watch
    // throws ENOENT. The catch branch falls back to pollUntilExists.
    //
    // Before the fix, pollUntilExists called this.watch(tmuxName) with no
    // options when the file appeared — so the retry used the default
    // replayExisting=false, which seeks past every line already written.
    // The agent's SessionStart line had already been written by then, so
    // it was permanently skipped: SessionInfo.claudeSessionId stayed null,
    // which used to break Ralph's three-ref Stop gate. The owner gate is now
    // terminal-session-only, but replaying the initial hook is still required
    // for transcript tracking and runtime metadata.
    const hookFile = join(tempDir, 'kookr-late.jsonl');

    // Register the tmux name so injectHookEvent can find a task.
    const task = taskStore.createTask('Looped', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-late', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-late',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    // Watch BEFORE the file exists — exactly the production race.
    watcher.watch('kookr-late', { replayExisting: true });
    expect(watcher.isWatching('kookr-late')).toBe(true);

    // Now the agent emits its first hook: file appears, carrying
    // SessionStart. pollUntilExists must pick this up and force a
    // replay-from-zero, not skip past the existing content.
    const sessionStart = JSON.stringify({
      session_id: 'late-sess',
      transcript_path: '/late.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-4-7[1m]',
    });
    writeFileSync(hookFile, sessionStart + '\n');

    // pollUntilExists polls every 1s. CI parallelism + slow disks can
    // stretch a single tick well past 1s, so give it ~5s of budget plus a
    // matching per-test timeout — same shape as 'polls for non-existent
    // file until it appears' below.
    const deadline = Date.now() + 5000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Exactly one SessionStart line was written, so exactly one event
    // should arrive. A looser `>= 1` assertion would let a future bug
    // that double-replays slip through.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_start');

    // End-to-end: SessionInfo should have been updated with the runtime
    // session id and transcript path.
    const session = taskStore.getTask(task.id)!.sessions.find((s) => s.tmuxSession === 'kookr-late')!;
    expect(session.claudeSessionId).toBe('late-sess');
    expect(session.transcriptPath).toBe('/late.jsonl');
  }, 6000);

  test('replayExisting=false (default) is also preserved through pollUntilExists', async () => {
    // Symmetric coverage to the test above: the fix must thread the flag
    // through correctly in both directions, not just for the replay-true
    // path. A pre-existing line that landed before the file appeared
    // must NOT be replayed when the original watch() opted out of replay.
    const hookFile = join(tempDir, 'kookr-late-skip.jsonl');
    const task = taskStore.createTask('Unlooped', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-late-skip', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-late-skip',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    // Watch without replay — the production-default for the non-Ralph path.
    watcher.watch('kookr-late-skip');
    expect(watcher.isWatching('kookr-late-skip')).toBe(true);

    writeFileSync(hookFile, JSON.stringify({
      session_id: 'sess-x',
      transcript_path: '/x.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    }) + '\n');

    // Same 5s budget — long enough for at least 4 poll cycles.
    await new Promise((r) => setTimeout(r, 5000));

    expect(events).toHaveLength(0);
  }, 6000);

  test('recovers from truncation: resets offset and ingests post-truncation events (issue #703)', async () => {
    const hookFile = join(tempDir, 'kookr-trunc.jsonl');
    writeFileSync(hookFile, '');

    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-trunc', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-trunc',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    watcher.watch('kookr-trunc');

    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    appendFileSync(hookFile, event1 + '\n');
    await watcher.drainNow('kookr-trunc');
    expect(events.length).toBe(1);
    const advancedOffset = watcher.getOffset('kookr-trunc')!;
    expect(advancedOffset).toBeGreaterThan(0);

    // Truncate the file out from under the watcher (clear / rotate). Without
    // recovery the stale offset would sit past EOF forever and every later
    // record would be silently sliced away.
    writeFileSync(hookFile, '');
    await watcher.drainNow('kookr-trunc');
    // Offset must have been reset to 0; no spurious re-injection of event1.
    expect(watcher.getOffset('kookr-trunc')).toBe(0);
    expect(events.length).toBe(1);

    // New events on the fresh file are now picked up exactly once.
    const event2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      permission_mode: 'acceptEdits',
    });
    appendFileSync(hookFile, event2 + '\n');
    await watcher.drainNow('kookr-trunc');
    expect(events.length).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['session_start', 'tool_use']);
  });

  test('recovers when the file is replaced in-place with smaller content (issue #703)', async () => {
    const hookFile = join(tempDir, 'kookr-rotate.jsonl');
    writeFileSync(hookFile, '');

    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-rotate', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-rotate',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    watcher.watch('kookr-rotate');

    // A long first record so the offset is comfortably larger than the
    // replacement file — exercises the in-place `content.length < offset`
    // shrink branch without going through an empty intermediate.
    const big = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
      note: 'x'.repeat(500),
    });
    appendFileSync(hookFile, big + '\n');
    await watcher.drainNow('kookr-rotate');
    expect(events.length).toBe(1);
    expect(watcher.getOffset('kookr-rotate')).toBeGreaterThan(500);

    // Replace the whole file with a single shorter record.
    const small = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      permission_mode: 'acceptEdits',
    });
    writeFileSync(hookFile, small + '\n');
    expect(small.length + 1).toBeLessThan(watcher.getOffset('kookr-rotate')!);

    await watcher.drainNow('kookr-rotate');
    // Exactly two events, in order: the reset must not re-emit the original
    // SessionStart as a phantom third event (the test adapter has no dedup).
    expect(events.map((e) => e.type)).toEqual(['session_start', 'tool_use']);
  });

  test('recovers from truncation when content is multibyte (byte/char offset skew, issue #703)', async () => {
    const hookFile = join(tempDir, 'kookr-utf8.jsonl');
    writeFileSync(hookFile, '');

    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-utf8', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-utf8',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    watcher.watch('kookr-utf8');

    // Multibyte payload: byte-length far exceeds char-length, so a recovery
    // that keyed off bytes instead of chars would mis-detect the shrink. The
    // offset advanced here is a CHARACTER count.
    const big = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/项目/🚀/ワークスペース',
      hook_event_name: 'SessionStart',
      note: '日本語'.repeat(200),
    });
    appendFileSync(hookFile, big + '\n');
    await watcher.drainNow('kookr-utf8');
    expect(events.length).toBe(1);

    // Replace in place with a shorter (still multibyte) record.
    const small = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/项目/🚀',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    });
    writeFileSync(hookFile, small + '\n');
    // The replacement is shorter in CHARACTERS than the tracked offset.
    expect(small.length + 1).toBeLessThan(watcher.getOffset('kookr-utf8')!);

    await watcher.drainNow('kookr-utf8');
    expect(events.map((e) => e.type)).toEqual(['session_start', 'tool_use']);
  });

  test('backup poll drives truncation recovery without fs.watch (issue #703)', async () => {
    const pollWatcher = new HookFileWatcher(tempDir, adapter, { pollIntervalMs: 50 });
    const hookFile = join(tempDir, 'kookr-poll-trunc.jsonl');
    writeFileSync(hookFile, '');

    const task = taskStore.createTask('Test', '/cwd');
    adapter['tmuxToTaskId'].set('kookr-poll-trunc', task.id);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-poll-trunc',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });

    try {
      pollWatcher.watch('kookr-poll-trunc');

      const big = JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
        note: 'y'.repeat(500),
      });
      appendFileSync(hookFile, big + '\n');
      await pollWatcher.drainNow('kookr-poll-trunc');
      expect(events.length).toBe(1);

      // Replace with a shorter record and let ONLY the backup poll observe
      // the shrink and recover (no drainNow, no reliance on fs.watch).
      const small = JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/cwd',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      });
      writeFileSync(hookFile, small + '\n');

      const deadline = Date.now() + 3000;
      while (events.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(events.length).toBe(2);
      expect(events[1].type).toBe('tool_use');
    } finally {
      pollWatcher.stopAll();
    }
  }, 6000);

  test('replayExisting=false (default) skips existing content', async () => {
    const hookFile = join(tempDir, 'kookr-skip.jsonl');

    // Pre-populate file
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    writeFileSync(hookFile, event1 + '\n');

    // Watch without replay (default) — should skip existing content
    watcher.watch('kookr-skip');

    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBe(0);
  });

  describe('incremental byte-range reads (issue #1612)', () => {
    function sessionStartPayload(note: string): string {
      return `${JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
        note,
      })}\n`;
    }

    test('stat-first: no-growth drainNow does not re-read the file', async () => {
      const hookFile = join(tempDir, 'kookr-stat-first.jsonl');
      writeFileSync(hookFile, '');
      registerSession('kookr-stat-first');
      watcher.watch('kookr-stat-first');

      const line = sessionStartPayload('baseline');
      appendFileSync(hookFile, line);
      await watcher.drainNow('kookr-stat-first');

      const afterFirst = watcher.getRetentionMetrics();
      expect(afterFirst.readCount).toBe(1);
      expect(afterFirst.cumulativeReadChars).toBe(Buffer.byteLength(line, 'utf-8'));
      expect(events).toHaveLength(1);

      // Unchanged file: repeated drains must be free (the pre-fix whole-file
      // re-read would have counted file_size × N here).
      await watcher.drainNow('kookr-stat-first');
      await watcher.drainNow('kookr-stat-first');
      await watcher.drainNow('kookr-stat-first');

      const afterIdle = watcher.getRetentionMetrics();
      expect(afterIdle.readCount).toBe(afterFirst.readCount);
      expect(afterIdle.cumulativeReadChars).toBe(afterFirst.cumulativeReadChars);
      expect(events).toHaveLength(1);
    });

    test('growth reads only the appended byte range, not the prior corpus', async () => {
      const hookFile = join(tempDir, 'kookr-incr.jsonl');
      writeFileSync(hookFile, '');
      registerSession('kookr-incr');
      watcher.watch('kookr-incr');

      // Build a multi-MB prefix so a whole-file re-read would dominate the meter.
      const prefix = sessionStartPayload('x'.repeat(256 * 1024));
      appendFileSync(hookFile, prefix);
      await watcher.drainNow('kookr-incr');
      const afterPrefix = watcher.getRetentionMetrics();
      expect(afterPrefix.cumulativeReadChars).toBe(Buffer.byteLength(prefix, 'utf-8'));
      expect(events).toHaveLength(1);

      const suffix = `${JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/cwd',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        permission_mode: 'acceptEdits',
      })}\n`;
      appendFileSync(hookFile, suffix);
      await watcher.drainNow('kookr-incr');

      const afterSuffix = watcher.getRetentionMetrics();
      // Exactly one additional read of only the appended bytes.
      expect(afterSuffix.readCount).toBe(afterPrefix.readCount + 1);
      expect(afterSuffix.cumulativeReadChars - afterPrefix.cumulativeReadChars).toBe(
        Buffer.byteLength(suffix, 'utf-8'),
      );
      expect(events.map((e) => e.type)).toEqual(['session_start', 'tool_use']);
    });

    test('multibyte append advances the byte offset (not the char count)', async () => {
      const hookFile = join(tempDir, 'kookr-utf8-incr.jsonl');
      writeFileSync(hookFile, '');
      registerSession('kookr-utf8-incr');
      watcher.watch('kookr-utf8-incr');

      const line = `${JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/项目/🚀/ワークスペース',
        hook_event_name: 'SessionStart',
        note: '日本語'.repeat(50),
      })}\n`;
      const byteLen = Buffer.byteLength(line, 'utf-8');
      expect(byteLen).toBeGreaterThan(line.length); // prove char/byte skew

      appendFileSync(hookFile, line);
      await watcher.drainNow('kookr-utf8-incr');

      expect(watcher.getOffset('kookr-utf8-incr')).toBe(byteLen);
      expect(watcher.getRetentionMetrics().cumulativeReadChars).toBe(byteLen);
      expect(events).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Backup-poll overlap suppression + overrun diagnostics (issue #2776)
  // ---------------------------------------------------------------------------
  describe('backup-poll overlap suppression (issue #2776)', () => {
    // The self-scheduling backup poll and its in-flight guard live behind
    // private members; reach into them the same way the rest of this suite
    // reaches into `pollIntervals`/`offsets`.
    type PollTestHooks = {
      readNewLines: (tmuxName: string, filePath: string, options?: unknown) => Promise<void>;
      runBackupPollTick: (tmuxName: string, filePath: string) => Promise<void>;
      offsets: Map<string, number>;
      pollActive: Set<string>;
      pollIntervals: Map<string, ReturnType<typeof setTimeout>>;
    };
    const priv = (w: HookFileWatcher): PollTestHooks => w as unknown as PollTestHooks;

    const sessionStartLine = (note: string): string =>
      `${JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
        note,
      })}\n`;

    const healthOf = (w: HookFileWatcher, tmuxName: string) =>
      w.getHealthSnapshot().sessions.find((s) => s.tmuxName === tmuxName);

    test('a tick that fires while a prior read is in flight is skipped and counted', async () => {
      const tmuxName = 'kookr-overlap';
      const hookFile = join(tempDir, `${tmuxName}.jsonl`);
      registerSession(tmuxName);
      writeFileSync(hookFile, sessionStartLine('x'));
      priv(watcher).offsets.set(tmuxName, 0); // size > offset ⇒ tick will read

      // Gate the read so the first tick stays in flight while the second fires.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let readCalls = 0;
      priv(watcher).readNewLines = async () => {
        readCalls += 1;
        await gate;
      };

      const first = priv(watcher).runBackupPollTick(tmuxName, hookFile);
      // `runBackupPollTick` sets the in-flight flag synchronously before its
      // first await, so a second call now sees the session busy.
      const second = priv(watcher).runBackupPollTick(tmuxName, hookFile);
      await second; // returns immediately: suppressed, not queued

      expect(healthOf(watcher, tmuxName)?.pollSkippedCount).toBe(1);

      release();
      await first;
      expect(readCalls).toBe(1); // only one read ran despite two ticks
      expect(healthOf(watcher, tmuxName)?.pollSkippedCount).toBe(1);
    });

    test('stop() during an in-flight tick does not re-arm the poll', async () => {
      const tmuxName = 'kookr-stop-race';
      const hookFile = join(tempDir, `${tmuxName}.jsonl`);
      registerSession(tmuxName);
      writeFileSync(hookFile, sessionStartLine('y'));
      priv(watcher).offsets.set(tmuxName, 0);
      priv(watcher).pollActive.add(tmuxName); // simulate an active backup poll

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      priv(watcher).readNewLines = async () => {
        await gate;
      };

      const tick = priv(watcher).runBackupPollTick(tmuxName, hookFile);
      watcher.stop(tmuxName); // deactivate mid-flight
      release();
      await tick; // its finally runs scheduleBackupPoll, which must no-op now

      expect(priv(watcher).pollActive.has(tmuxName)).toBe(false);
      expect(priv(watcher).pollIntervals.has(tmuxName)).toBe(false);
    });

    test('a read slower than the poll interval is recorded as an overrun', async () => {
      const tmuxName = 'kookr-overrun';
      const overrunWatcher = new HookFileWatcher(tempDir, adapter, { pollIntervalMs: 5 });
      const hookFile = join(tempDir, `${tmuxName}.jsonl`);
      registerSession(tmuxName);
      writeFileSync(hookFile, sessionStartLine('z'));
      priv(overrunWatcher).offsets.set(tmuxName, 0);
      priv(overrunWatcher).readNewLines = async () => {
        await new Promise((r) => setTimeout(r, 40)); // > 5ms interval
      };

      try {
        await priv(overrunWatcher).runBackupPollTick(tmuxName, hookFile);
        const health = healthOf(overrunWatcher, tmuxName);
        expect(health?.pollOverrunCount).toBe(1);
        expect(health?.lastPollOverrunMs ?? 0).toBeGreaterThanOrEqual(5);
        expect(health?.maxPollOverrunMs).toBe(health?.lastPollOverrunMs);
        expect(health?.pollSkippedCount).toBe(0);
      } finally {
        overrunWatcher.stopAll();
      }
    }, 6000);

    test('the self-scheduling poll still recovers a truncation it alone observes', async () => {
      const tmuxName = 'kookr-poll-recover';
      const pollWatcher = new HookFileWatcher(tempDir, adapter, { pollIntervalMs: 25 });
      const hookFile = join(tempDir, `${tmuxName}.jsonl`);
      writeFileSync(hookFile, '');
      registerSession(tmuxName);

      try {
        pollWatcher.watch(tmuxName);

        const big = JSON.stringify({
          session_id: 'sess-1',
          transcript_path: '/path/to/transcript.jsonl',
          cwd: '/cwd',
          hook_event_name: 'SessionStart',
          note: 'y'.repeat(500),
        });
        appendFileSync(hookFile, big + '\n');
        await pollWatcher.drainNow(tmuxName);
        expect(events.length).toBe(1);

        // Replace with a shorter record and let ONLY the self-scheduling backup
        // poll observe the shrink and recover (no drainNow, no fs.watch reliance).
        const small = JSON.stringify({
          session_id: 'sess-1',
          transcript_path: '/path/to/transcript.jsonl',
          cwd: '/cwd',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
        });
        writeFileSync(hookFile, small + '\n');

        const deadline = Date.now() + 3000;
        while (events.length < 2 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(events.length).toBe(2);
        expect(events[1].type).toBe('tool_use');
      } finally {
        pollWatcher.stopAll();
      }
    }, 6000);
  });
});
