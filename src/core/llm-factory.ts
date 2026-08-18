/**
 * Provider-neutral fallback, audit, and diagnostics policy for LLM clients.
 */

import {
  classifyLlmProviderHttpStatus,
  LLM_PROVIDER_FAILURE_CATEGORIES,
  isLlmProviderFailureCategory,
  type HelperLlmDiagnosticsCounters,
  type HelperLlmDiagnosticsSnapshot,
  type HelperLlmPausedProvider,
  type HelperLlmProviderAttemptBudget,
  type LlmClient,
  type LlmCompletionAuditResult,
  type LlmCompletionDetail,
  type LlmCompletionRequest,
  type LlmProviderFailureCategory,
  type LlmProviderFailureRecord,
  type LlmUseCase,
} from './llm-types.js';

/**
 * Default cool-down after an auth / expired_api_key / HTTP 410 Gone failure
 * before the provider is tried again. Long enough that unattended helper calls
 * stop hammering a dead key or removed model every request; short enough that
 * fixing the key or swapping the model recovers without a process restart.
 * Override with `KOOKR_LLM_AUTH_COOLDOWN_MS` (`0` disables).
 */
export const DEFAULT_LLM_AUTH_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Process-wide cap on helper-LLM *provider network attempts* inside a sliding
 * window (issue #2083). Free-tier 429 storms cascade through every fallback
 * provider on each naming/summary call; this budget stops further network once
 * the window is full and returns a deterministic degrade instead.
 *
 * Sized for normal multi-task load (several concurrent naming/summary calls
 * across a short fallback chain) while still bounding thrash. Override with
 * `KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET` (`0` disables) and
 * `KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS`.
 */
export const DEFAULT_LLM_PROVIDER_ATTEMPT_BUDGET = 90;
export const DEFAULT_LLM_PROVIDER_ATTEMPT_WINDOW_MS = 60_000;

export function resolveLlmAuthCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KOOKR_LLM_AUTH_COOLDOWN_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_LLM_AUTH_COOLDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LLM_AUTH_COOLDOWN_MS;
  return Math.floor(parsed);
}

export function resolveLlmProviderAttemptBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET?.trim();
  if (raw === undefined || raw === '') return DEFAULT_LLM_PROVIDER_ATTEMPT_BUDGET;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LLM_PROVIDER_ATTEMPT_BUDGET;
  return Math.floor(parsed);
}

export function resolveLlmProviderAttemptWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_LLM_PROVIDER_ATTEMPT_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_PROVIDER_ATTEMPT_WINDOW_MS;
  return Math.floor(parsed);
}

interface AuthPausedEntry {
  provider: string;
  model: string;
  reason: 'auth';
  pausedAt: number;
  pausedUntil: number;
  skipCount: number;
  lastMessage: string;
}

const authPausedProviders = new Map<string, AuthPausedEntry>();

function authPauseKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function pruneExpiredAuthPauses(now: number = Date.now()): void {
  for (const [key, entry] of authPausedProviders) {
    if (entry.pausedUntil <= now) authPausedProviders.delete(key);
  }
}

function getActiveAuthPause(provider: string, model: string, now: number = Date.now()): AuthPausedEntry | null {
  const key = authPauseKey(provider, model);
  const entry = authPausedProviders.get(key);
  if (!entry) return null;
  if (entry.pausedUntil <= now) {
    authPausedProviders.delete(key);
    return null;
  }
  return entry;
}

function pauseProviderAfterAuthFailure(
  client: LlmClient,
  message: string,
  now: number = Date.now(),
  cooldownMs: number = resolveLlmAuthCooldownMs(),
): AuthPausedEntry | null {
  if (cooldownMs <= 0) return null;
  const key = authPauseKey(client.provider, client.model);
  const existing = authPausedProviders.get(key);
  const entry: AuthPausedEntry = {
    provider: client.provider,
    model: client.model,
    reason: 'auth',
    pausedAt: existing?.pausedAt ?? now,
    pausedUntil: now + cooldownMs,
    skipCount: existing?.skipCount ?? 0,
    lastMessage: message,
  };
  authPausedProviders.set(key, entry);
  return entry;
}

