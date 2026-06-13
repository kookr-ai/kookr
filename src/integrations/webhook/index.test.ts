import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../../core/tasks.js';
import type { Anomaly } from '../../core/types.js';
import {
  type WebhookConfig,
  WebhookNotifier,
  buildDashboardBaseUrl,
  readWebhookConfigFromEnv,
  resolveWebhookRouting,
} from './index.js';

const detectedAt = new Date('2026-06-12T10:00:00.000Z');
const sentAt = new Date('2026-06-12T10:00:05.000Z');

function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    agentId: 'session-1',
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'Agent is waiting for permission',
    detectedAt,
    eventId: 'evt-1',
    ...overrides,
  };
}

function setup(
  fetchImpl = vi.fn(async () => new Response('ok', { status: 200 })),
  configOverrides: Partial<WebhookConfig> = {},
  now = () => sentAt,
) {
  const taskStore = new TaskStore();
  const task = taskStore.createTask({ prompt: 'Fix the webhook tests', cwd: '/repo', name: 'Webhook tests' });
  taskStore.addSession(task.id, {
    tmuxSession: 'session-1',
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: detectedAt,
    lastStatus: 'running',
  });
  const logger = { warn: vi.fn(), log: vi.fn() };
  const notifier = new WebhookNotifier({
    config: {
      url: 'https://receiver.example/webhook',
      minSeverity: 'info',
      maxAttempts: 3,
      initialRetryDelayMs: 0,
      dashboardBaseUrl: 'http://127.0.0.1:4801',
      ...configOverrides,
    },
    taskStore,
    fetchImpl: fetchImpl as typeof fetch,
    now,
    logger,
  });
  return { notifier, fetchImpl, logger, task };
}

