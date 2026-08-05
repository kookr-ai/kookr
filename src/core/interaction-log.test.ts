import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  InteractionLogWriter,
  DeferredInteractionLogWriter,
  DEFAULT_MAX_DEFERRED_INTERACTION_EVENTS,
  readInteractionLog,
  nowISO,
  isSubstantiveEvent,
  type InteractionEvent,
} from './interaction-log.js';

describe('InteractionLogWriter', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-ilog-'));
    logPath = join(tempDir, 'sessions', 'test-session', 'interactions.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates directories and appends events', async () => {
    const writer = new InteractionLogWriter(logPath);

    const event: InteractionEvent = {
      type: 'user_input',
      agentId: 'agent-1',
      content: 'Fix the bug',
      timestamp: '2026-03-25T10:00:00Z',
    };
    await writer.append(event);

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  test('appends multiple events as separate lines', async () => {
    const writer = new InteractionLogWriter(logPath);

    await writer.append({
      type: 'agent_launched',
      agentId: 'agent-1',
      taskPrompt: 'Fix auth',
      timestamp: '2026-03-25T10:00:00Z',
    });
    await writer.append({
      type: 'user_input',
      agentId: 'agent-1',
      content: 'Try again',
      timestamp: '2026-03-25T10:01:00Z',
    });
    await writer.append({
      type: 'agent_stopped',
      agentId: 'agent-1',
      reason: 'completed',
      timestamp: '2026-03-25T10:02:00Z',
    });

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('agent_launched');
    expect(events[1].type).toBe('user_input');
    expect(events[2].type).toBe('agent_stopped');
  });

  test('getFilePath returns configured path', () => {
    const writer = new InteractionLogWriter(logPath);
    expect(writer.getFilePath()).toBe(logPath);
  });
});

describe('readInteractionLog', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-ilog-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns empty array for missing file', async () => {
    const events = await readInteractionLog(join(tempDir, 'nonexistent.jsonl'));
    expect(events).toEqual([]);
  });

  test('skips malformed lines', async () => {
    const { writeFileSync } = await import('node:fs');
    const logPath = join(tempDir, 'bad.jsonl');
    writeFileSync(
      logPath,
      '{"type":"user_input","agentId":"a1","content":"hi","timestamp":"t1"}\n' +
        'not valid json\n' +
        '{"type":"agent_stopped","agentId":"a1","reason":"completed","timestamp":"t2"}\n',
    );

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('user_input');
    expect(events[1].type).toBe('agent_stopped');
  });

  test('handles empty lines', async () => {
    const { writeFileSync } = await import('node:fs');
    const logPath = join(tempDir, 'empty-lines.jsonl');
    writeFileSync(
      logPath,
      '{"type":"reflect_triggered","timestamp":"t1"}\n\n\n',
    );

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(1);
  });
});

