import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Anomaly, AnomalySeverity } from '../../core/types.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import type { DeliveryTraceRecorder } from '../../core/delivery-trace.js';
import type { ProjectWebhookRoutingSettings } from '../../shared/contracts/project-config.js';

export const WEBHOOK_PAYLOAD_SCHEMA_VERSION = 'kookr.finding.webhook.v1';
/** Hard cap on KOOKR_WEBHOOK_URL length (env/config abuse / log noise). */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

const DEFAULT_MIN_SEVERITY: AnomalySeverity = 'info';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000;
/** Default POST timeout; long enough for slow-but-healthy receivers, short enough not to wedge the finding pipeline. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** After a permanent delivery failure, suppress re-delivery for this long to avoid a hot loop. */
const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;

const WEBHOOK_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostnames that always resolve to cloud instance-metadata services. */
const WEBHOOK_BLOCKED_METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export const WEBHOOK_DELIVERY_OUTCOMES = ['success', 'failed', 'dropped'] as const;
export type WebhookDeliveryOutcome = typeof WEBHOOK_DELIVERY_OUTCOMES[number];
export type WebhookDeliveryCounts = Record<WebhookDeliveryOutcome, number>;

class PermanentWebhookError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'PermanentWebhookError';
  }
}

class ExhaustedWebhookError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'ExhaustedWebhookError';
  }
}

export interface WebhookConfig {
  url: string;
  minSeverity: AnomalySeverity;
  maxAttempts: number;
  initialRetryDelayMs: number;
  /** AbortController timeout for each outbound POST attempt. */
  requestTimeoutMs: number;
  /** After exhausted retries, hold off re-delivery of the same key for this long. */
  failureCooldownMs: number;
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

export type WebhookUrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Validate KOOKR_WEBHOOK_URL before any server-side fetch.
 *
 * Fail-closed by default: only public http(s) endpoints are accepted.
 * Loopback, RFC1918, CGNAT, and ULA are rejected unless `allowPrivate` is set
 * (operator opt-in via KOOKR_WEBHOOK_ALLOW_PRIVATE). Cloud metadata hosts and
 * link-local addresses are always rejected — private-LAN opt-in is not a
 * metadata SSRF loophole.
 */
export function validateWebhookUrl(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): WebhookUrlValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'webhook URL must be a string' };
  }

  const endpoint = raw.trim();
  if (endpoint.length === 0) {
    return { ok: false, reason: 'webhook URL is required' };
  }
  if (endpoint.length > MAX_WEBHOOK_URL_LENGTH) {
    return { ok: false, reason: 'webhook URL is too long' };
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'webhook URL must be a valid URL' };
  }

  if (!WEBHOOK_ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'webhook URL must use http or https' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'webhook URL must not include credentials' };
  }

  const hostname = normalizeWebhookHostname(url.hostname);
  if (!hostname) {
    return { ok: false, reason: 'webhook URL host is required' };
  }

  if (isBlockedMetadataHostname(hostname)) {
    return { ok: false, reason: 'webhook URL host is not allowed' };
  }

  if (!opts.allowPrivate && isBlockedLoopbackHostname(hostname)) {
    return { ok: false, reason: 'webhook URL host is not allowed' };
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isBlockedWebhookIPv4(hostname, opts.allowPrivate === true)) {
    return { ok: false, reason: 'webhook URL address is not allowed' };
  }
  if (ipVersion === 6 && isBlockedWebhookIPv6(hostname, opts.allowPrivate === true)) {
    return { ok: false, reason: 'webhook URL address is not allowed' };
  }

  return { ok: true, url: endpoint };
}

