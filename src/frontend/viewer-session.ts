// --- Viewer session (front end of the read-only shared view, #811) ---
//
// The SPA learns *who it is* — owner or scoped viewer — from the identity probe
// `GET /api/auth/session` (#811 server side), resolved from the HttpOnly session
// cookie. That answer drives the read-only banner and the client-side mutation
// suppression. We probe on every load (not only the boot where a `#token`
// fragment was exchanged), and cache the answer in `sessionStorage` so a reload
// renders the banner instantly instead of flashing the owner UI first.
//
// The server is the *real* boundary (the WS read-only gate #806, the HTTP viewer
// deny-list #802, the terminal scope check #810). Everything here is UX: hide the
// controls a viewer cannot use, and surface a friendly notice if a mutation slips
// through and the server answers 403.

import { useCallback, useEffect, useState } from 'react';

import { READ_ONLY_BLOCKED_EVENT } from './auth-session.js';
import { useKookrStore } from './store/useStore.js';
import type { ClientMessage } from '../shared/contracts/messages.js';
import type { ViewerScope } from './viewer-share-api.js';

export interface ViewerSession {
  /** True iff the resolved actor is a scoped read-only viewer. */
  isViewer: boolean;
  /** The viewer's scope (null for the owner). */
  scope: ViewerScope | null;
}

const OWNER_SESSION: ViewerSession = { isViewer: false, scope: null };
const STORAGE_KEY = 'kookr.viewer.session';
/** Debounce window so a burst of blocked mutations shows a single notice. */
const NOTICE_THROTTLE_MS = 4_000;

let cached: ViewerSession | null = null;
let inflight: Promise<ViewerSession> | null = null;
let lastNoticeAt = 0;
let listenerController: AbortController | null = null;
const subscribers = new Set<(session: ViewerSession) => void>();

/** Test-only: reset module singletons so each test starts clean. */
export function __resetViewerSessionForTests(): void {
  cached = null;
  inflight = null;
  lastNoticeAt = 0;
  listenerController?.abort();
  listenerController = null;
  subscribers.clear();
}

/** Normalize an untrusted scope value to a `ViewerScope` (default-deny → `all`). */
function normalizeScope(raw: unknown): ViewerScope {
  if (typeof raw === 'object' && raw !== null) {
    const kind = (raw as { kind?: unknown }).kind;
    if (kind === 'projects') {
      const ids = (raw as { projectIds?: unknown }).projectIds;
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
        return { kind: 'projects', projectIds: ids as string[] };
      }
    }
  }
  return { kind: 'all' };
}

/**
 * Interpret a `GET /api/auth/session` response. Anything other than a 200 with
 * `{ actor: 'viewer' }` resolves to the owner (no banner, no suppression) — a
 * 401/network error means "not an admitted viewer", which is the safe default.
 */
export function parseViewerSessionResponse(status: number, body: unknown): ViewerSession {
  if (status !== 200 || typeof body !== 'object' || body === null) return OWNER_SESSION;
  if ((body as { actor?: unknown }).actor !== 'viewer') return OWNER_SESSION;
  return { isViewer: true, scope: normalizeScope((body as { scope?: unknown }).scope) };
}

function readStoredSession(): ViewerSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { isViewer?: unknown; scope?: unknown };
    if (parsed.isViewer === true) return { isViewer: true, scope: normalizeScope(parsed.scope) };
    if (parsed.isViewer === false) return OWNER_SESSION;
  } catch {
    // unparseable / unavailable storage — fall through to a live probe
  }
  return null;
}

function storeSession(session: ViewerSession): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // sessionStorage unavailable — in-memory cache still works for this page
  }
}

function publish(session: ViewerSession): void {
  cached = session;
  storeSession(session);
  for (const fn of subscribers) fn(session);
}

/**
 * Probe `GET /api/auth/session` once and cache the result. Concurrent callers
 * share a single in-flight request. Always resolves (never rejects): a failed
 * probe yields the owner session.
 */
export function fetchViewerSession(): Promise<ViewerSession> {
  if (inflight) return inflight;
  inflight = (async () => {
    let result = OWNER_SESSION;
    try {
      const res = await fetch('/api/auth/session', { method: 'GET', credentials: 'same-origin' });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      result = parseViewerSessionResponse(res.status, body);
    } catch {
      result = OWNER_SESSION;
    }
    publish(result);
    return result;
  })();
  return inflight;
}

/** Synchronous best-effort read of the current actor's viewer status. */
export function isViewerCached(): boolean {
  return (cached ?? readStoredSession() ?? OWNER_SESSION).isViewer;
}

/**
 * React hook exposing the current viewer session. Renders immediately from the
 * cache (in-memory or `sessionStorage`), then revalidates via a single shared
 * probe and updates every consumer when it resolves.
 */
export function useViewerSession(): ViewerSession {
  const [session, setSession] = useState<ViewerSession>(() => cached ?? readStoredSession() ?? OWNER_SESSION);

  useEffect(() => {
    subscribers.add(setSession);
    if (cached) {
      setSession(cached);
    } else {
      void fetchViewerSession();
    }
    return () => {
      subscribers.delete(setSession);
    };
  }, []);

  return session;
}

/**
 * Show the viewer-facing read-only notice (throttled). Used both by the HTTP 403
 * catch-all and by the WS send guard, so a flurry of blocked actions surfaces a
 * single toast rather than a stack.
 */
export function showReadOnlyNotice(): void {
  const now = Date.now();
  if (now - lastNoticeAt < NOTICE_THROTTLE_MS) return;
  lastNoticeAt = now;
  try {
    useKookrStore
      .getState()
      .handleAlert('viewer', 'Read-only view', 'info', 'This is a shared read-only view — that action is disabled.');
  } catch {
    // store unavailable (non-React context) — nothing to show
  }
}

/**
 * Install the one window listener for the `read-only-blocked` event fired by the
 * `fetch` wrapper (#811). Idempotent. The notice only fires when the current
 * actor is actually a viewer, so an owner's CSRF 403 is never mislabeled.
 */
export function installReadOnlyNoticeListener(): void {
  if (listenerController || typeof window === 'undefined') return;
  listenerController = new AbortController();
  window.addEventListener(
    READ_ONLY_BLOCKED_EVENT,
    () => {
      if (isViewerCached()) showReadOnlyNotice();
    },
    { signal: listenerController.signal },
  );
}

/**
 * Wrap a WebSocket `send` so a viewer's mutation attempts are inert: the server
 * read-only gate (#806) already drops every viewer inbound frame, so sending is
 * pointless and could drive optimistic UI. For a viewer we no-op, show the
 * read-only notice, and report failure; the owner path is untouched.
 */
export function useViewerGuardedSend(
  send: (msg: ClientMessage) => boolean,
  isViewer: boolean,
): (msg: ClientMessage) => boolean {
  return useCallback(
    (msg: ClientMessage): boolean => {
      if (isViewer) {
        showReadOnlyNotice();
        return false;
      }
      return send(msg);
    },
    [send, isViewer],
  );
}

/**
 * Human-readable scope label for the banner. Optionally maps project ids to
 * display names. `all` → "the whole dashboard".
 */
export function formatViewerScope(
  scope: ViewerScope | null,
  resolveName?: (projectId: string) => string,
): string {
  if (!scope || scope.kind === 'all') return 'the whole dashboard';
  const names = scope.projectIds.map((id) => resolveName?.(id) ?? id);
  if (names.length === 0) return 'no projects';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} projects`;
}