function recordAuthPauseSkip(entry: AuthPausedEntry): void {
  entry.skipCount += 1;
}

function listPausedProviders(now: number = Date.now()): HelperLlmPausedProvider[] {
  pruneExpiredAuthPauses(now);
  return [...authPausedProviders.values()]
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      reason: entry.reason,
      pausedAt: entry.pausedAt,
      pausedUntil: entry.pausedUntil,
      remainingMs: Math.max(0, entry.pausedUntil - now),
      skipCount: entry.skipCount,
      lastMessage: entry.lastMessage,
    }))
    .sort((a, b) => `${a.provider}\0${a.model}`.localeCompare(`${b.provider}\0${b.model}`));
}

/** Ascending timestamps of recent provider network attempts (process-wide). */
const providerAttemptTimestamps: number[] = [];
/** Lifetime count of attempts refused because the sliding-window budget was full. */
let stormsSuppressedTotal = 0;

function pruneProviderAttemptWindow(now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  let firstLive = 0;
  while (firstLive < providerAttemptTimestamps.length && providerAttemptTimestamps[firstLive]! <= cutoff) {
    firstLive += 1;
  }
  if (firstLive > 0) providerAttemptTimestamps.splice(0, firstLive);
}

/**
 * Reserve one process-wide provider network attempt. When the budget is
 * exhausted, returns false and increments {@link stormsSuppressedTotal}
 * without recording a timestamp (a refused attempt must not burn the budget).
 * `limit <= 0` disables the budget and always allows.
 */
function tryAcquireProviderAttempt(now: number = Date.now()): boolean {
  const limit = resolveLlmProviderAttemptBudget();
  if (limit <= 0) return true;

  const windowMs = resolveLlmProviderAttemptWindowMs();
  pruneProviderAttemptWindow(now, windowMs);

  if (providerAttemptTimestamps.length >= limit) {
    stormsSuppressedTotal += 1;
    return false;
  }

  providerAttemptTimestamps.push(now);
  return true;
}

function getProviderAttemptBudgetSnapshot(now: number = Date.now()): HelperLlmProviderAttemptBudget {
  const limit = resolveLlmProviderAttemptBudget();
  const windowMs = resolveLlmProviderAttemptWindowMs();
  if (limit > 0) pruneProviderAttemptWindow(now, windowMs);
  return {
    limit,
    windowMs,
    attemptsInWindow: limit > 0 ? providerAttemptTimestamps.length : 0,
  };
}

function budgetExhaustedFailure(client: LlmClient, now: number = Date.now()): LlmProviderFailureRecord {
  const budget = getProviderAttemptBudgetSnapshot(now);
  return {
    provider: client.provider,
    model: client.model,
    category: 'other',
    message:
      `helper LLM provider attempt budget exhausted ` +
      `(${budget.attemptsInWindow}/${budget.limit} attempts in ${budget.windowMs}ms window); ` +
      `degrading without network`,
  };
}

