// --- Browser auth: fragment → HttpOnly cookie exchange (front end of #804) ---
//
// The share/handoff URL carries the raw viewer (or owner) token in the URL
// **fragment** — `https://<host>:<port>/#token=<raw>` — which the browser never
// sends to the server on a normal navigation. On boot the SPA:
//
//   1. reads the token from `location.hash`;
//   2. POSTs it to `POST /api/auth/session` (same-origin, so the browser sets
//      `Sec-Fetch-Site: same-origin`), which sets the `HttpOnly` session cookie
//      and returns a per-session CSRF nonce;
//   3. clears the fragment from the address bar (history + hash) so the raw token
//      does not linger; and
//   4. holds the CSRF nonce so owner mutations can echo it back in `X-Kookr-CSRF`.
//
// After the exchange the cookie travels automatically on every HTTP fetch and on
// the WebSocket upgrade handshake, so `useWebSocket.ts` needs no token logic and
// the ~50 existing `fetch()` call sites are untouched — the CSRF header is added
// transparently by a `fetch` wrapper installed here.
//
// The CSRF nonce is NOT the session secret (it is `HMAC(serverSecret, token)`);
// persisting it in `sessionStorage` so it survives a reload is safe (an attacker
// who can read `sessionStorage` already has XSS, against which `SameSite=Strict`
// + the HttpOnly cookie are the real defenses).

const CSRF_HEADER = 'x-kookr-csrf';
/** Window event fired when a mutating /api request is rejected 403 (#811). */
export const READ_ONLY_BLOCKED_EVENT = 'kookr:read-only-blocked';
const CSRF_STORAGE_KEY = 'kookr.session.csrf';
const SESSION_FINGERPRINT_KEY = 'kookr.session.fingerprint';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** In-memory CSRF nonce for the active session (mirrors `sessionStorage`). */
let csrfNonce: string | null = null;
/** Guards against double-wrapping `window.fetch` if bootstrap runs twice. */
let fetchPatched = false;

/** Current CSRF nonce, or `null` before a session is established. */
export function getCsrfToken(): string | null {
  return csrfNonce;
}

/** Test-only: reset module singletons so each test starts from a clean slate. */
export function __resetAuthSessionForTests(): void {
  csrfNonce = null;
  fetchPatched = false;
}

/**
 * Extract a `#token=<raw>` value from a URL fragment. Tolerates the leading `#`
 * and other fragment params (`#token=x&foo=y`). Returns `null` when absent.
 */
export function parseFragmentToken(hash: string | undefined | null): string | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

/**
 * Whether `url` targets this origin's API surface (so the CSRF header should be
 * attached). Relative `/api/...` paths and absolute same-origin URLs both match;
 * cross-origin URLs do not.
 */
