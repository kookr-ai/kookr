import { createHmac } from 'node:crypto';
import type { Anomaly, AnomalySeverity } from '../../core/types.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import type { DeliveryTraceRecorder } from '../../core/delivery-trace.js';
import type { ProjectWebhookRoutingSettings } from '../../shared/contracts/project-config.js';

export const WEBHOOK_PAYLOAD_SCHEMA_VERSION = 'kookr.finding.webhook.v1';

const DEFAULT_MIN_SEVERITY: AnomalySeverity = 'info';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000;

const SEVERITY_RANK: Record<AnomalySeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

class PermanentWebhookError extends Error {}

export interface WebhookConfig {
  url: string;
  minSeverity: AnomalySeverity;
  maxAttempts: number;
  initialRetryDelayMs: number;
  dashboardBaseUrl?: string;
  signingSecrets?: readonly string[];
}

export interface WebhookFindingPayload {
  schemaVersion: typeof WEBHOOK_PAYLOAD_SCHEMA_VERSION;
  event: 'finding.admitted';
  fingerprint: string;
  sentAt: string;
  dashboardUrl?: string;
  finding: {
    agentId: string;
    type: Anomaly['type'];
    severity: AnomalySeverity;
    explanation: string;
    detectedAt: string;
    count?: number;
    subType?: Anomaly['subType'];
    confidence?: Anomaly['confidence'];
    eventId?: string;
  };
  task?: {
    id: string;
    name?: string;
    prompt: string;
    cwd: string;
    status: Task['status'];
  };
}

export interface WebhookNotifierDeps {
  config: WebhookConfig;
  taskStore: Pick<TaskStore, 'findTaskBySession' | 'getTask'>;
  deliveryTrace?: DeliveryTraceRecorder;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}

export interface WebhookFindingEvent {
  agentId: string;
  anomaly: Anomaly;
  fingerprint: string;
}

export interface WebhookRouting {
  enabled: boolean;
  minSeverity: AnomalySeverity;
}

export function resolveWebhookRouting(input: {
  globalMinSeverity: AnomalySeverity;
  projectWebhook?: ProjectWebhookRoutingSettings;
}): WebhookRouting {
  return {
    enabled: input.projectWebhook?.enabled ?? true,
    minSeverity: input.projectWebhook?.minSeverity ?? input.globalMinSeverity,
  };
}

export function readWebhookConfigFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { dashboardBaseUrl?: string; logger?: Pick<Console, 'warn'> } = {},
): WebhookConfig | null {
  const url = env.KOOKR_WEBHOOK_URL?.trim();
  if (!url) return null;

  let minSeverity = DEFAULT_MIN_SEVERITY;
  const rawMinSeverity = env.KOOKR_WEBHOOK_MIN_SEVERITY?.trim();
  if (rawMinSeverity) {
    if (isSeverity(rawMinSeverity)) {
      minSeverity = rawMinSeverity;
    } else {
      opts.logger?.warn(`[webhook] ignoring invalid KOOKR_WEBHOOK_MIN_SEVERITY=${JSON.stringify(rawMinSeverity)}; using ${DEFAULT_MIN_SEVERITY}`);
    }
  }

  return {
    url,
    minSeverity,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    initialRetryDelayMs: DEFAULT_INITIAL_RETRY_DELAY_MS,
    ...parseSigningSecrets(env.KOOKR_WEBHOOK_SECRET),
    ...(opts.dashboardBaseUrl ? { dashboardBaseUrl: opts.dashboardBaseUrl } : {}),
  };
}

