import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { SignalDeliveryService } from '../../observability/signal-delivery/service.js';
import { listSignalFiles, writeOperatorSignal } from '../../observability/signal-delivery/operator-signal.js';
import { buildPermissionPromptAlert, buildPermissionPromptRecoveryAlert } from '../permission-prompt-wait-alert.js';
import { SELF_REPORT_PATH, registerSelfReportRoutes } from '../routes/self-report-routes.js';
import { wireSignalDelivery } from './signal-delivery-wiring.js';

// Telegram gets only the alerts an agent is waiting on the operator for. These
// tests drive the real alert builders through the real wiring, so renaming a
// metric cannot silently mute the one page that matters.

const OWNER_CHAT_ENV = { KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: '4242' } as NodeJS.ProcessEnv;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-telegram-decisions-'));
  dirs.push(dir);
  const wiring = wireSignalDelivery({ env: OWNER_CHAT_ENV, broadcastToAll: vi.fn(), dir, warn: vi.fn() });
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const service = new SignalDeliveryService({
    dir,
    config: wiring.config!,
    fetchImpl,
    now: () => new Date(0),
    log: () => {},
  });
  const telegramTexts = () =>
    (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)
      .filter(([url]) => url.includes('/sendMessage'))
      .map(([, init]) => (JSON.parse(String(init.body)) as { text: string }).text);
  const spooled = async (count: number) => {
    await vi.waitFor(async () => expect(await listSignalFiles(dir)).toHaveLength(count));
  };
  return { dir, wiring, service, fetchImpl, telegramTexts, spooled };
}

describe('Telegram alerts are decisions only by default', () => {
  test('a real permission-prompt page reaches Telegram; its recovery does not', async () => {
    const { wiring, service, telegramTexts, spooled } = await setup();
    const wait = { taskId: 't1', taskName: 'fix login', toolName: 'Bash', command: 'rm -rf build', sinceMs: 0 };
    wiring.detectorBroadcast(buildPermissionPromptAlert(wait, 5 * 60_000));
    await spooled(1);
    await service.tick();
    expect(telegramTexts()).toHaveLength(1);
    expect(telegramTexts()[0]).toContain('has waited 5m on a permission prompt');

    wiring.detectorBroadcast(buildPermissionPromptRecoveryAlert({ taskId: 't1', toolName: 'Bash' }));
    await spooled(2);
    const r = await service.tick();
    expect(r.withheld).toEqual(['op-permission_prompt-t1-clear.json']);
    expect(telegramTexts()).toHaveLength(1);
  });

  test('a real agent self-report reaches Telegram', async () => {
    const { wiring, service, telegramTexts, spooled } = await setup();
    const app = new Hono();
    registerSelfReportRoutes(app, {
      emitOperationalAlert: (alert) => wiring.detectorBroadcast(alert),
      log: { warn: () => {} } as unknown as Console,
    });
    const res = await app.request(SELF_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'task-9', kind: 'prompt_unusable', detail: 'the prompt stops mid-sentence' }),
    });
    expect(res.status).toBe(202);
    await spooled(1);
    await service.tick();
    expect(telegramTexts()).toHaveLength(1);
    expect(telegramTexts()[0]).toContain('the prompt stops mid-sentence');
  });

  test('the status signals that filled the operator chat send nothing', async () => {
    const { dir, wiring, service, fetchImpl, spooled } = await setup();
    // The sources seen in a real outbox over three days, with their real kinds.
    const operational: Array<[string, 'fired' | 'recovered']> = [
      ['schedules_paused_residual', 'fired'],
      ['schedule_batch_drained_pin', 'fired'],
      ['schedule_starvation', 'fired'],
      ['schedule_starvation', 'recovered'],
      ['prod_smoke_tick', 'fired'],
      ['prod_smoke_tick', 'recovered'],
      ['pipeline_starvation', 'fired'],
      ['ready_queue_head_refused', 'fired'],
      ['provider_paused_occupancy', 'fired'],
      ['hung_suspect_residual', 'recovered'],
      ['auth_expired', 'fired'],
    ];
    for (const [metric, state] of operational) {
      wiring.detectorBroadcast({
        type: 'alert',
        agentId: 'kookr',
        summary: `${metric} ${state}`,
        severity: 'warning',
        operationalAlert: { key: `${metric}:x`, metric, state },
      } as ServerMessage);
    }
    // The integration-train monitor writes to the outbox directly.
    await writeOperatorSignal(dir, { key: 'integration-train:halted', kind: 'alert', source: 'integration-train', title: 'halted' });
    await writeOperatorSignal(dir, { key: 'integration-train:bypassed', kind: 'info', source: 'integration-train', title: 'main-bypassed' });
    await writeOperatorSignal(dir, { key: 'integration-train:recovered', kind: 'clear', source: 'integration-train', title: 'recovered' });
    await spooled(operational.length + 3);

    const r = await service.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.withheld).toHaveLength(operational.length + 3);
    expect(service.status().pending).toBe(0);
  });
});
