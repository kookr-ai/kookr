import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../../core/tasks.js';
import { DeliveryTraceBuffer } from '../../core/delivery-trace.js';
import type { Anomaly } from '../../core/types.js';
import {
  type WebhookConfig,
  WEBHOOK_PAYLOAD_SCHEMA_VERSION,
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
  const deliveryTrace = new DeliveryTraceBuffer({ now: () => sentAt });
  const notifier = new WebhookNotifier({
    config: {
      url: 'https://receiver.example/webhook',
      minSeverity: 'info',
      maxAttempts: 3,
      initialRetryDelayMs: 0,
      requestTimeoutMs: 10_000,
      failureCooldownMs: 0,
      dashboardBaseUrl: 'http://127.0.0.1:4801',
      ...configOverrides,
    },
    taskStore,
    deliveryTrace,
    fetchImpl: fetchImpl as typeof fetch,
    now,
    logger,
  });
  return { notifier, fetchImpl, logger, task, deliveryTrace };
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
    const { notifier, fetchImpl, deliveryTrace } = setup(undefined, { minSeverity: 'critical' });

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ severity: 'warning' }),
      fingerprint: 'permission_blocked::Agent is waiting for permission',
    })).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deliveryTrace.snapshot().records).toEqual([
      expect.objectContaining({
        stage: 'suppressed',
        reason: 'below_min_severity',
        agentId: 'session-1',
      }),
    ]);
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
    const { notifier, fetchImpl, deliveryTrace } = setup();
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
    expect(deliveryTrace.snapshot().records).toEqual([
      expect.objectContaining({
        stage: 'suppressed',
        reason: 'webhook_disabled',
      }),
      expect.objectContaining({
        stage: 'webhook_attempt',
        attempt: 1,
      }),
      expect.objectContaining({
        stage: 'webhook_result',
        outcome: 'success',
        httpStatus: 200,
      }),
    ]);
  });

  test('deduplicates by agent and finding fingerprint until recovery clears it', async () => {
    const { notifier, fetchImpl, deliveryTrace } = setup();
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
    expect(deliveryTrace.snapshot().records).toContainEqual(expect.objectContaining({
      stage: 'suppressed',
      reason: 'webhook_dedupe',
      agentId: 'session-1',
    }));
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
    expect(logger.warn).toHaveBeenCalledWith(
      '[webhook] failed to deliver finding',
      expect.objectContaining({
        fingerprint: 'permission_blocked::bad request',
        agentId: 'session-1',
        severity: 'warning',
        host: 'receiver.example',
        attempts: 1,
        error: 'webhook returned 400',
      }),
    );
  });

  test('times out a never-responding receiver and records failed + dropped outcomes', async () => {
    const hungFetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const onAbort = () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }));
    const { notifier, logger } = setup(hungFetch as typeof fetch, {
      maxAttempts: 1,
      requestTimeoutMs: 30,
      failureCooldownMs: 0,
    });

    const started = Date.now();
    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ severity: 'critical' }),
      fingerprint: 'permission_blocked::hang',
    })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hungFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(notifier.getDeliveryCounts()).toEqual({
      success: 0,
      failed: 1,
      dropped: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[webhook] failed to deliver finding',
      expect.objectContaining({
        error: 'webhook request timed out after 30ms',
        attempts: 1,
      }),
    );
  });

  test('releases the dedupe key after permanent failure so a later notify can re-POST', async () => {
    const failingThenOk = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { notifier } = setup(failingThenOk, {
      maxAttempts: 2,
      failureCooldownMs: 0,
    });
    const event = {
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::retry after drop',
    };

    await expect(notifier.notifyFinding(event)).resolves.toBe(false);
    expect(failingThenOk).toHaveBeenCalledTimes(2);
    expect(notifier.getDeliveryCounts()).toEqual({
      success: 0,
      failed: 2,
      dropped: 1,
    });

    await expect(notifier.notifyFinding(event)).resolves.toBe(true);
    expect(failingThenOk).toHaveBeenCalledTimes(3);
    expect(notifier.getDeliveryCounts()).toEqual({
      success: 1,
      failed: 2,
      dropped: 1,
    });
  });

  test('holds re-delivery during failure cooldown then allows a POST after it expires', async () => {
    let nowMs = sentAt.getTime();
    const now = () => new Date(nowMs);
    const failingFetch = vi.fn(async () => new Response('nope', { status: 500 }));
    const { notifier } = setup(failingFetch, {
      maxAttempts: 1,
      failureCooldownMs: 60_000,
    }, now);
    const event = {
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::cooldown',
    };

    await expect(notifier.notifyFinding(event)).resolves.toBe(false);
    await expect(notifier.notifyFinding(event)).resolves.toBe(false);
    expect(failingFetch).toHaveBeenCalledTimes(1);

    nowMs += 60_001;
    await expect(notifier.notifyFinding(event)).resolves.toBe(false);
    expect(failingFetch).toHaveBeenCalledTimes(2);
  });

  test('clearFingerprint prevents a late in-flight failure from re-arming cooldown', async () => {
    let releaseFail!: (value: Response) => void;
    const slowFail = vi.fn(() => new Promise<Response>((resolve) => {
      releaseFail = resolve;
    }));
    const okFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    let fetchImpl: typeof fetch = slowFail as typeof fetch;
    const { notifier } = setup((...args) => fetchImpl(...args), {
      maxAttempts: 1,
      failureCooldownMs: 60_000,
    });
    const event = {
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::clear race',
    };

    const first = notifier.notifyFinding(event);
    // Wait until the in-flight POST is parked on the deferred.
    await vi.waitFor(() => {
      expect(slowFail).toHaveBeenCalledTimes(1);
    });
    notifier.clearFingerprint(event);
    fetchImpl = okFetch;
    releaseFail(new Response('nope', { status: 500 }));
    await expect(first).resolves.toBe(false);

    // Cooldown must NOT be armed by the late failure — re-admit should POST now.
    await expect(notifier.notifyFinding(event)).resolves.toBe(true);
    expect(okFetch).toHaveBeenCalledTimes(1);
  });

  test('increments success delivery counter on a successful POST', async () => {
    const { notifier } = setup();
    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly(),
      fingerprint: 'permission_blocked::counter success',
    })).resolves.toBe(true);
    expect(notifier.getDeliveryCounts()).toEqual({
      success: 1,
      failed: 0,
      dropped: 0,
    });
  });

  test('structured failure log never includes the full webhook URL', async () => {
    const clientFetch = vi.fn(async () => new Response('nope', { status: 400 }));
    const { notifier, logger } = setup(clientFetch, {
      url: 'https://hooks.pagerduty.example/v1/token-secret-value/enqueue',
      maxAttempts: 1,
    });
    await notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ severity: 'critical' }),
      fingerprint: 'permission_blocked::secret url',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[webhook] failed to deliver finding',
      expect.objectContaining({
        host: 'hooks.pagerduty.example',
        fingerprint: 'permission_blocked::secret url',
        agentId: 'session-1',
        severity: 'critical',
        attempts: 1,
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('token-secret-value');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('/v1/');
  });

  test('records webhook network errors in delivery trace outcomes', async () => {
    const networkFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { notifier, deliveryTrace } = setup(networkFetch);

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ eventId: 'evt-network' }),
      fingerprint: 'permission_blocked::network retry',
    })).resolves.toBe(true);

    expect(deliveryTrace.snapshot({ correlationId: 'evt-network' }).records).toEqual([
      expect.objectContaining({ stage: 'webhook_attempt', attempt: 1 }),
      expect.objectContaining({ stage: 'webhook_result', attempt: 1, outcome: 'failure', error: 'network down' }),
      expect.objectContaining({ stage: 'webhook_attempt', attempt: 2 }),
      expect.objectContaining({ stage: 'webhook_result', attempt: 2, outcome: 'success', httpStatus: 200 }),
    ]);
  });

  test('records webhook retry attempts and success/failure outcomes', async () => {
    const transientFetch = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { notifier, deliveryTrace } = setup(transientFetch, {
      maxAttempts: 2,
      initialRetryDelayMs: 0,
    });

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ eventId: 'evt-retry' }),
      fingerprint: 'permission_blocked::retry outcome',
    })).resolves.toBe(true);

    expect(deliveryTrace.snapshot({ correlationId: 'evt-retry' }).records).toEqual([
      expect.objectContaining({ stage: 'webhook_attempt', attempt: 1 }),
      expect.objectContaining({ stage: 'webhook_result', attempt: 1, outcome: 'failure', httpStatus: 502 }),
      expect.objectContaining({ stage: 'webhook_attempt', attempt: 2 }),
      expect.objectContaining({ stage: 'webhook_result', attempt: 2, outcome: 'success', httpStatus: 200 }),
    ]);
  });

  test('records webhook terminal failure outcomes', async () => {
    const failingFetch = vi.fn(async () => new Response('bad request', { status: 400 }));
    const { notifier, deliveryTrace } = setup(failingFetch);

    await expect(notifier.notifyFinding({
      agentId: 'session-1',
      anomaly: anomaly({ eventId: 'evt-400' }),
      fingerprint: 'permission_blocked::bad request outcome',
    })).resolves.toBe(false);

    expect(deliveryTrace.snapshot({ correlationId: 'evt-400' }).records).toEqual([
      expect.objectContaining({ stage: 'webhook_attempt', attempt: 1 }),
      expect.objectContaining({ stage: 'webhook_result', attempt: 1, outcome: 'failure', httpStatus: 400 }),
    ]);
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

describe('payload body schema documentation', () => {
  test('documents the current schemaVersion constant in configuration.md', () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'configuration.md'), 'utf8');
    // Guards against the documented wire contract drifting from the source
    // constant when WEBHOOK_PAYLOAD_SCHEMA_VERSION is bumped.
    expect(doc).toContain(WEBHOOK_PAYLOAD_SCHEMA_VERSION);
    expect(doc).toContain('### Payload body schema');
  });

  test('documents every WebhookFindingPayload field', () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'configuration.md'), 'utf8');
    // Every field of WebhookFindingPayload (top-level, finding, task) must
    // appear as a `field` cell in the doc tables. TS interfaces are erased at
    // runtime, so this list is maintained by hand: extend it when a field is
    // added to WebhookFindingPayload in ./index.ts. It catches a field renamed
    // or dropped from the doc, not one newly added to the interface.
    const documentedFields = [
      'schemaVersion', 'event', 'fingerprint', 'sentAt', 'dashboardUrl', 'finding', 'task',
      'agentId', 'type', 'severity', 'explanation', 'detectedAt', 'count', 'subType', 'confidence', 'eventId',
      'id', 'name', 'prompt', 'cwd', 'status',
    ];
    for (const field of documentedFields) {
      expect(doc, `field \`${field}\` is missing from docs/configuration.md`).toContain(`\`${field}\``);
    }
  });
});