export function readWebhookConfigFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { dashboardBaseUrl?: string; logger?: Pick<Console, 'warn'> } = {},
): WebhookConfig | null {
  const rawUrl = env.KOOKR_WEBHOOK_URL?.trim();
  if (!rawUrl) return null;

  const allowPrivate = isTruthyEnvFlag(env.KOOKR_WEBHOOK_ALLOW_PRIVATE);
  const validation = validateWebhookUrl(rawUrl, { allowPrivate });
  if (!validation.ok) {
    opts.logger?.warn(
      `[webhook] ignoring invalid KOOKR_WEBHOOK_URL (${validation.reason}); outbound finding webhook disabled`,
    );
    return null;
  }

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
    url: validation.url,
    minSeverity,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    initialRetryDelayMs: DEFAULT_INITIAL_RETRY_DELAY_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    failureCooldownMs: DEFAULT_FAILURE_COOLDOWN_MS,
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
  /** Dedupe keys that recently failed permanently; value is epoch-ms when re-delivery is allowed. */
  private readonly failureCooldownUntil = new Map<string, number>();
  /**
   * Monotonic generation per dedupe key. In-flight deliveries capture their
   * generation at start; late failures must not re-arm cooldown or delete
   * notified if clearFingerprint / a newer delivery already advanced it.
   */
  private readonly deliveryGeneration = new Map<string, number>();
  private readonly deliveryCounts: WebhookDeliveryCounts = {
    success: 0,
    failed: 0,
    dropped: 0,
  };

  constructor(deps: WebhookNotifierDeps) {
    this.config = deps.config;
    this.taskStore = deps.taskStore;
    this.deliveryTrace = deps.deliveryTrace;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? console;
  }

  getDeliveryCounts(): WebhookDeliveryCounts {
    return { ...this.deliveryCounts };
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
    const cooldownUntil = this.failureCooldownUntil.get(dedupeKey);
    if (cooldownUntil !== undefined) {
      if (this.now().getTime() < cooldownUntil) {
        this.deliveryTrace?.recordSuppressed(event, 'webhook_dedupe');
        return false;
      }
      this.failureCooldownUntil.delete(dedupeKey);
    }
    if (this.notified.has(dedupeKey)) {
      this.deliveryTrace?.recordSuppressed(event, 'webhook_dedupe');
      return false;
    }

    const myGeneration = (this.deliveryGeneration.get(dedupeKey) ?? 0) + 1;
    this.deliveryGeneration.set(dedupeKey, myGeneration);
    this.notified.add(dedupeKey);
    const payload = this.buildPayload(event);
    try {
      await this.postWithRetry(payload);
      return true;
    } catch (err) {
      // Only the current generation may release/cooldown — late failures after
      // clearFingerprint or a newer delivery must not re-arm suppression.
      if (this.deliveryGeneration.get(dedupeKey) === myGeneration) {
        this.notified.delete(dedupeKey);
        if (this.config.failureCooldownMs > 0) {
          this.failureCooldownUntil.set(dedupeKey, this.now().getTime() + this.config.failureCooldownMs);
        }
      }
      this.incrementDelivery('dropped');
      const attempts = deliveryAttemptsFromError(err) ?? this.config.maxAttempts;
      this.logger.warn('[webhook] failed to deliver finding', {
        fingerprint: event.fingerprint,
        agentId: event.agentId,
        severity: event.anomaly.severity,
        host: webhookHost(this.config.url),
        attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  clearFingerprint(event: Pick<WebhookFindingEvent, 'agentId' | 'fingerprint'>): void {
    const key = this.dedupeKey(event);
    this.notified.delete(key);
    this.failureCooldownUntil.delete(key);
    // Bump generation so an in-flight failure cannot re-arm cooldown.
    this.deliveryGeneration.set(key, (this.deliveryGeneration.get(key) ?? 0) + 1);
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

  private incrementDelivery(outcome: WebhookDeliveryOutcome): void {
    this.deliveryCounts[outcome] += 1;
  }

  private async postWithRetry(payload: WebhookFindingPayload): Promise<void> {
    let lastError: Error | null = null;
    const body = JSON.stringify(payload);
    const traceEvent = webhookPayloadToTraceEvent(payload);
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      this.deliveryTrace?.recordWebhookAttempt(traceEvent, attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(this.config.url, {
          method: 'POST',
          redirect: 'manual',
          headers: this.buildHeaders(body),
          body,
          signal: controller.signal,
        });
        if (response.ok) {
          this.deliveryTrace?.recordWebhookResult(traceEvent, {
            attempt,
            outcome: 'success',
            httpStatus: response.status,
          });
          this.incrementDelivery('success');
          return;
        }
        this.deliveryTrace?.recordWebhookResult(traceEvent, {
          attempt,
          outcome: 'failure',
          httpStatus: response.status,
        });
        this.incrementDelivery('failed');
        if (response.status >= 400 && response.status < 500) {
          throw new PermanentWebhookError(`webhook returned ${response.status}`, attempt);
        }
        lastError = new Error(`webhook returned ${response.status}`);
      } catch (err) {
        if (err instanceof PermanentWebhookError) throw err;
        lastError = normalizeFetchError(err, this.config.requestTimeoutMs);
        this.deliveryTrace?.recordWebhookResult(traceEvent, {
          attempt,
          outcome: 'failure',
          error: lastError.message,
        });
        this.incrementDelivery('failed');
      } finally {
        clearTimeout(timer);
      }

      if (attempt < this.config.maxAttempts) {
        await delay(this.retryDelayMs(attempt));
      } else {
        throw new ExhaustedWebhookError(
          lastError?.message ?? 'unknown webhook delivery failure',
          attempt,
        );
      }
    }
    throw new ExhaustedWebhookError(
      lastError?.message ?? 'unknown webhook delivery failure',
      this.config.maxAttempts,
    );
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

const SEVERITY_RANK: Record<AnomalySeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

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

/** Host only — never the full URL, which may embed a token in the path. */
function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function deliveryAttemptsFromError(err: unknown): number | undefined {
  if (err instanceof PermanentWebhookError || err instanceof ExhaustedWebhookError) {
    return err.attempts;
  }
  return undefined;
}

function normalizeFetchError(err: unknown, requestTimeoutMs: number): Error {
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new Error(`webhook request timed out after ${requestTimeoutMs}ms`);
    }
    return err;
  }
  return new Error(String(err));
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTruthyEnvFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function normalizeWebhookHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower;
}

function isBlockedMetadataHostname(hostname: string): boolean {
  return WEBHOOK_BLOCKED_METADATA_HOSTNAMES.has(hostname);
}

function isBlockedLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * Always-blocked: unspecified, link-local (cloud metadata), multicast, reserved.
 * When `allowPrivate` is false, also block loopback + RFC1918 + CGNAT.
 */
function isBlockedWebhookIPv4(address: string, allowPrivate: boolean): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }

  const [a, b] = octets as [number, number, number, number];

  // Always unsafe for outbound webhook SSRF regardless of private opt-in.
  if (
    a === 0 // 0.0.0.0/8 unspecified
    || (a === 169 && b === 254) // 169.254.0.0/16 link-local / cloud metadata
    || a >= 224 // multicast + reserved
  ) {
    return true;
  }

  if (allowPrivate) return false;

  return a === 10 // 10.0.0.0/8
    || a === 127 // 127.0.0.0/8 loopback
    || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
    || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12
    || (a === 192 && b === 168); // 192.168.0.0/16
}

function isBlockedWebhookIPv6(address: string, allowPrivate: boolean): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true;

  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLoopback =
    bytes.slice(0, 15).every((byte) => byte === 0)
    && bytes[15] === 1;
  const isLinkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const isMulticast = bytes[0] === 0xff;
  const isUniqueLocal = (bytes[0] & 0xfe) === 0xfc; // fc00::/7
  const isIPv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;

  if (isIPv4Mapped) {
    return isBlockedWebhookIPv4(
      `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      allowPrivate,
    );
  }

  if (isUnspecified || isLinkLocal || isMulticast) return true;
  if (allowPrivate) return false;
  return isLoopback || isUniqueLocal;
}

function ipv6ToBytes(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const left = parseIPv6Groups(halves[0] ?? '');
  const right = parseIPv6Groups(halves[1] ?? '');
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (groups.length !== 8) return null;

  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function parseIPv6Groups(value: string): number[] | null {
  if (value === '') return [];
  // Drop zone id if present (fe80::1%eth0) — treat as invalid for URL host form.
  if (value.includes('%')) return null;
  const groups = value.split(':').map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return Number.NaN;
    return Number.parseInt(group, 16);
  });
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}