function hasProviderFailureCategory(err: unknown): err is { providerFailureCategory: LlmProviderFailureCategory } {
  const category = (err as { providerFailureCategory?: unknown } | null)?.providerFailureCategory;
  return isLlmProviderFailureCategory(category);
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function classifyStatus(status: number | null): LlmProviderFailureCategory | null {
  if (status === null) return null;
  const category = classifyLlmProviderHttpStatus(status);
  return category === 'other' ? null : category;
}

export function classifyLlmProviderFailure(err: unknown): LlmProviderFailureCategory {
  if (hasProviderFailureCategory(err)) return err.providerFailureCategory;

  const shaped = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  } | null;
  const status = classifyStatus(
    numberFromUnknown(shaped?.status) ?? numberFromUnknown(shaped?.statusCode),
  );
  if (status) return status;

  const code = typeof shaped?.code === 'string' ? shaped.code.toUpperCase() : '';
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return 'network_timeout';
  }

  const text = `${typeof shaped?.name === 'string' ? shaped.name : ''} ${
    typeof shaped?.message === 'string' ? shaped.message : String(err)
  }`.toLowerCase();
  if (/unauthori[sz]ed|forbidden|invalid api key|api key|authentication|authorization|permission denied/.test(text)) {
    return 'auth';
  }
  if (/\b5\d\d\b|server error|bad gateway|service unavailable|gateway timeout/.test(text)) return 'server_5xx';
  if (/json|parse|malformed|invalid response|unexpected end|message content|choices/.test(text)) return 'malformed_response';
  if (/timed?\s*out|timeout|network|fetch failed|socket|dns|connection/.test(text)) return 'network_timeout';
  return 'other';
}

function emptyResponseFailure(client: LlmClient): LlmProviderFailureRecord {
  return {
    provider: client.provider,
    model: client.model,
    category: 'malformed_response',
    message: 'provider returned empty response',
  };
}

function caughtFailure(client: LlmClient, err: unknown): LlmProviderFailureRecord {
  return {
    provider: client.provider,
    model: client.model,
    category: classifyLlmProviderFailure(err),
    message: err instanceof Error ? err.message : String(err),
  };
}

type HelperLlmOutcome =
  | { kind: 'success' }
  | { kind: 'null_response'; category: LlmProviderFailureCategory }
  | { kind: 'error'; category: LlmProviderFailureCategory }
  | { kind: 'aborted' };

type MutableHelperLlmCounters = Omit<HelperLlmDiagnosticsCounters, 'averageLatencyMs'>;

interface HelperLlmBucket extends MutableHelperLlmCounters {
  useCase: LlmUseCase;
  provider: string;
  model: string;
}

const helperLlmBuckets = new Map<string, HelperLlmBucket>();
const ACCOUNTING_WRAPPED = Symbol('kookr.helperLlmAccountingWrapped');

function emptyCounters(): MutableHelperLlmCounters {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    nullResponseCount: 0,
    errorCount: 0,
    abortedCount: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    failureCategories: {},
  };
}

function bucketKey(useCase: LlmUseCase, provider: string, model: string): string {
  return `${useCase}\0${provider}\0${model}`;
}

function getBucket(useCase: LlmUseCase, provider: string, model: string): HelperLlmBucket {
  const key = bucketKey(useCase, provider, model);
  let bucket = helperLlmBuckets.get(key);
  if (!bucket) {
    bucket = { useCase, provider, model, ...emptyCounters() };
    helperLlmBuckets.set(key, bucket);
  }
  return bucket;
}

function recordHelperLlmOutcome(
  client: LlmClient,
  request: LlmCompletionRequest,
  startedAt: number,
  outcome: HelperLlmOutcome,
): void {
  const useCase = request.useCase ?? 'unspecified';
  const bucket = getBucket(useCase, client.provider, client.model);
  const latencyMs = Math.max(0, Date.now() - startedAt);
  bucket.requestCount += 1;
  bucket.totalLatencyMs += latencyMs;
  bucket.maxLatencyMs = Math.max(bucket.maxLatencyMs, latencyMs);

  switch (outcome.kind) {
    case 'success':
      bucket.successCount += 1;
      return;
    case 'null_response':
      bucket.failureCount += 1;
      bucket.nullResponseCount += 1;
      bucket.failureCategories[outcome.category] = (bucket.failureCategories[outcome.category] ?? 0) + 1;
      return;
    case 'error':
      bucket.failureCount += 1;
      bucket.errorCount += 1;
      bucket.failureCategories[outcome.category] = (bucket.failureCategories[outcome.category] ?? 0) + 1;
      return;
    case 'aborted':
      bucket.failureCount += 1;
      bucket.abortedCount += 1;
      bucket.failureCategories.other = (bucket.failureCategories.other ?? 0) + 1;
      return;
  }
}

