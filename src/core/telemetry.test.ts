import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TelemetryLogWriter,
  DeferredTelemetryLogWriter,
  TELEMETRY_LOG_READ_MAX_BYTES,
  readTelemetryLog,
  type TelemetryEvent,
} from './telemetry.js';

function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    type: 'agent_clicked',
    timestamp: '2026-03-27T10:00:00Z',
    sessionId: 'test-session',
    platform: 'linux',
    ...overrides,
  };
}

describe('TelemetryLogWriter', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-telemetry-'));
    logPath = join(tempDir, 'sessions', 'test-session', 'telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates directories and appends a single event', async () => {
    const writer = new TelemetryLogWriter(logPath);
    const event = makeEvent({ agentId: 'agent-1', source: 'finding_card' });
    await writer.append(event);

    const events = await readTelemetryLog(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  test('appendBatch writes multiple events', async () => {
    const writer = new TelemetryLogWriter(logPath);
    const batch = [
      makeEvent({ type: 'session_started', timestamp: '2026-03-27T10:00:00Z' }),
      makeEvent({ type: 'shortcut_used', key: 'Ctrl+N', timestamp: '2026-03-27T10:00:01Z' }),
      makeEvent({ type: 'agent_clicked', agentId: 'a1', timestamp: '2026-03-27T10:00:02Z' }),
    ];
    await writer.appendBatch(batch);

    const events = await readTelemetryLog(logPath);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(batch[0]);
    expect(events[1]).toEqual(batch[1]);
    expect(events[2]).toEqual(batch[2]);
  });

  test('appendBatch with empty array is a no-op', async () => {
    const writer = new TelemetryLogWriter(logPath);
    await writer.appendBatch([]);
    const events = await readTelemetryLog(logPath);
    expect(events).toEqual([]);
  });

  test('getFilePath returns configured path', () => {
    const writer = new TelemetryLogWriter(logPath);
    expect(writer.getFilePath()).toBe(logPath);
  });
});

describe('readTelemetryLog', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-telemetry-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns empty array for missing file', async () => {
    const events = await readTelemetryLog(join(tempDir, 'nonexistent.jsonl'));
    expect(events).toEqual([]);
  });

  test('skips malformed lines', async () => {
    const logPath = join(tempDir, 'bad.jsonl');
    writeFileSync(
      logPath,
      JSON.stringify(makeEvent()) + '\n' +
        'not valid json\n' +
        JSON.stringify(makeEvent({ type: 'shortcut_used' })) + '\n',
    );

    const events = await readTelemetryLog(logPath);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent_clicked');
    expect(events[1].type).toBe('shortcut_used');
  });

  test('handles empty lines', async () => {
    const logPath = join(tempDir, 'empty-lines.jsonl');
    writeFileSync(logPath, JSON.stringify(makeEvent()) + '\n\n\n');

    const events = await readTelemetryLog(logPath);
    expect(events).toHaveLength(1);
  });

  test('tails a file larger than the cap and drops the parseable partial first line', async () => {
    const logPath = join(tempDir, 'tailed.jsonl');
    const droppedPartial = JSON.stringify(makeEvent({
      type: 'agent_clicked',
      agentId: 'dropped-partial',
      timestamp: '2026-03-27T09:00:00Z',
    }));
    const tailEvent = makeEvent({
      type: 'shortcut_used',
      key: 'Ctrl+N',
      timestamp: '2026-03-27T10:00:00Z',
    });
    const tailLine = `${JSON.stringify(tailEvent)}\n`;
    const maxBytes = droppedPartial.length + 1 + tailLine.length;
    const aged = `${JSON.stringify(makeEvent({
      type: 'session_started',
      timestamp: '2026-03-27T08:00:00Z',
    }))}\n`;
    const prefix = `${aged}${'x'.repeat(maxBytes)}GARBAGE`;
    writeFileSync(logPath, `${prefix}${droppedPartial}\n${tailLine}`);
    expect(statSync(logPath).size).toBeGreaterThan(maxBytes);

    const sizeBefore = statSync(logPath).size;
    const events = await readTelemetryLog(logPath, { maxBytes });
    expect(statSync(logPath).size).toBe(sizeBefore);
    expect(events.map((event) => event.type)).toEqual(['shortcut_used']);
    expect(events[0]).toEqual(tailEvent);
    expect(events.some((event) => event.agentId === 'dropped-partial')).toBe(false);
  });

  test('default cap tails a lifetime-sized prefix and keeps the last event', async () => {
    const logPath = join(tempDir, 'default-cap.jsonl');
    const aged = `${JSON.stringify(makeEvent({
      type: 'session_started',
      timestamp: '2026-03-27T08:00:00Z',
    }))}\n`;
    const tailEvent = makeEvent({
      type: 'shortcut_used',
      key: 'Ctrl+N',
      timestamp: '2026-03-27T10:00:00Z',
    });
    const pad = 'x'.repeat(TELEMETRY_LOG_READ_MAX_BYTES);
    writeFileSync(logPath, `${aged}${pad}\n${JSON.stringify(tailEvent)}\n`);
    expect(statSync(logPath).size).toBeGreaterThan(TELEMETRY_LOG_READ_MAX_BYTES);

    const events = await readTelemetryLog(logPath);
    expect(events.some((event) => event.type === 'session_started')).toBe(false);
    expect(events.some((event) => event.type === 'shortcut_used')).toBe(true);
    expect(events[events.length - 1]).toEqual(tailEvent);
  });
});

describe('DeferredTelemetryLogWriter', () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-deferred-telemetry-'));
    sessionsDir = join(tempDir, 'sessions');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('buffers events when session ID is not yet available', async () => {
    const writer = new DeferredTelemetryLogWriter(sessionsDir, () => null);

    await writer.append(makeEvent());

    // No file should be created
    expect(writer.getFilePath()).toBeNull();
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(sessionsDir))).toBe(false);
  });

  test('writes events once session ID becomes available', async () => {
    let sessionId: string | null = null;
    const writer = new DeferredTelemetryLogWriter(sessionsDir, () => sessionId);

    // Buffer an event
    await writer.append(makeEvent({ type: 'session_started' }));
    expect(writer.getFilePath()).toBeNull();

    // Session ID becomes available (interaction log materialized)
    sessionId = 'test-session';

    // Next write triggers flush
    await writer.append(makeEvent({ type: 'agent_clicked' }));

    const events = await readTelemetryLog(writer.getFilePath()!);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('session_started');
    expect(events[1].type).toBe('agent_clicked');
  });

  test('appendBatch buffers when session ID not available', async () => {
    let sessionId: string | null = null;
    const writer = new DeferredTelemetryLogWriter(sessionsDir, () => sessionId);

    await writer.appendBatch([makeEvent({ type: 'session_started' }), makeEvent({ type: 'shortcut_used' })]);
    expect(writer.getFilePath()).toBeNull();

    // Session becomes available
    sessionId = 'test-session';
    await writer.appendBatch([makeEvent({ type: 'agent_clicked' })]);

    const events = await readTelemetryLog(writer.getFilePath()!);
    expect(events).toHaveLength(3);
  });

  test('appendBatch with empty array is a no-op', async () => {
    const writer = new DeferredTelemetryLogWriter(sessionsDir, () => null);
    await writer.appendBatch([]);
    expect(writer.getFilePath()).toBeNull();
  });
});
