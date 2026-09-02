import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { OperationalAlertSink } from '../operational-alert-sink.js';
import { registerSelfReportRoutes, SELF_REPORT_KINDS, SELF_REPORT_PATH } from './self-report-routes.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

describe('self-report routes (#2977)', () => {
  let app: Hono;
  let broadcast: ServerMessage[];
  let recorded: AlertMessage[];

  const post = (body: unknown) =>
    app.request(SELF_REPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    app = new Hono();
    broadcast = [];
    recorded = [];
    registerSelfReportRoutes(app, {
      emitOperationalAlert: (alert) => { broadcast.push(alert); recorded.push(alert); },
      log: { warn: vi.fn() },
    });
  });

  test('the route path is the literal the CLI shim posts to', () => {
    // `bin/kookr-self-report` hardcodes this string. Building the request URL
    // from the import would let a server-side rename pass every test here while
    // breaking every real agent.
    expect(SELF_REPORT_PATH).toBe('/api/self-report');
  });

  test('a report is broadcast live and recorded durably as one operational alert', async () => {
    const res = await post({
      agentId: 'kookr-abc123',
      kind: 'prompt_unusable',
      detail: 'prompt stops mid-sentence after "not in"',
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ recorded: true });
    expect(broadcast).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    // Same object down both paths: the dashboard and the JSONL never disagree.
    expect(recorded[0]).toEqual(broadcast[0]);
    const alert = recorded[0]!;
    expect(alert.agentId).toBe('kookr-abc123');
    expect(alert.details).toContain('not in');
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert).toEqual({
      key: 'self-report:kookr-abc123:prompt_unusable',
      metric: 'agent_self_report',
      state: 'fired',
    });
  });

  test('the incident key is stable across repeat reports from the same agent', async () => {
    await post({ agentId: 'kookr-abc123', kind: 'prompt_unusable', detail: 'first' });
    await post({ agentId: 'kookr-abc123', kind: 'prompt_unusable', detail: 'second' });

    expect(recorded.map((a) => a.operationalAlert?.key)).toEqual([
      'self-report:kookr-abc123:prompt_unusable',
      'self-report:kookr-abc123:prompt_unusable',
    ]);
  });

  test('a different kind from the same agent is a separate incident', async () => {
    await post({ agentId: 'kookr-abc123', kind: 'prompt_unusable', detail: 'x' });
    await post({ agentId: 'kookr-abc123', kind: 'environment_broken', detail: 'y' });

    expect(recorded.map((a) => a.operationalAlert?.key)).toEqual([
      'self-report:kookr-abc123:prompt_unusable',
      'self-report:kookr-abc123:environment_broken',
    ]);
  });

  test('every kind gets its own operator-facing summary', async () => {
    // `summary` is the operator's column in operational-alerts.jsonl; a shared
    // string there makes every report look alike in the incident log.
    for (const kind of SELF_REPORT_KINDS) {
      await post({ agentId: 'a', kind, detail: 'x' });
    }
    const summaries = recorded.map((a) => a.summary);
    expect(summaries).toHaveLength(SELF_REPORT_KINDS.length);
    expect(new Set(summaries).size).toBe(SELF_REPORT_KINDS.length);
  });

  test('the durable row carries the report through to the JSONL on disk', async () => {
    // The fake sink above proves the route calls it; this proves the row that
    // actually lands is usable — agent identity survives only via the key, so
    // a key change here is an operator losing the ability to trace a report.
    const dir = mkdtempSync(join(tmpdir(), 'self-report-sink-'));
    try {
      const filePath = join(dir, 'operational-alerts.jsonl');
      const app2 = new Hono();
      const sink = new OperationalAlertSink({ filePath });
      registerSelfReportRoutes(app2, {
        emitOperationalAlert: (alert) => { void sink.append(alert); },
        log: { warn: vi.fn() },
      });

      await app2.request(SELF_REPORT_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'kookr-abc123',
          kind: 'prompt_unusable',
          detail: 'prompt stops mid-sentence',
        }),
      });
      await vi.waitFor(() => expect(readFileSync(filePath, 'utf-8')).toContain('agent_self_report'));

      const row = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(row.key).toBe('self-report:kookr-abc123:prompt_unusable');
      expect(row.metric).toBe('agent_self_report');
      expect(row.state).toBe('fired');
      expect(row.details).toContain('mid-sentence');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an over-long detail is truncated rather than logged whole', async () => {
    await post({ agentId: 'a', kind: 'other', detail: 'x'.repeat(5_000) });
    expect(recorded[0]!.details).toHaveLength(2_000);
  });

  test('a detail is stored trimmed, so the log line is not blank', async () => {
    await post({ agentId: 'a', kind: 'other', detail: '\n\n  the prompt stops mid-sentence  ' });
    expect(recorded[0]!.details).toBe('the prompt stops mid-sentence');
  });

  test.each([
    ['missing agentId', { kind: 'other', detail: 'x' }],
    ['empty agentId', { agentId: '', kind: 'other', detail: 'x' }],
    ['unknown kind', { agentId: 'a', kind: 'vibes', detail: 'x' }],
    ['missing detail', { agentId: 'a', kind: 'other' }],
    ['blank detail', { agentId: 'a', kind: 'other', detail: '   ' }],
    // The alert key is `self-report:<agentId>:<kind>`; a ':' in the id would
    // let two distinct reporters land on one incident.
    ['agentId containing the key delimiter', { agentId: 'a:b', kind: 'other', detail: 'x' }],
    ['agentId containing a newline', { agentId: 'a\nfake log line', kind: 'other', detail: 'x' }],
    ['over-long agentId', { agentId: 'a'.repeat(201), kind: 'other', detail: 'x' }],
  ])('%s is rejected without emitting anything', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(broadcast).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  test('a non-JSON body is rejected without emitting anything', async () => {
    const res = await app.request(SELF_REPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(broadcast).toHaveLength(0);
  });

  test('an unwired durable sink warns once and does not stop the live broadcast', async () => {
    const bare = new Hono();
    const seen: ServerMessage[] = [];
    const warn = vi.fn();
    registerSelfReportRoutes(bare, {
      emitOperationalAlert: (m) => { seen.push(m); },
      broadcastOnly: true,
      log: { warn },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no durable sink'));

    const res = await bare.request(SELF_REPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'a', kind: 'other', detail: 'x' }),
    });

    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
  });
});
