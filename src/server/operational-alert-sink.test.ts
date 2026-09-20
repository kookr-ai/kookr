import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  OperationalAlertSink,
  bindOperationalAlertSink,
  DEFAULT_OPERATIONAL_ALERT_SINK_MAX_BYTES,
  DEFAULT_OPERATIONAL_ALERT_SINK_ROTATED_GENERATIONS,
  OPERATIONAL_ALERTS_FILE_NAME,
} from './operational-alert-sink.js';
import type { ServerMessage } from '../shared/contracts/messages.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

function deadManFired(): AlertMessage {
  return {
    type: 'alert',
    agentId: 'system',
    summary: 'Scheduled tasks are starving: 3 fires dropped',
    details: 'Dead-man switch fired.',
    severity: 'warning',
    operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'fired' },
  };
}

function deadManRecovered(): AlertMessage {
  return {
    type: 'alert',
    agentId: 'system',
    summary: 'Recovered: scheduled executions are flowing again',
    details: 'Dead-man switch cleared.',
    severity: 'info',
    operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'recovered' },
  };
}

function parseJsonl(raw: string): unknown[] {
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function providerHealthFired(): AlertMessage {
  return {
    type: 'alert',
    agentId: 'system',
    summary: 'Provider paused: codex-cli unavailable',
    details: 'Provider-health dead-man fired after N fallback substitutions.',
    severity: 'warning',
    operationalAlert: { key: 'provider:codex-cli', metric: 'provider_health', state: 'fired' },
  };
}

describe('OperationalAlertSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operational-alert-sink-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('appends a dead-man fire transition with ts, kind, and cause', async () => {
    const sink = new OperationalAlertSink({ kookrDir: dir, now: () => new Date('2026-07-31T00:00:00.000Z') });

    const ok = await sink.append(deadManFired());

    expect(ok).toBe(true);
    const lines = readFileSync(join(dir, 'operational-alerts.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: '2026-07-31T00:00:00.000Z',
      state: 'fired',
      key: 'schedule:dead_man',
      metric: 'schedule_starvation',
      summary: 'Scheduled tasks are starving: 3 fires dropped',
      details: 'Dead-man switch fired.',
    });
  });

  test('records both dead-man and provider-health fire/clear transitions in order', async () => {
    const sink = new OperationalAlertSink({ kookrDir: dir });

    await sink.append(deadManFired());
    await sink.append(deadManRecovered());
    await sink.append(providerHealthFired());

    const lines = readFileSync(join(dir, 'operational-alerts.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const rows = lines.map((line) => JSON.parse(line));
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ['schedule:dead_man', 'fired'],
      ['schedule:dead_man', 'recovered'],
      ['provider:codex-cli', 'fired'],
    ]);
    // Every row carries a timestamp, transition kind, and cause.
    for (const row of rows) {
      expect(typeof row.ts).toBe('string');
      expect(['fired', 'recovered']).toContain(row.state);
      expect(row.summary.length).toBeGreaterThan(0);
    }
  });

  test('omits details when the alert carries an empty string', async () => {
    const sink = new OperationalAlertSink({ kookrDir: dir });
    const noDetails: AlertMessage = { ...deadManRecovered(), details: '' };
    await sink.append(noDetails);
    const row = JSON.parse(readFileSync(join(dir, 'operational-alerts.jsonl'), 'utf-8').trim());
    expect('details' in row).toBe(false);
  });

  test('ignores alerts without operationalAlert metadata and writes nothing', async () => {
    const sink = new OperationalAlertSink({ kookrDir: dir });
    const generic: AlertMessage = {
      type: 'alert',
      agentId: 'agent-7',
      summary: 'Generic dashboard alert',
      details: 'Not an operational rule event.',
      severity: 'info',
    };

    const ok = await sink.append(generic);

    expect(ok).toBe(true);
    expect(existsSync(join(dir, 'operational-alerts.jsonl'))).toBe(false);
  });

  test('unconfigured sink is a no-op that reports not configured', async () => {
    const sink = new OperationalAlertSink({ filePath: null });
    expect(await sink.append(deadManFired())).toBe(true);
    expect(sink.status()).toEqual({ configured: false, writable: true });
  });

  test('a write failure never throws and is surfaced on status()', async () => {
    const errors: string[] = [];
    // Point at a path whose parent is a file, so mkdir/appendFile fail.
    const notADir = join(dir, 'occupied');
    const sink = new OperationalAlertSink({
      filePath: join(notADir, 'nested', 'operational-alerts.jsonl'),
      now: () => new Date('2026-07-31T00:00:00.000Z'),
      logger: { error: (msg: string) => errors.push(msg) },
    });
    // Create `occupied` as a regular file so the nested mkdir cannot succeed.
    writeFileSync(notADir, 'x');

    const ok = await sink.append(deadManFired());

    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    const status = sink.status();
    expect(status.configured).toBe(true);
    expect(status.writable).toBe(false);
    expect(status.lastFailure?.message.length).toBeGreaterThan(0);
  });

  test('a subsequent successful append clears a prior failure on status()', async () => {
    const notADir = join(dir, 'occupied');
    const filePath = join(notADir, 'nested', 'operational-alerts.jsonl');
    const sink = new OperationalAlertSink({ filePath, logger: { error: () => {} } });

    // First append fails: `occupied` is a regular file blocking the nested mkdir.
    writeFileSync(notADir, 'x');
    expect(await sink.append(deadManFired())).toBe(false);
    expect(sink.status().writable).toBe(false);

    // Clear the obstruction so the same path becomes writable, then append again.
    rmSync(notADir);
    expect(await sink.append(deadManRecovered())).toBe(true);
    expect(sink.status().writable).toBe(true);
    expect(sink.status().lastFailure).toBeUndefined();
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).state).toBe('recovered');
  });

  test('bindOperationalAlertSink returns a fire-and-forget recorder', async () => {
    const sink = new OperationalAlertSink({ kookrDir: dir });
    const record = bindOperationalAlertSink(sink);

    // Synchronous call, returns void; the write settles asynchronously.
    const result = record(deadManFired());
    expect(result).toBeUndefined();

    // Wait until the swallowed promise settles (rotate + append on the
    // threadpool). Assert on parsed content, not just line count — an empty
    // file would still split to a length-1 array.
    const filePath = join(dir, 'operational-alerts.jsonl');
    await vi.waitFor(() => {
      const content = readFileSync(filePath, 'utf-8').trim();
      expect(content.length).toBeGreaterThan(0);
    });
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).key).toBe('schedule:dead_man');
  });

  test.runIf(process.platform !== 'win32')(
    'persists operational-alerts.jsonl owner-only (mode 0o600) after the first append',
    async () => {
      const sink = new OperationalAlertSink({ kookrDir: dir });
      const filePath = join(dir, OPERATIONAL_ALERTS_FILE_NAME);

      expect(await sink.append(deadManFired())).toBe(true);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    },
  );

  test.runIf(process.platform !== 'win32')(
    'append still succeeds when chmod is a no-op on an already owner-only file',
    async () => {
      const filePath = join(dir, OPERATIONAL_ALERTS_FILE_NAME);
      writeFileSync(filePath, '', { mode: 0o600 });
      chmodSync(filePath, 0o600);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);

      const sink = new OperationalAlertSink({
        kookrDir: dir,
        now: () => new Date('2026-07-31T00:00:00.000Z'),
      });

      expect(await sink.append(deadManFired())).toBe(true);
      expect(sink.status()).toEqual({ configured: true, writable: true });
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).key).toBe('schedule:dead_man');
    },
  );

  test('exports conservative default rotation thresholds', () => {
    expect(DEFAULT_OPERATIONAL_ALERT_SINK_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_OPERATIONAL_ALERT_SINK_ROTATED_GENERATIONS).toBe(2);
  });

  test('an append extends the live file rather than rewriting the corpus', async () => {
    const filePath = join(dir, OPERATIONAL_ALERTS_FILE_NAME);
    const seedRows = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        state: 'fired',
        key: `seed:${i}`,
        metric: 'seed',
        summary: `seed row ${i}`,
      }),
    );
    const seed = `${seedRows.join('\n')}\n`;
    writeFileSync(filePath, seed);

    const sink = new OperationalAlertSink({
      kookrDir: dir,
      now: () => new Date('2026-07-31T00:00:00.000Z'),
      maxBytes: 1024 * 1024,
    });
    expect(await sink.append(deadManFired())).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content.startsWith(seed)).toBe(true);
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(21);
    expect(JSON.parse(lines[20]!).key).toBe('schedule:dead_man');
  });
});

