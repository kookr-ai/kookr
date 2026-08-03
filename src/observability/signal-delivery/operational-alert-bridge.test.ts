import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  DEPLOY_LAG_ALERT_KEY,
  DEPLOY_LAG_ALERT_METRIC,
  buildDeployLagAlertMessage,
} from '../../server/deploy-lag-detector.js';
import {
  PROD_SMOKE_TICK_ALERT_KEY,
  PROD_SMOKE_TICK_ALERT_METRIC,
  buildSmokeTickAlertMessage,
} from '../../server/prod-smoke-tick.js';
import { buildKbDegradedAlert } from '../../server/lesson-spool-service.js';
import { writeOperatorSignal } from './operator-signal.js';
import { SignalDeliveryService } from './service.js';
import { operationalAlertToSignal } from './operational-alert-bridge.js';

describe('operationalAlertToSignal', () => {
  test('maps a deploy-lag fire to an alert signal', () => {
    const signal = operationalAlertToSignal({
      type: 'alert',
      summary: 'Deploy lag: kookr behind origin/main',
      details: '7 commits / 9.5h behind. Artifact: /x/deploy-lag-alert.json',
      operationalAlert: { key: 'deploy:lag', metric: 'deploy_lag', state: 'fired' },
    });
    expect(signal).not.toBeNull();
    expect(signal!.kind).toBe('alert');
    expect(signal!.key).toBe('op:deploy:lag:alert');
    expect(signal!.source).toBe('deploy_lag');
    expect(signal!.title).toContain('Deploy lag');
    expect(signal!.detail).toContain('7 commits');
  });

  test('maps a recover to a clear signal', () => {
    const signal = operationalAlertToSignal({
      type: 'alert',
      summary: 'Deploy lag cleared',
      operationalAlert: { key: 'deploy:lag', metric: 'deploy_lag', state: 'recovered' },
    });
    expect(signal!.kind).toBe('clear');
    expect(signal!.key).toBe('op:deploy:lag:clear');
  });

  test('maps a prod-smoke fire using its own metric as source', () => {
    const signal = operationalAlertToSignal({
      type: 'alert',
      summary: 'Prod smoke tick failing',
      operationalAlert: { key: 'smoke:hourly', metric: 'prod_smoke_tick', state: 'fired' },
    });
    expect(signal!.source).toBe('prod_smoke_tick');
    expect(signal!.key).toBe('op:smoke:hourly:alert');
  });

  test('fire and clear produce distinct keys (distinct spool files)', () => {
    const fire = operationalAlertToSignal({ type: 'alert', operationalAlert: { key: 'k', state: 'fired' } });
    const clear = operationalAlertToSignal({ type: 'alert', operationalAlert: { key: 'k', state: 'recovered' } });
    expect(fire!.key).not.toBe(clear!.key);
  });

  test('ignores non-alert and non-operational messages', () => {
    expect(operationalAlertToSignal({ type: 'snapshot' })).toBeNull();
    expect(operationalAlertToSignal({ type: 'alert' })).toBeNull();
    expect(operationalAlertToSignal({ type: 'alert', operationalAlert: { key: 'k', state: 'other' } })).toBeNull();
    expect(operationalAlertToSignal({ type: 'alert', operationalAlert: { state: 'fired' } })).toBeNull();
  });

  test('falls back to key as source and a synthesized title', () => {
    const signal = operationalAlertToSignal({ type: 'alert', operationalAlert: { key: 'gate:hb', state: 'fired' } });
    expect(signal!.source).toBe('gate:hb');
    expect(signal!.title).toBe('gate:hb fired');
  });
});