export function buildDashboardBaseUrl(input: {
  host: string;
  port: number;
  env: NodeJS.ProcessEnv;
}): string {
  const publicBaseUrl = input.env.KOOKR_PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/, '');

  const host = input.host === '0.0.0.0' || input.host === '::' ? '127.0.0.1' : input.host;
  const bracketedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketedHost}:${input.port}`;
}

export class WebhookNotifier {
  private readonly config: WebhookConfig;
  private readonly taskStore: Pick<TaskStore, 'findTaskBySession' | 'getTask'>;
  private readonly deliveryTrace: DeliveryTraceRecorder | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly notified = new Set<string>();

  constructor(deps: WebhookNotifierDeps) {
    this.config = deps.config;
    this.taskStore = deps.taskStore;
    this.deliveryTrace = deps.deliveryTrace;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? console;
  }

  async notifyFinding(event: WebhookFindingEvent, routing?: WebhookRouting): Promise<boolean> {
    const effectiveRouting = routing ?? resolveWebhookRouting({
      globalMinSeverity: this.config.minSeverity,
    });
    if (!effectiveRouting.enabled) {
      this.deliveryTrace?.recordSuppressed(event, 'webhook_disabled');
      return false;
    }
    if (!this.shouldSend(event.anomaly.severity, effectiveRouting.minSeverity)) {
      this.deliveryTrace?.recordSuppressed(event, 'below_min_severity');
      return false;
    }
    const dedupeKey = this.dedupeKey(event);
    if (this.notified.has(dedupeKey)) {
      this.deliveryTrace?.recordSuppressed(event, 'webhook_dedupe');
      return false;
    }

    this.notified.add(dedupeKey);
    const payload = this.buildPayload(event);
    try {
      await this.postWithRetry(payload);
      return true;
    } catch (err) {
      this.logger.warn(`[webhook] failed to deliver finding: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  clearFingerprint(event: Pick<WebhookFindingEvent, 'agentId' | 'fingerprint'>): void {
    this.notified.delete(this.dedupeKey(event));
  }

  buildPayload(event: WebhookFindingEvent): WebhookFindingPayload {
    const task = this.taskStore.findTaskBySession(event.agentId);
    const latestTask = task ? this.taskStore.getTask(task.id) ?? task : undefined;
    return {
      schemaVersion: WEBHOOK_PAYLOAD_SCHEMA_VERSION,
      event: 'finding.admitted',
      fingerprint: event.fingerprint,
      sentAt: this.now().toISOString(),
      ...(this.config.dashboardBaseUrl ? { dashboardUrl: this.config.dashboardBaseUrl } : {}),
      finding: {
        agentId: event.agentId,
        type: event.anomaly.type,
        severity: event.anomaly.severity,
        explanation: event.anomaly.explanation,
        detectedAt: event.anomaly.detectedAt.toISOString(),
        ...(event.anomaly.count !== undefined ? { count: event.anomaly.count } : {}),
        ...(event.anomaly.subType ? { subType: event.anomaly.subType } : {}),
        ...(event.anomaly.confidence ? { confidence: event.anomaly.confidence } : {}),
        ...(event.anomaly.eventId ? { eventId: event.anomaly.eventId } : {}),
      },
      ...(latestTask ? {
        task: {
          id: latestTask.id,
          ...(latestTask.name ? { name: latestTask.name } : {}),
          prompt: latestTask.prompt,
          cwd: latestTask.cwd,
          status: latestTask.status,
        },
      } : {}),
    };
  }

  private shouldSend(severity: AnomalySeverity, minSeverity: AnomalySeverity): boolean {
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
  }

  private dedupeKey(event: Pick<WebhookFindingEvent, 'agentId' | 'fingerprint'>): string {
    return `${event.agentId}:${event.fingerprint}`;
  }

  private async postWithRetry(payload: WebhookFindingPayload): Promise<void> {
    let lastError: Error | null = null;
    const body = JSON.stringify(payload);
    const traceEvent = webhookPayloadToTraceEvent(payload);
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      this.deliveryTrace?.recordWebhookAttempt(traceEvent, attempt);
      try {
        const response = await this.fetchImpl(this.config.url, {
          method: 'POST',
          redirect: 'manual',
          headers: this.buildHeaders(body),
          body,
        });
        if (response.ok) {
          this.deliveryTrace?.recordWebhookResult(traceEvent, {
            attempt,
            outcome: 'success',
            httpStatus: response.status,
          });
          return;
        }
        this.deliveryTrace?.recordWebhookResult(traceEvent, {
          attempt,
          outcome: 'failure',
          httpStatus: response.status,
        });
        if (response.status >= 400 && response.status < 500) {
          throw new PermanentWebhookError(`webhook returned ${response.status}`);
        }
        lastError = new Error(`webhook returned ${response.status}`);
      } catch (err) {
        if (err instanceof PermanentWebhookError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        this.deliveryTrace?.recordWebhookResult(traceEvent, {
          attempt,
          outcome: 'failure',
          error: lastError.message,
        });
      }

      if (attempt < this.config.maxAttempts) {
        await delay(this.retryDelayMs(attempt));
      }
    }
    throw lastError ?? new Error('unknown webhook delivery failure');
  }

  private retryDelayMs(attempt: number): number {
    return this.config.initialRetryDelayMs * 2 ** (attempt - 1);
  }

  private buildHeaders(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'kookr-webhook',
    };
    const signature = this.buildSignatureHeader(body);
    if (signature) {
      headers['X-Kookr-Signature'] = signature;
    }
    return headers;
  }

  private buildSignatureHeader(body: string): string | undefined {
    const secret = this.config.signingSecrets?.[0];
    if (!secret) return undefined;

    const timestamp = Math.floor(this.now().getTime() / 1_000);
    const digest = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return `t=${timestamp},v1=${digest}`;
  }
}

function isSeverity(value: string): value is AnomalySeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

function parseSigningSecrets(raw: string | undefined): Pick<WebhookConfig, 'signingSecrets'> {
  const signingSecrets = raw
    ?.split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
  return signingSecrets?.length ? { signingSecrets } : {};
}

function webhookPayloadToTraceEvent(payload: WebhookFindingPayload): WebhookFindingEvent {
  return {
    agentId: payload.finding.agentId,
    fingerprint: payload.fingerprint,
    anomaly: {
      agentId: payload.finding.agentId,
      type: payload.finding.type,
      severity: payload.finding.severity,
      explanation: '',
      detectedAt: new Date(payload.finding.detectedAt),
      ...(payload.finding.count !== undefined ? { count: payload.finding.count } : {}),
      ...(payload.finding.subType ? { subType: payload.finding.subType } : {}),
      ...(payload.finding.confidence ? { confidence: payload.finding.confidence } : {}),
      ...(payload.finding.eventId ? { eventId: payload.finding.eventId } : {}),
    },
  };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