describe('OperationalAlertSink rotation (issue #3311)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operational-alert-sink-rotate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writing past the cap produces a rotated .1 generation and a bounded active file', async () => {
    let seq = 0;
    const sink = new OperationalAlertSink({
      kookrDir: dir,
      now: () => new Date(`2026-07-31T00:00:${String(seq).padStart(2, '0')}.000Z`),
      maxBytes: 80,
      rotatedGenerations: 2,
    });

    expect(await sink.append(deadManFired())).toBe(true);
    seq += 1;
    expect(await sink.append(deadManRecovered())).toBe(true);
    seq += 1;
    expect(await sink.append(providerHealthFired())).toBe(true);

    const activePath = join(dir, OPERATIONAL_ALERTS_FILE_NAME);
    const activeRaw = readFileSync(activePath, 'utf-8');
    const rotated1 = readFileSync(`${activePath}.1`, 'utf-8');
    const rotated2 = readFileSync(`${activePath}.2`, 'utf-8');

    const activeRows = parseJsonl(activeRaw);
    const rotated1Rows = parseJsonl(rotated1);
    const rotated2Rows = parseJsonl(rotated2);
    expect(activeRows).toHaveLength(1);
    expect(rotated1Rows).toHaveLength(1);
    expect(rotated2Rows).toHaveLength(1);
    expect(activeRows[0]).toMatchObject({
      key: 'provider:codex-cli',
      state: 'fired',
    });
    expect(rotated1Rows[0]).toMatchObject({ key: 'schedule:dead_man', state: 'recovered' });
    expect(rotated2Rows[0]).toMatchObject({ key: 'schedule:dead_man', state: 'fired' });
    expect(existsSync(`${activePath}.3`)).toBe(false);

    const activeBytes = Buffer.byteLength(activeRaw);
    expect(activeBytes).toBe(Buffer.byteLength(`${JSON.stringify(activeRows[0])}\n`));
    expect(activeBytes).not.toBe(Buffer.byteLength(rotated1));
    expect(activeBytes).toBe(statSync(activePath).size);
  });

  test('serialized concurrent appends do not drop rows when rotation fires', async () => {
    const sink = new OperationalAlertSink({
      kookrDir: dir,
      maxBytes: 80,
      rotatedGenerations: 2,
    });

    const results = await Promise.all([
      sink.append(deadManFired()),
      sink.append(deadManRecovered()),
      sink.append(providerHealthFired()),
    ]);
    expect(results).toEqual([true, true, true]);

    const activePath = join(dir, OPERATIONAL_ALERTS_FILE_NAME);
    const rows = [
      ...parseJsonl(readFileSync(activePath, 'utf-8')),
      ...parseJsonl(readFileSync(`${activePath}.1`, 'utf-8')),
      ...parseJsonl(readFileSync(`${activePath}.2`, 'utf-8')),
    ];
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'schedule:dead_man', state: 'fired' }),
        expect.objectContaining({ key: 'schedule:dead_man', state: 'recovered' }),
        expect.objectContaining({ key: 'provider:codex-cli', state: 'fired' }),
      ]),
    );
  });
});