// Couples the bridge to the REAL broadcast contract: if a detector renames its
// operationalAlert key/metric or reshapes the message, these break instead of
// silently drifting (the hand-built cases above use literals on purpose).
describe('operationalAlertToSignal — real detector-message fidelity', () => {
  test('a real deploy-lag recovered broadcast maps to a clear signal', () => {
    const msg = buildDeployLagAlertMessage(
      { failingChecks: [], checks: [], status: 'ok', generatedAt: 'now' } as never,
      'recovered',
      '/x/deploy-lag-alert.json',
    );
    const signal = operationalAlertToSignal(msg as never);
    expect(signal!.kind).toBe('clear');
    expect(signal!.key).toBe(`op:${DEPLOY_LAG_ALERT_KEY}:clear`);
    expect(signal!.source).toBe(DEPLOY_LAG_ALERT_METRIC);
  });

  test('a real prod-smoke recovered broadcast maps to a clear signal', () => {
    const msg = buildSmokeTickAlertMessage(
      { failingChecks: [], checks: [], status: 'ok', generatedAt: 'now' } as never,
      'recovered',
      '/x/smoke.json',
    );
    const signal = operationalAlertToSignal(msg as never);
    expect(signal!.key).toBe(`op:${PROD_SMOKE_TICK_ALERT_KEY}:clear`);
    expect(signal!.source).toBe(PROD_SMOKE_TICK_ALERT_METRIC);
  });

  test('real broadcast → spooled signal → exactly one delivered POST (end-to-end)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-bridge-e2e-'));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const msg = buildDeployLagAlertMessage(
      { failingChecks: [], checks: [], status: 'ok', generatedAt: 'now' } as never,
      'recovered',
      '/x/deploy-lag-alert.json',
    );
    const input = operationalAlertToSignal(msg as never);
    await writeOperatorSignal(dir, input!);

    const svc = new SignalDeliveryService({
      dir,
      config: { discord: { webhookUrl: 'https://discord/webhook' }, dryRun: false, pollIntervalMs: 1, minSendIntervalMs: 1, bootDelayMs: 1 },
      fetchImpl,
      now: () => new Date(0),
      log: () => {},
    });
    const r = await svc.tick();
    expect(r.delivered).toEqual(['op-deploy-lag-clear.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { content: string };
    expect(body.content).toContain('Deploy lag cleared');
  });

  // Issues #1986/#1987/#1990: newly bridged emitters must keep mapping through
  // operationalAlertToSignal so detectorBroadcast can spool them.
  test('pipeline starvation fire/recover shapes map to alert/clear signals (#1986)', () => {
    const fire = operationalAlertToSignal({
      type: 'alert',
      summary: 'Pipeline starvation: jeanibarz/lucy — 2 consecutive empty batches',
      operationalAlert: {
        key: 'pipeline:starvation:jeanibarz/lucy',
        metric: 'pipeline_starvation',
        state: 'fired',
      },
    });
    const clear = operationalAlertToSignal({
      type: 'alert',
      summary: 'Recovered: pipeline work resumed for jeanibarz/lucy',
      operationalAlert: {
        key: 'pipeline:starvation:jeanibarz/lucy',
        metric: 'pipeline_starvation',
        state: 'recovered',
      },
    });
    expect(fire).toMatchObject({
      kind: 'alert',
      key: 'op:pipeline:starvation:jeanibarz/lucy:alert',
      source: 'pipeline_starvation',
    });
    expect(clear).toMatchObject({
      kind: 'clear',
      key: 'op:pipeline:starvation:jeanibarz/lucy:clear',
      source: 'pipeline_starvation',
    });
  });

  test('schedule dead-man fire/recover shapes map to alert/clear signals (#1987)', () => {
    const fire = operationalAlertToSignal({
      type: 'alert',
      summary: 'Scheduled tasks are starving',
      operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'fired' },
    });
    const clear = operationalAlertToSignal({
      type: 'alert',
      summary: 'Recovered: scheduled executions are flowing again',
      operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'recovered' },
    });
    expect(fire).toMatchObject({
      kind: 'alert',
      key: 'op:schedule:dead_man:alert',
      source: 'schedule_starvation',
    });
    expect(clear).toMatchObject({
      kind: 'clear',
      key: 'op:schedule:dead_man:clear',
    });
  });

  test('real lesson-spool KB degradation alert maps to an operator signal (#1990)', () => {
    const msg = buildKbDegradedAlert({
      degradedSince: '2026-07-22T10:08:00.000Z',
      degradedForHours: 24,
      pendingCount: 3,
      thresholdHours: 2,
    });
    const signal = operationalAlertToSignal(msg);
    expect(signal).toMatchObject({
      kind: 'alert',
      key: 'op:launch_dependency:kb:alert',
      source: 'launch_dependency_kb_degraded',
    });
    expect(signal!.title).toMatch(/KB launch dependency degraded/);
  });
});
