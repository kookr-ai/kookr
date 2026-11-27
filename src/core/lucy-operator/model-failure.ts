/**
 * What the operator is told when Lucy's language model fails, and what the server logs about it.
 *
 * The provider's own error text is never shown to the operator: it can echo part of the request, and
 * it is written by someone else. Only short fields that were checked against a strict pattern are
 * used here: the provider's name (letters, digits, spaces, dots and dashes, at most 40 characters)
 * and a numeric status. Anything that does not match is dropped, not shortened, so a long or odd
 * value never turns into something that reads like a sentence. The detail's `service` field (set only for Baseten) picks the wording. The two codes OpenRouter adds
 * (`error_type`, `provider_code`) go to the log only.
 */

import { LucyModelError, type LucyModelErrorDetail } from './model-port.js';

const PROVIDER_NAME_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9 .-]{1,40}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

/** A provider's name when it is short and plain, otherwise undefined. */
export function cleanProviderName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return PROVIDER_NAME_RE.test(name) ? name : undefined;
}

/** An HTTP status (a whole number from 100 to 599, or its digits as text), otherwise undefined. */
export function cleanStatus(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d{3}$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

function cleanCode(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof text === 'string' && CODE_RE.test(text.trim()) ? text.trim() : undefined;
}

/**
 * The safe fields of a provider error. `metadata` is the error's `metadata` object as OpenRouter sends
 * it; `provider` is the name from a chunk that came before the error (used when the metadata has none).
 */
export function modelErrorDetailFrom(parts: { status?: unknown; provider?: unknown; metadata?: unknown }): LucyModelErrorDetail {
  const meta = typeof parts.metadata === 'object' && parts.metadata !== null ? (parts.metadata as Record<string, unknown>) : {};
  const providerName = cleanProviderName(meta.provider_name) ?? cleanProviderName(parts.provider);
  const status = cleanStatus(parts.status);
  const errorType = cleanCode(meta.error_type);
  const providerCode = cleanCode(meta.provider_code) ?? cleanCode(meta.provider_error_code);
  return {
    ...(providerName ? { providerName } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(errorType ? { errorType } : {}),
    ...(providerCode ? { providerCode } : {}),
  };
}

/** Text from a provider, for the server log only: control characters and runs of spaces become one space, and it is cut to `max` characters. */
export function cleanLogText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
}

/** The line for the server log: "OpenRouter: Sail Research answered 429 rate_limit_exceeded (ttft_deadline_guard)". Null when there is nothing to say. */
export function modelErrorLogLine(detail: LucyModelErrorDetail): string | null {
  if (!detail.providerName && detail.status === undefined && !detail.errorType && !detail.providerCode) return null;
  const answered = [detail.status !== undefined ? String(detail.status) : 'an error', detail.errorType].filter(Boolean).join(' ');
  const code = detail.providerCode ? ` (${detail.providerCode})` : '';
  // Baseten serves the model itself, so there is no provider behind it to name.
  if (detail.service === 'Baseten') return `Baseten answered ${answered}${code}`;
  return `OpenRouter: ${detail.providerName ?? 'a provider'} answered ${answered}${code}`;
}

/** The sentence for a failure whose shape is known (a provider name or a status), or null. */
function knownShapeSentence(err: LucyModelError): string | null {
  const detail = err.detail;
  if (!detail) return null;
  const name = cleanProviderName(detail.providerName);
  const status = cleanStatus(detail.status ?? err.status);
  if (!name && status === undefined) return null;
  const baseten = detail.service === 'Baseten';
  const subject = baseten ? 'Baseten' : name ? `OpenRouter's provider ${name}` : 'OpenRouter';
  const at = status !== undefined ? ` (${status})` : '';
  let predicate: string;
  if (status === 429 || /rate_?limit/i.test(detail.errorType ?? '')) predicate = `is rate-limited${at}.`;
  else if (status === 401 || status === 402 || status === 403) predicate = `refused the request${at}. Check the ${baseten ? 'Baseten' : 'OpenRouter'} key and its credit.`;
  else if (status !== undefined && status >= 500) predicate = `had a server error${at}.`;
  else predicate = `answered with an error${at}.`;
  return `My language model is not answering: ${subject} ${predicate}`;
}

/** What to tell the operator when a model call failed. Built only from bounded fields; never includes the provider's own error text. */
export function plainFailureReason(err: unknown): string {
  if (!(err instanceof LucyModelError)) return 'Something went wrong while preparing the answer.';
  if (err.kind === 'timeout' && err.detail?.firstTokenAfterMs !== undefined) {
    const seconds = Math.max(1, Math.round(err.detail.firstTokenAfterMs / 1000));
    return `My language model is not answering: it sent nothing in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }
  const known = knownShapeSentence(err);
  if (err.kind === 'unavailable') {
    return known
      ? `${known} I will not ask it again for a minute.`
      : 'My language model is not answering, so I have stopped asking it for a minute.';
  }
  if (known) return known;
  switch (err.kind) {
    case 'http':
      if (err.status === 401 || err.status === 402 || err.status === 403) return 'The model provider refused the request. Check the OpenRouter key and its credit.';
      if (err.status === 429) return 'The model provider is limiting requests right now.';
      return 'The model provider returned an error.';
    case 'network':
      return 'The model provider could not be reached.';
    case 'timeout':
      return 'The model stopped responding.';
    case 'aborted':
      return 'The request was cancelled.';
    case 'bad-response':
    case 'provider':
      return 'The model provider returned an error.';
  }
}