function signature(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('webhook notifier', () => {
  test('builds and posts the generic finding payload', async () => {
    const { notifier, fetchImpl, task } = setup();

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::Agent is waiting for permission',
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://receiver.example/webhook');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'kookr-webhook',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion: 'kookr.finding.webhook.v1',
      event: 'finding.admitted',
      fingerprint: 'permission_blocked::Agent is waiting for permission',
      sentAt: sentAt.toISOString(),
      dashboardUrl: 'http://127.0.0.1:4801',
      finding: {
        agentId: 'session-1',
        type: 'permission_blocked',
        severity: 'warning',
        explanation: 'Agent is waiting for permission',
        detectedAt: detectedAt.toISOString(),
        eventId: 'evt-1',
      },
      task: {
        id: task.id,
        name: 'Webhook tests',
        prompt: 'Fix the webhook tests',
        cwd: '/repo',
        status: 'inProgress',
      },
    });
  });

  test('omits the signature header when no webhook secret is configured', async () => {
    const { notifier, fetchImpl } = setup();

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::unsigned',
    })).resolves.toBe(true);

    const init = fetchImpl.mock.calls[0][1];
    expect(init?.headers).not.toHaveProperty('X-Kookr-Signature');
  });

  test('signs the byte-stable body with the first configured webhook secret', async () => {
    const { notifier, fetchImpl } = setup(undefined, {
      signingSecrets: ['primary-secret', 'old-secret'],
    });

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::signed',
    })).resolves.toBe(true);

    const init = fetchImpl.mock.calls[0][1];
    const body = String(init?.body);
    const timestamp = Math.floor(sentAt.getTime() / 1_000);
    expect(init?.headers).toMatchObject({
      'X-Kookr-Signature': signature('primary-secret', timestamp, body),
    });
    expect(init?.headers).not.toMatchObject({
      'X-Kookr-Signature': signature('old-secret', timestamp, body),
    });
  });

  test('uses a fresh signature timestamp for each retry over the same body', async () => {
    const transientFetch = vi.fn()
      .mockResolvedValueOnce(new Response('try again', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const nowValues = [
      new Date('2026-06-12T10:00:05.000Z'),
      new Date('2026-06-12T10:00:10.000Z'),
      new Date('2026-06-12T10:00:20.000Z'),
    ];
    const now = vi.fn(() => nowValues.shift() ?? new Date('2026-06-12T10:00:20.000Z'));
    const { notifier } = setup(transientFetch, {
      signingSecrets: ['retry-secret'],
    }, now);

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::retry signed',
    })).resolves.toBe(true);

    expect(transientFetch).toHaveBeenCalledTimes(2);
    const firstInit = transientFetch.mock.calls[0][1];
    const secondInit = transientFetch.mock.calls[1][1];
    expect(String(firstInit?.body)).toBe(String(secondInit?.body));
    expect(firstInit?.headers).toMatchObject({
      'X-Kookr-Signature': signature('retry-secret', 1_781_258_410, String(firstInit?.body)),
    });
    expect(secondInit?.headers).toMatchObject({
      'X-Kookr-Signature': signature('retry-secret', 1_781_258_420, String(secondInit?.body)),
    });
  });

  test('filters findings below the configured minimum severity', async () => {
    const { notifier, fetchImpl } = setup(undefined, { minSeverity: 'critical' });

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ severity: 'warning' }),
      fingerprint: 'permission_blocked::Agent is waiting for permission',
    })).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('uses per-project routing to override the global minimum severity', async () => {
    const { notifier, fetchImpl } = setup(undefined, { minSeverity: 'critical' });

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ severity: 'warning' }),
      fingerprint: 'permission_blocked::project warning',
    }, {
      enabled: true,
      minSeverity: 'warning',
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not dedupe a finding suppressed by per-project disabled routing', async () => {
    const { notifier, fetchImpl } = setup();
    const event = {
      agentId: 'session-1',
      anomaly: anomaly({ severity: 'critical' }),
      fingerprint: 'permission_blocked::disabled project',
    };

    await expect(notifier.notifyFinding(event, {
      enabled: false,
      minSeverity: 'info',
    })).resolves.toBe(false);
    await expect(notifier.notifyFinding(event, {
      enabled: true,
      minSeverity: 'info',
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('deduplicates by agent and finding fingerprint until recovery clears it', async () => {
    const { notifier, fetchImpl } = setup();
    const event = {
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::Agent is waiting for permission',
    };

    await notifier.notifyFinding(event);
    await notifier.notifyFinding(event);
    await notifier.notifyFinding({
      ...event,
      agentId: 'session-2',
      anomaly: anomaly({ agentId: 'session-2' }),
    });
    notifier.clearFingerprint(event);
    await notifier.notifyFinding(event);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('retries transient network and server errors without retrying 4xx responses', async () => {
    const transientFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { notifier } = setup(transientFetch);

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::retry me',
    })).resolves.toBe(true);

    expect(transientFetch).toHaveBeenCalledTimes(3);

    const clientFetch = vi.fn(async () => new Response('nope', { status: 400 }));
    const { notifier: clientNotifier, logger } = setup(clientFetch);
    await expect(clientNotifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ explanation: 'bad request' }),
      fingerprint: 'permission_blocked::bad request',
    })).resolves.toBe(false);

    expect(clientFetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('webhook returned 400'));
  });

  test('reads env config and dashboard base URLs', () => {
    expect(readWebhookConfigFromEnv({})).toBeNull();
    expect(readWebhookConfigFromEnv({
      KOOKR_WEBHOOK_URL: ' https://receiver.example ',
      KOOKR_WEBHOOK_MIN_SEVERITY: 'critical',
      KOOKR_WEBHOOK_SECRET: ' primary-secret, old-secret , ',
    }, { dashboardBaseUrl: 'http://dash' })).toMatchObject({
      url: 'https://receiver.example',
      minSeverity: 'critical',
      signingSecrets: ['primary-secret', 'old-secret'],
      dashboardBaseUrl: 'http://dash',
    });
    expect(buildDashboardBaseUrl({
      host: '0.0.0.0',
      port: 4801,
      env: {},
    })).toBe('http://127.0.0.1:4801');
    expect(buildDashboardBaseUrl({
      host: '::1',
      port: 4801,
      env: {},
    })).toBe('http://[::1]:4801');
    expect(buildDashboardBaseUrl({
      host: '127.0.0.1',
      port: 4801,
      env: { KOOKR_PUBLIC_BASE_URL: 'https://public.example/kookr/' },
    })).toBe('https://public.example/kookr');
  });

  test('resolves effective routing from per-project webhook settings with env fallback', () => {
    expect(resolveWebhookRouting({ globalMinSeverity: 'warning' })).toEqual({
      enabled: true,
      minSeverity: 'warning',
    });
    expect(resolveWebhookRouting({
      globalMinSeverity: 'warning',
      projectWebhook: { minSeverity: 'critical' },
    })).toEqual({
      enabled: true,
      minSeverity: 'critical',
    });
    expect(resolveWebhookRouting({
      globalMinSeverity: 'critical',
      projectWebhook: { enabled: false },
    })).toEqual({
      enabled: false,
      minSeverity: 'critical',
    });
  });
});