function freezeCounters(counters: MutableHelperLlmCounters): HelperLlmDiagnosticsCounters {
  const requestCount = counters.requestCount;
  const failureCategories: Partial<Record<LlmProviderFailureCategory, number>> = {};
  for (const category of LLM_PROVIDER_FAILURE_CATEGORIES) {
    const count = counters.failureCategories[category];
    if (count) failureCategories[category] = count;
  }
  return {
    requestCount,
    successCount: counters.successCount,
    failureCount: counters.failureCount,
    nullResponseCount: counters.nullResponseCount,
    errorCount: counters.errorCount,
    abortedCount: counters.abortedCount,
    totalLatencyMs: Math.round(counters.totalLatencyMs),
    averageLatencyMs: requestCount > 0 ? Math.round(counters.totalLatencyMs / requestCount) : 0,
    maxLatencyMs: Math.round(counters.maxLatencyMs),
    failureCategories,
  };
}

function addCounters(target: MutableHelperLlmCounters, source: HelperLlmBucket): void {
  target.requestCount += source.requestCount;
  target.successCount += source.successCount;
  target.failureCount += source.failureCount;
  target.nullResponseCount += source.nullResponseCount;
  target.errorCount += source.errorCount;
  target.abortedCount += source.abortedCount;
  target.totalLatencyMs += source.totalLatencyMs;
  target.maxLatencyMs = Math.max(target.maxLatencyMs, source.maxLatencyMs);
  for (const [category, count] of Object.entries(source.failureCategories)) {
    if (!isLlmProviderFailureCategory(category)) continue;
    target.failureCategories[category] = (target.failureCategories[category] ?? 0) + (count ?? 0);
  }
}

export function getHelperLlmDiagnosticsSnapshot(): HelperLlmDiagnosticsSnapshot {
  const buckets = [...helperLlmBuckets.values()];
  const totals = emptyCounters();
  const useCases = new Map<LlmUseCase, MutableHelperLlmCounters>();
  const providers = new Map<string, MutableHelperLlmCounters & { provider: string; model: string }>();

  for (const bucket of buckets) {
    addCounters(totals, bucket);
    const useCaseCounters = useCases.get(bucket.useCase) ?? emptyCounters();
    addCounters(useCaseCounters, bucket);
    useCases.set(bucket.useCase, useCaseCounters);

    const providerKey = `${bucket.provider}\0${bucket.model}`;
    const providerCounters = providers.get(providerKey) ?? { provider: bucket.provider, model: bucket.model, ...emptyCounters() };
    addCounters(providerCounters, bucket);
    providers.set(providerKey, providerCounters);
  }

  const generatedAt = Date.now();
  return {
    schemaVersion: 'helper-llm-diagnostics.v1',
    generatedAt,
    totals: freezeCounters(totals),
    byUseCase: [...useCases.entries()]
      .map(([useCase, counters]) => ({ useCase, ...freezeCounters(counters) }))
      .sort((a, b) => a.useCase.localeCompare(b.useCase)),
    byProvider: [...providers.values()]
      .map(({ provider, model, ...counters }) => ({ provider, model, ...freezeCounters(counters) }))
      .sort((a, b) => `${a.provider}\0${a.model}`.localeCompare(`${b.provider}\0${b.model}`)),
    byUseCaseProvider: buckets
      .map((bucket) => ({
        useCase: bucket.useCase,
        provider: bucket.provider,
        model: bucket.model,
        ...freezeCounters(bucket),
      }))
      .sort((a, b) => `${a.useCase}\0${a.provider}\0${a.model}`.localeCompare(`${b.useCase}\0${b.provider}\0${b.model}`)),
    pausedProviders: listPausedProviders(generatedAt),
    stormsSuppressed: stormsSuppressedTotal,
    providerAttemptBudget: getProviderAttemptBudgetSnapshot(generatedAt),
  };
}