export function isSameOriginApiUrl(url: string, origin: string): boolean {
  try {
    const resolved = new URL(url, origin);
    return resolved.origin === origin && resolved.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function readMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = init?.method;
  if (fromInit) return fromInit.toUpperCase();
  if (typeof input !== 'string' && !(input instanceof URL) && 'method' in input) {
    return (input.method || 'GET').toUpperCase();
  }
  return 'GET';
}

function readUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wrap `fetch` so a mutating same-origin `/api` request automatically carries the
 * `X-Kookr-CSRF` nonce — covering every existing call site without edits. Returns
 * the wrapped function; idempotent installation is the caller's job.
 *
 * `onForbidden` (optional, #811) is invoked when a mutating same-origin `/api`
 * request comes back `403`. The SPA uses this as the single catch-all for the
 * viewer read-only UX: the server gate is the real boundary, and any mutation a
 * viewer reaches surfaces a viewer-facing notice (the handler itself decides
 * whether the current actor is a viewer — an owner's CSRF 403 is a real error and
 * is not a read-only notice). It never sees the body and never throws into the
 * caller, so call-site error handling is unchanged.
 */
export function createCsrfFetch(
  originalFetch: typeof fetch,
  getToken: () => string | null,
  origin: string,
  onForbidden?: () => void,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = readMethod(input, init);
    const isMutatingApi = !SAFE_METHODS.has(method) && isSameOriginApiUrl(readUrl(input), origin);
    const token = getToken();

    let res: Response;
    if (token && isMutatingApi) {
      const headers = new Headers(
        init?.headers ??
          (typeof input !== 'string' && !(input instanceof URL) && 'headers' in input
            ? input.headers
            : undefined),
      );
      if (!headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, token);
      res = await originalFetch(input, { ...init, headers });
    } else {
      res = await originalFetch(input, init);
    }

    if (onForbidden && isMutatingApi && res.status === 403) {
      try {
        onForbidden();
      } catch {
        // a misbehaving notice handler must never break the fetch
      }
    }
    return res;
  };
}

function setCsrfNonce(nonce: string): void {
  csrfNonce = nonce;
  try {
    window.sessionStorage.setItem(CSRF_STORAGE_KEY, nonce);
  } catch {
    // sessionStorage unavailable (private mode / disabled) — in-memory still works
    // for the life of the page.
  }
}

function loadCsrfNonceFromStorage(): void {
  try {
    const stored = window.sessionStorage.getItem(CSRF_STORAGE_KEY);
    if (stored) csrfNonce = stored;
  } catch {
    // ignore
  }
}

/**
 * Drop persisted, per-session UI caches when the established session differs
 * from the one this tab last saw (a genuine session switch — e.g. an owner
 * opening a viewer share URL). The live agent/task data lives only in the
 * in-memory store (fresh on this page load), so this only clears `localStorage`
 * remnants that could otherwise flash prior-session UI state.
 */
function clearStaleStateOnSessionSwitch(fingerprint: string): void {
  try {
    const previous = window.sessionStorage.getItem(SESSION_FINGERPRINT_KEY);
    if (previous && previous !== fingerprint) {
      const toRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith('kookr')) toRemove.push(key);
      }
      for (const key of toRemove) window.localStorage.removeItem(key);
    }
    window.sessionStorage.setItem(SESSION_FINGERPRINT_KEY, fingerprint);
  } catch {
    // storage unavailable — nothing to clear
  }
}

/** Remove the `#token=…` fragment from the address bar without a navigation. */
function clearFragment(): void {
  try {
    const { pathname, search } = window.location;
    window.history.replaceState(null, '', `${pathname}${search}`);
    // Some browsers keep `location.hash` until explicitly cleared.
    if (window.location.hash) window.location.hash = '';
  } catch {
    // best-effort
  }
}

/**
 * Boot the browser session: exchange a fragment token for the HttpOnly cookie if
 * one is present, otherwise rehydrate the CSRF nonce from `sessionStorage`. Always
 * installs the CSRF `fetch` wrapper. Resolves once the session (if any) is
 * established; safe to `await` before connecting the WebSocket.
 */
export async function bootstrapAuthSession(): Promise<void> {
  // Install the CSRF fetch wrapper first so any fetch (including the exchange's
  // own follow-ups) is covered. The wrapper is a no-op until a nonce exists.
  // Guard against double-wrapping if bootstrap is ever invoked more than once.
  if (!fetchPatched && typeof window !== 'undefined' && typeof window.fetch === 'function') {
    window.fetch = createCsrfFetch(
      window.fetch.bind(window),
      getCsrfToken,
      window.location.origin,
      // #811: a 403 on a mutating /api request fires the read-only-blocked event;
      // `viewer-session.ts` listens and shows the viewer-facing notice (gated on
      // the actor actually being a viewer, so owner CSRF 403s are untouched).
      () => window.dispatchEvent(new CustomEvent(READ_ONLY_BLOCKED_EVENT)),
    );
    fetchPatched = true;
  }

  const token = parseFragmentToken(window.location.hash);
  if (!token) {
    loadCsrfNonceFromStorage();
    return;
  }

  try {
    // Use the unwrapped POST path (no CSRF needed for the exchange itself; it has
    // its own same-origin check). `credentials: 'same-origin'` lets the Set-Cookie
    // stick.
    const res = await window.fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const data = (await res.json()) as { csrfToken?: unknown };
      if (typeof data.csrfToken === 'string') {
        setCsrfNonce(data.csrfToken);
        clearStaleStateOnSessionSwitch(data.csrfToken);
      }
    } else {
      console.warn(`[auth-session] token exchange failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('[auth-session] token exchange error:', err);
  } finally {
    // Always clear the fragment so the raw token does not linger in history,
    // even if the exchange failed.
    clearFragment();
  }
}