describe('InteractionLogWriter — task lifecycle events', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-ilog-'));
    logPath = join(tempDir, 'sessions', 'lifecycle', 'interactions.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('writes task_completed event', async () => {
    const writer = new InteractionLogWriter(logPath);

    const event: InteractionEvent = {
      type: 'task_completed',
      taskId: 'task-1',
      agentId: 'kookr-abc',
      reason: 'user_marked',
      durationMs: 84200,
      timestamp: '2026-03-27T10:00:00Z',
    };
    await writer.append(event);

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  test('writes task_cancelled event', async () => {
    const writer = new InteractionLogWriter(logPath);

    const event: InteractionEvent = {
      type: 'task_cancelled',
      taskId: 'task-2',
      agentId: 'kookr-xyz',
      reason: 'user_cancelled',
      durationMs: 12300,
      timestamp: '2026-03-27T10:05:00Z',
    };
    await writer.append(event);

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  test('full lifecycle: launch, complete', async () => {
    const writer = new InteractionLogWriter(logPath);

    await writer.append({
      type: 'agent_launched',
      agentId: 'kookr-1',
      taskPrompt: 'Fix bug',
      timestamp: '2026-03-27T10:00:00Z',
    });
    await writer.append({
      type: 'task_completed',
      taskId: 'task-1',
      agentId: 'kookr-1',
      reason: 'user_marked',
      durationMs: 60000,
      timestamp: '2026-03-27T10:01:00Z',
    });

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent_launched');
    expect(events[1].type).toBe('task_completed');
  });

  test('full lifecycle: launch, cancel', async () => {
    const writer = new InteractionLogWriter(logPath);

    await writer.append({
      type: 'agent_launched',
      agentId: 'kookr-2',
      taskPrompt: 'Add feature',
      timestamp: '2026-03-27T10:00:00Z',
    });
    await writer.append({
      type: 'task_cancelled',
      taskId: 'task-2',
      agentId: 'kookr-2',
      reason: 'user_cancelled',
      durationMs: 30000,
      timestamp: '2026-03-27T10:00:30Z',
    });

    const events = await readInteractionLog(logPath);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent_launched');
    expect(events[1].type).toBe('task_cancelled');
  });
});

describe('isSubstantiveEvent', () => {
  test('agent_launched is substantive', () => {
    expect(isSubstantiveEvent({ type: 'agent_launched', agentId: 'a1', taskPrompt: 'p', timestamp: 't' })).toBe(true);
  });

  test('user_input is substantive', () => {
    expect(isSubstantiveEvent({ type: 'user_input', agentId: 'a1', content: 'x', timestamp: 't' })).toBe(true);
  });

  test('finding_skipped is substantive', () => {
    expect(isSubstantiveEvent({ type: 'finding_skipped', agentId: 'a1', anomalyType: 'needs_input', timestamp: 't' })).toBe(true);
  });

  test('finding_snoozed is substantive', () => {
    expect(isSubstantiveEvent({ type: 'finding_snoozed', agentId: 'a1', durationMs: 5000, timestamp: 't' })).toBe(true);
  });

  test('finding_resolved is substantive', () => {
    expect(isSubstantiveEvent({ type: 'finding_resolved', agentId: 'a1', anomalyType: 'needs_input', method: 'input', durationMs: 1000, timestamp: 't' })).toBe(true);
  });

  test('agent_selected is NOT substantive', () => {
    expect(isSubstantiveEvent({ type: 'agent_selected', agentId: 'a1', source: 'manual', timestamp: 't' })).toBe(false);
  });

  test('agent_stopped is NOT substantive', () => {
    expect(isSubstantiveEvent({ type: 'agent_stopped', agentId: 'a1', reason: 'completed', timestamp: 't' })).toBe(false);
  });

  test('reflect_triggered is NOT substantive', () => {
    expect(isSubstantiveEvent({ type: 'reflect_triggered', timestamp: 't' })).toBe(false);
  });

  test('task_completed is NOT substantive', () => {
    expect(isSubstantiveEvent({ type: 'task_completed', taskId: 't1', agentId: 'a1', reason: 'user_marked', durationMs: 1000, timestamp: 't' })).toBe(false);
  });

  test('task_cancelled is NOT substantive', () => {
    expect(isSubstantiveEvent({ type: 'task_cancelled', taskId: 't1', agentId: 'a1', reason: 'user_cancelled', durationMs: 1000, timestamp: 't' })).toBe(false);
  });
});

describe('DeferredInteractionLogWriter', () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-deferred-'));
    sessionsDir = join(tempDir, 'sessions');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('does not create session on non-substantive event', async () => {
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'test-session');

    await writer.append({
      type: 'agent_stopped',
      agentId: 'a1',
      reason: 'completed',
      timestamp: 't1',
    });

    // No session directory should exist
    expect(writer.getFilePath()).toBeNull();
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(sessionsDir, 'test-session'))).toBe(false);
  });

  test('creates session on first substantive event', async () => {
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'test-session');

    await writer.append({
      type: 'agent_launched',
      agentId: 'a1',
      taskPrompt: 'Fix bug',
      timestamp: 't1',
    });

    expect(writer.getFilePath()).toBe(join(sessionsDir, 'test-session', 'interactions.jsonl'));
    const events = await readInteractionLog(writer.getFilePath()!);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_launched');
  });

  test('flushes buffered non-substantive events when session materializes', async () => {
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'test-session');

    // Buffer a non-substantive event
    await writer.append({
      type: 'agent_stopped',
      agentId: 'a1',
      reason: 'completed',
      timestamp: 't1',
    });

    // Trigger materialization with a substantive event
    await writer.append({
      type: 'agent_launched',
      agentId: 'a2',
      taskPrompt: 'New task',
      timestamp: 't2',
    });

    const events = await readInteractionLog(writer.getFilePath()!);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent_stopped');
    expect(events[1].type).toBe('agent_launched');
  });

  test('writes directly after session is materialized', async () => {
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'test-session');

    // Materialize
    await writer.append({ type: 'user_input', agentId: 'a1', content: 'hi', timestamp: 't1' });

    // Subsequent non-substantive events should write directly (not buffer)
    await writer.append({ type: 'agent_stopped', agentId: 'a1', reason: 'completed', timestamp: 't2' });

    const events = await readInteractionLog(writer.getFilePath()!);
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('agent_stopped');
  });

  test('resolves session ID only once', async () => {
    let callCount = 0;
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => {
      callCount++;
      return 'test-session';
    });

    await writer.append({ type: 'agent_launched', agentId: 'a1', taskPrompt: 'p', timestamp: 't1' });
    await writer.append({ type: 'agent_launched', agentId: 'a2', taskPrompt: 'p2', timestamp: 't2' });

    expect(callCount).toBe(1);
  });

  test('resumes existing session when resolveSessionId returns one', async () => {
    // Pre-create a session with existing events
    const existingPath = join(sessionsDir, 'existing-session', 'interactions.jsonl');
    const existingWriter = new InteractionLogWriter(existingPath);
    await existingWriter.append({ type: 'agent_launched', agentId: 'a1', taskPrompt: 'old', timestamp: 't0' });

    // Deferred writer resumes the existing session
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'existing-session');

    await writer.append({ type: 'user_input', agentId: 'a1', content: 'new input', timestamp: 't1' });

    const events = await readInteractionLog(writer.getFilePath()!);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent_launched');
    expect(events[1].type).toBe('user_input');
  });

  test('defaults maxEntries to DEFAULT_MAX_DEFERRED_INTERACTION_EVENTS', () => {
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'test-session');
    expect(writer.getMaxEntries()).toBe(DEFAULT_MAX_DEFERRED_INTERACTION_EVENTS);
  });

  test('buffer length never exceeds configured max; oldest dropped first', async () => {
    const maxEntries = 3;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'test-session', { maxEntries });

    for (let i = 0; i < 5; i++) {
      await writer.append({
        type: 'agent_stopped',
        agentId: `a${i}`,
        reason: 'completed',
        timestamp: `t${i}`,
      });
      expect(writer.getBufferedEventCount()).toBeLessThanOrEqual(maxEntries);
    }

    expect(writer.getBufferedEventCount()).toBe(maxEntries);
    // Overflow warn once per burst
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('buffer overflow');
    expect(warnSpy.mock.calls[0][0]).toContain('maxEntries=3');

    // Further overflow does not re-warn in the same burst
    await writer.append({
      type: 'agent_stopped',
      agentId: 'a5',
      reason: 'completed',
      timestamp: 't5',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(writer.getBufferedEventCount()).toBe(maxEntries);

    // Materialize flushes retained (newest maxEntries) events; oldest were dropped
    await writer.append({
      type: 'agent_launched',
      agentId: 'launch',
      taskPrompt: 'go',
      timestamp: 't-launch',
    });

    expect(writer.getBufferedEventCount()).toBe(0);
    const events = await readInteractionLog(writer.getFilePath()!);
    // 3 retained buffered + 1 substantive launch
    expect(events).toHaveLength(maxEntries + 1);
    // FIFO: after t0..t5 with max=3, retained newest three (t3,t4,t5)
    expect(events.slice(0, maxEntries).map((e) => e.timestamp)).toEqual(['t3', 't4', 't5']);
    expect(events[maxEntries].type).toBe('agent_launched');

    warnSpy.mockRestore();
  });

  test('maxEntries=0 drops all pre-materialize non-substantive events', async () => {
    const writer = new DeferredInteractionLogWriter(sessionsDir, async () => 'test-session', { maxEntries: 0 });

    await writer.append({
      type: 'agent_stopped',
      agentId: 'a1',
      reason: 'completed',
      timestamp: 't1',
    });
    expect(writer.getBufferedEventCount()).toBe(0);

    await writer.append({
      type: 'agent_launched',
      agentId: 'a2',
      taskPrompt: 'go',
      timestamp: 't2',
    });

    const events = await readInteractionLog(writer.getFilePath()!);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_launched');
  });
});

describe('nowISO', () => {
  test('returns a valid ISO 8601 string', () => {
    const iso = nowISO();
    expect(() => new Date(iso)).not.toThrow();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});
