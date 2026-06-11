/**
 * Shared OpenAI-compatible Chat Completions transport for helper LLM providers.
 *
 * Provider-specific wrappers own policy (model, base URL, headers, env vars).
 * This transport owns only protocol mechanics and sanitized diagnostics.
 */

import {
  classifyLlmProviderHttpStatus,
  type LlmClient,
  type LlmCompletionRequest,
  type LlmProviderFailureCategory,
} from './llm-types.js';

export type OpenAiCompatibleProvider = 'openrouter' | 'requesty';

export interface OpenAiCompatibleClientOptions {
  provider: OpenAiCompatibleProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  defaultTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export class LlmProviderFailureError extends Error {
  readonly providerFailureCategory: LlmProviderFailureCategory;

  constructor(category: LlmProviderFailureCategory, message: string) {
    super(message);
    this.name = 'LlmProviderFailureError';
    this.providerFailureCategory = category;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ERROR_DETAIL_CHARS = 400;
const SENSITIVE_FIELD_NAMES = new Set([
  'authorization',
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
]);
const REQUEST_DERIVED_FIELD_NAMES = new Set([
  'messages',
  'prompt',
  'content',
  'user_message',
  'usermessage',
  'input',
]);

function providerLabel(provider: OpenAiCompatibleProvider): string {
  switch (provider) {
    case 'openrouter': return 'OpenRouter';
    case 'requesty': return 'Requesty';
  }
}

function abortError(): Error {
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

function isAbortLike(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

function providerFailure(category: LlmProviderFailureCategory, message: string): LlmProviderFailureError {
  return new LlmProviderFailureError(category, message);
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sk-or|req)_[A-Za-z0-9._-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[REDACTED_KEY]');
}

function sanitizeParsed(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeParsed);
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      const snake = key.toLowerCase();
      if (SENSITIVE_FIELD_NAMES.has(snake) || SENSITIVE_FIELD_NAMES.has(normalized)) {
        output[key] = '[REDACTED]';
      } else if (REQUEST_DERIVED_FIELD_NAMES.has(snake) || REQUEST_DERIVED_FIELD_NAMES.has(normalized)) {
        output[key] = '[OMITTED]';
      } else {
        output[key] = sanitizeParsed(child);
      }
    }
    return output;
  }
  return typeof value === 'string' ? redactString(value) : value;
}

export function sanitizeProviderErrorDetail(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let sanitized: string;
  try {
    sanitized = JSON.stringify(sanitizeParsed(JSON.parse(trimmed)));
  } catch {
    sanitized = redactString(trimmed)
      .replace(/"messages"\s*:\s*\[[\s\S]*?\]/gi, '"messages":"[OMITTED]"')
      .replace(/"content"\s*:\s*"[^"]*"/gi, '"content":"[OMITTED]"')
      .replace(/"prompt"\s*:\s*"[^"]*"/gi, '"prompt":"[OMITTED]"');
  }

  return sanitized.length > MAX_ERROR_DETAIL_CHARS
    ? `${sanitized.slice(0, MAX_ERROR_DETAIL_CHARS)}...`
    : sanitized;
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly provider: OpenAiCompatibleProvider;
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs?: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: OpenAiCompatibleClientOptions) {
    this.provider = options.provider;
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.endpoint = `${baseUrl}/chat/completions`;
    this.extraHeaders = options.extraHeaders ?? {};
    this.timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : undefined;
    this.defaultTimeoutMs = options.defaultTimeoutMs !== undefined && options.defaultTimeoutMs > 0
      ? options.defaultTimeoutMs
      : DEFAULT_TIMEOUT_MS;
  }

  async complete(req: LlmCompletionRequest): Promise<string | null> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }
    messages.push({ role: 'user', content: req.userMessage });

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      messages,
    };
    if (req.responseFormat) {
      body.response_format = {
        type: 'json_schema' as const,
        json_schema: {
          name: req.responseFormat.jsonSchema.name,
          strict: false,
          schema: req.responseFormat.jsonSchema.schema,
        },
      };
    }

    const controller = new AbortController();
    let callerAborted = false;
    let timedOut = false;
    const timeoutMs = this.timeoutMs
      ?? Math.max(req.timeoutMs ?? this.defaultTimeoutMs, this.defaultTimeoutMs);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`${providerLabel(this.provider)} request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      callerAborted = true;
      controller.abort(abortError());
    };
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.extraHeaders,
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (callerAborted || req.signal?.aborted) {
        throw abortError();
      }
      if (timedOut && isAbortLike(err)) {
        throw providerFailure('network_timeout', `${providerLabel(this.provider)} request timed out after ${timeoutMs}ms`);
      }
      throw providerFailure(
        'network_timeout',
        `${providerLabel(this.provider)} request failed before a response was received: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      const detail = sanitizeProviderErrorDetail(await response.text().catch(() => ''));
      throw providerFailure(
        classifyLlmProviderHttpStatus(response.status),
        `${providerLabel(this.provider)} request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
      );
    }

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch (err) {
      throw providerFailure(
        'malformed_response',
        `${providerLabel(this.provider)} response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() || null : null;
  }
}