export function resetHelperLlmDiagnosticsForTest(): void {
  helperLlmBuckets.clear();
  authPausedProviders.clear();
  providerAttemptTimestamps.length = 0;
  stormsSuppressedTotal = 0;
}

export async function completeLlmWithFailureAudit(
  client: LlmClient,
  request: LlmCompletionRequest,
): Promise<LlmCompletionAuditResult> {
  if (client.completeWithFailureAudit) {
    return client.completeWithFailureAudit(request);
  }

  try {
    const text = await client.complete(request);
    if (text !== null) return { text, failures: [], failureCategory: null };
    const failure = emptyResponseFailure(client);
    return { text: null, failures: [failure], failureCategory: failure.category };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
    const failure = caughtFailure(client, err);
    return { text: null, failures: [failure], failureCategory: failure.category };
  }
}

/**
 * Complete and report the provider finish reason. Uses {@link LlmClient.completeDetailed}
 * when the client implements it; otherwise falls back to {@link LlmClient.complete}
 * and reports `finishReason: null` (unknown). Lets callers diagnose empty/truncated
 * completions (`finishReason === 'length'`) without every client having to implement
 * the richer method.
 */
export async function completeLlmDetailed(
  client: LlmClient,
  request: LlmCompletionRequest,
): Promise<LlmCompletionDetail> {
  if (client.completeDetailed) {
    return client.completeDetailed(request);
  }
  const text = await client.complete(request);
  return { text, finishReason: null };
}

export function withHelperLlmAccounting(client: LlmClient): LlmClient {
  if ((client as LlmClient & { [ACCOUNTING_WRAPPED]?: true })[ACCOUNTING_WRAPPED]) return client;
  return new HelperLlmAccountingClient(client);
}

class HelperLlmAccountingClient implements LlmClient {
  readonly [ACCOUNTING_WRAPPED] = true;

  constructor(private readonly inner: LlmClient) {}

  get provider(): string {
    return this.inner.provider;
  }

  get model(): string {
    return this.inner.model;
  }

  async complete(request: LlmCompletionRequest): Promise<string | null> {
    const startedAt = Date.now();
    try {
      const text = await this.inner.complete(request);
      recordHelperLlmOutcome(this.inner, request, startedAt, text === null
        ? { kind: 'null_response', category: 'malformed_response' }
        : { kind: 'success' });
      return text;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') {
        recordHelperLlmOutcome(this.inner, request, startedAt, { kind: 'aborted' });
        throw err;
      }
      recordHelperLlmOutcome(this.inner, request, startedAt, {
        kind: 'error',
        category: classifyLlmProviderFailure(err),
      });
      throw err;
    }
  }

  async completeDetailed(request: LlmCompletionRequest): Promise<LlmCompletionDetail> {
    const startedAt = Date.now();
    try {
      const detail = await completeLlmDetailed(this.inner, request);
      recordHelperLlmOutcome(this.inner, request, startedAt, detail.text === null
        ? { kind: 'null_response', category: 'malformed_response' }
        : { kind: 'success' });
      return detail;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') {
        recordHelperLlmOutcome(this.inner, request, startedAt, { kind: 'aborted' });
        throw err;
      }
      recordHelperLlmOutcome(this.inner, request, startedAt, {
        kind: 'error',
        category: classifyLlmProviderFailure(err),
      });
      throw err;
    }
  }

  async completeWithFailureAudit(request: LlmCompletionRequest): Promise<LlmCompletionAuditResult> {
    const startedAt = Date.now();
    try {
      const result = this.inner.completeWithFailureAudit
        ? await this.inner.completeWithFailureAudit(request)
        : await completeLlmWithFailureAudit(this.inner, request);
      recordHelperLlmOutcome(this.inner, request, startedAt, result.text === null
        ? { kind: 'null_response', category: result.failureCategory ?? 'malformed_response' }
        : { kind: 'success' });
      return result;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') {
        recordHelperLlmOutcome(this.inner, request, startedAt, { kind: 'aborted' });
        throw err;
      }
      recordHelperLlmOutcome(this.inner, request, startedAt, {
        kind: 'error',
        category: classifyLlmProviderFailure(err),
      });
      throw err;
    }
  }
}

