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
});
