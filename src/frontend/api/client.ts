/**
 * Frontend data-access layer — the single seam through which dashboard UI code
 * reaches the HTTP API. Components import typed functions from `./api` instead
 * of calling `fetch` directly, so URL construction, request shape, and
 * error-handling live in one place and are unit-testable without a DOM.
 *
 * See issue #1826 (arch: introduce a frontend/api client). Each panel that
 * previously owned raw `fetch(` transport now delegates to a named endpoint
 * function; those functions are the only callers of {@link apiFetch}.
 */

/**
 * Error thrown by the throw-on-failure helpers ({@link getJson}). Carries the
 * HTTP status and the parsed error body (when the server returned JSON) so
 * callers can branch on either — e.g. treat 404 differently from 500.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Envelope returned by {@link fetchResult} / {@link fetchJson} for callers that
 * must inspect the status code or read the response body on a non-2xx response.
 */
export interface ApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T;
}

/**
 * The one place dashboard components reach the global `fetch` (via the endpoint
 * wrappers in this directory). Kept as a named seam so tests and future
 * cross-cutting concerns (base URL, auth headers) have a single hook, and so the
 * `no-raw-fetch-in-components` guard test can forbid `fetch(` in components.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Preserve call arity: a bare GET forwards `fetch(path)` (not
  // `fetch(path, undefined)`) so callers/tests asserting a single argument
  // keep matching after migration.
  return init === undefined ? fetch(path) : fetch(path, init);
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/**
 * GET/parse JSON, throwing {@link ApiError} on a non-2xx response. Use when the
 * caller only needs the success body and treats any failure uniformly. The
 * thrown error's `message` defaults to `HTTP <status>`; pass a custom message
 * from the endpoint wrapper when a panel needs a specific label.
 */
export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw new ApiError(res.status, await parseJsonSafe(res));
  return (await res.json()) as T;
}

/**
 * Fetch and parse without throwing, returning the status plus parsed body so
 * the caller can branch on specific codes (409/404) or read an error body.
 * Mirrors the `res.json().catch(() => null)` idiom the panels used inline —
 * `body` is `null` when the response carried no parseable JSON.
 */
export async function fetchResult<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T | null>> {
  const res = await apiFetch(path, init);
  const body = (await parseJsonSafe(res)) as T | null;
  return { ok: res.ok, status: res.status, body };
}

/**
 * Like {@link fetchResult} but parses strictly: a non-JSON body rejects, exactly
 * as an inline `await res.json()` would. Mirrors the call sites that read the
 * body before checking `res.ok` and rely on that throw reaching their catch.
 */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await apiFetch(path, init);
  const body = (await res.json()) as T;
  return { ok: res.ok, status: res.status, body };
}