/**
 * An LlmClient that tries multiple providers in order.
 * On any failure, the next provider is attempted. If all fail, returns null.
 *
 * Auth failures (expired/invalid API keys) long-pause the failing provider so
 * subsequent complete() calls skip it for a cool-down window instead of
 * re-hitting dead credentials on every helper call (issue #2033).
 *
 * Process-wide provider-attempt budget (issue #2083) caps network attempts
 * across all FallbackLlmClient instances so free-tier 429 cascades cannot
 * thrash the event loop; when exhausted the call degrades without network.
 */
export class FallbackLlmClient implements LlmClient {
  private clients: LlmClient[];

  constructor(clients: LlmClient[]) {
    if (clients.length === 0) {
      throw new Error('FallbackLlmClient requires at least one provider');
    }
    this.clients = clients;
  }

  get provider(): string {
    return this.clients.map(c => c.provider).join(' > ');
  }

  get model(): string {
    return this.clients[0].model;
  }

  async completeWithFailureAudit(request: LlmCompletionRequest): Promise<LlmCompletionAuditResult> {
    const failures: LlmProviderFailureRecord[] = [];
    let attemptedCount = 0;
    let skippedPausedCount = 0;
    let stormSuppressed = false;

    for (const client of this.clients) {
      // Re-check between providers so an abort that fired during the previous
      // attempt does not silently retry on the next provider. See R8 in
      // rfc-speak-agent-summary-v2 — the route's cancellation guarantee
      // depends on this loop short-circuiting.
      if (request.signal?.aborted) {
        const err = new Error('Request aborted');
        err.name = 'AbortError';
        throw err;
      }

      const paused = getActiveAuthPause(client.provider, client.model);
      if (paused) {
        recordAuthPauseSkip(paused);
        skippedPausedCount += 1;
        const remainingMs = Math.max(0, paused.pausedUntil - Date.now());
        const failure: LlmProviderFailureRecord = {
          provider: client.provider,
          model: client.model,
          category: 'auth',
          message: `provider paused for auth failure (${remainingMs}ms remaining): ${paused.lastMessage}`,
        };
        failures.push(failure);
        console.warn(
          `[llm] ${client.provider} (${client.model}) skipped category=auth: paused until ${new Date(paused.pausedUntil).toISOString()} after auth failure, trying next provider`,
        );
        continue;
      }

      if (!tryAcquireProviderAttempt()) {
        stormSuppressed = true;
        const failure = budgetExhaustedFailure(client);
        failures.push(failure);
        console.warn(
          `[llm] ${client.provider} (${client.model}) skipped: ${failure.message}`,
        );
        // Remaining providers would also be denied in this window — stop the
        // cascade without further network or extra counter noise.
        break;
      }

      attemptedCount += 1;
      try {
        const result = await client.complete(request);
        if (result !== null) {
          return { text: result, failures, failureCategory: null };
        }
        // null means the provider returned empty — try next
        const failure = emptyResponseFailure(client);
        failures.push(failure);
        console.warn(
          `[llm] ${client.provider} (${client.model}) failed category=${failure.category}: ${failure.message}, trying next provider`,
        );
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
        const failure = caughtFailure(client, err);
        failures.push(failure);
        if (failure.category === 'auth') {
          const entry = pauseProviderAfterAuthFailure(client, failure.message);
          if (entry) {
            console.warn(
              `[llm] ${client.provider} (${client.model}) failed category=auth: ${failure.message}; pausing until ${new Date(entry.pausedUntil).toISOString()} (cooldown ${entry.pausedUntil - entry.pausedAt}ms), trying next provider`,
            );
          } else {
            console.warn(
              `[llm] ${client.provider} (${client.model}) failed category=${failure.category}: ${failure.message}, trying next provider`,
            );
          }
        } else {
          console.warn(
            `[llm] ${client.provider} (${client.model}) failed category=${failure.category}: ${failure.message}, trying next provider`,
          );
        }
      }
    }

    if (attemptedCount === 0 && skippedPausedCount > 0 && !stormSuppressed) {
      console.warn(
        `[llm] all ${skippedPausedCount} provider(s) paused after auth failures — no provider attempted this call`,
      );
    }
    if (attemptedCount === 0 && stormSuppressed) {
      console.warn(
        `[llm] helper LLM provider attempt budget exhausted — no provider attempted this call`,
      );
    }

    const lastFailure = failures[failures.length - 1] ?? null;
    return { text: null, failures, failureCategory: lastFailure?.category ?? null };
  }

