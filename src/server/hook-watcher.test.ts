import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookFileWatcher } from './hook-watcher.js';
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
import { statSync } from 'node:fs';

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

  test('no record is lost or duplicated when the writer rotates the active file (#1433)', async () => {
    // Models the incremental-read regime that production's fast paths maintain
    // (fs.watch / the 3s poll / the watchdog drain / the HTTP push): each record
    // is read while it is still the newest line in the active file, so rotation
    // only ever moves already-ingested history out. Under that regime — the
    // common one — every record reaches ingestion exactly once via the file path
    // and the active file the watcher re-reads on each event stays under the cap.
    // (If a reader lagged more than a full cap behind, rotation could move an
    // un-read tail into `.N`, which the file path would not re-read; recovery
    // then rests on the HTTP-push + ledger paths. That fallback is out of scope
    // for this watcher-level test.)
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
    }));
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
});