  async complete(request: LlmCompletionRequest): Promise<string | null> {
    return (await this.completeWithFailureAudit(request)).text;
  }

  /**
   * Like {@link complete} but preserves the finish reason of the last attempt so
   * an all-providers-empty outcome stays diagnosable (issue #1555). Returns the
   * first provider whose completion has text; otherwise the last attempt's
   * detail (which carries its finish reason).
   *
   * Honors the same auth-pause and attempt-budget paths as
   * {@link completeWithFailureAudit}.
   */
  async completeDetailed(request: LlmCompletionRequest): Promise<LlmCompletionDetail> {
    let lastDetail: LlmCompletionDetail = { text: null, finishReason: null };
    let attemptedCount = 0;
    let skippedPausedCount = 0;
    let stormSuppressed = false;

    for (const client of this.clients) {
      if (request.signal?.aborted) {
        const err = new Error('Request aborted');
        err.name = 'AbortError';
        throw err;
      }

      const paused = getActiveAuthPause(client.provider, client.model);
      if (paused) {
        recordAuthPauseSkip(paused);
        skippedPausedCount += 1;
        console.warn(
          `[llm] ${client.provider} (${client.model}) skipped category=auth: paused until ${new Date(paused.pausedUntil).toISOString()} after auth failure, trying next provider`,
        );
        continue;
      }

      if (!tryAcquireProviderAttempt()) {
        stormSuppressed = true;
        const failure = budgetExhaustedFailure(client);
        console.warn(
          `[llm] ${client.provider} (${client.model}) skipped: ${failure.message}`,
        );
        break;
      }

      attemptedCount += 1;
      try {
        const detail = await completeLlmDetailed(client, request);
        if (detail.text !== null) return detail;
        lastDetail = detail;
        console.warn(
          `[llm] ${client.provider} (${client.model}) returned empty response (finish_reason=${detail.finishReason ?? 'unknown'}), trying next provider`,
        );
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
        const failure = caughtFailure(client, err);
        if (failure.category === 'auth') {
          const entry = pauseProviderAfterAuthFailure(client, failure.message);
          if (entry) {
            console.warn(
              `[llm] ${client.provider} (${client.model}) failed category=auth: ${failure.message}; pausing until ${new Date(entry.pausedUntil).toISOString()} (cooldown ${entry.pausedUntil - entry.pausedAt}ms), trying next provider`,
            );
          } else {
            console.warn(
              `[llm] ${client.provider} (${client.model}) failed category=${failure.category}: ${failure.message}, trying next provider`,
            );
          }
        } else {
          console.warn(
            `[llm] ${client.provider} (${client.model}) failed category=${failure.category}: ${failure.message}, trying next provider`,
          );
        }
      }
    }

    if (attemptedCount === 0 && skippedPausedCount > 0 && !stormSuppressed) {
      console.warn(
        `[llm] all ${skippedPausedCount} provider(s) paused after auth failures — no provider attempted this call`,
      );
    }
    if (attemptedCount === 0 && stormSuppressed) {
      console.warn(
        `[llm] helper LLM provider attempt budget exhausted — no provider attempted this call`,
      );
    }

    return lastDetail;
  }
}
