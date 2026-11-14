// Vitest setupFiles: keep happy-dom test files' fetch and XMLHttpRequest off
// the network.
//
// happy-dom implements a real `fetch` resolved against the document URL
// (http://localhost:3000 by default), so frontend code that calls
// `fetch('/api/...')` without a stub would send a real HTTP request to whatever
// listens on that port on the host. Under jsdom the same call rejects at once,
// because the environment exposes Node's `fetch`, which refuses relative URLs.
// This interceptor gives happy-dom files the same behavior: every request the
// page makes fails with a TypeError, as a browser's network error does. Tests
// that need responses keep stubbing `fetch` themselves (vi.stubGlobal / spyOn),
// which replaces the happy-dom implementation entirely.
//
// WebSocket is not covered: happy-dom's WebSocket opens real sockets, as
// jsdom's does, so tests must keep stubbing it.
//
// Runs for every test file; it is a no-op outside happy-dom.

interface HappyDomWindow {
  happyDOM?: { settings: { fetch: { interceptor: unknown } } };
}

function offlineNetworkError(url: string): TypeError {
  return new TypeError(`Failed to fetch ${url}: network access is disabled in happy-dom tests`);
}

const offlineFetchInterceptor = {
  beforeAsyncRequest: async ({ request }: { request: { url: string } }): Promise<never> => {
    throw offlineNetworkError(request.url);
  },
  beforeSyncRequest: ({ request }: { request: { url: string } }): never => {
    throw offlineNetworkError(request.url);
  },
};

const happyWindow = (globalThis as { window?: HappyDomWindow }).window;
if (happyWindow?.happyDOM) {
  happyWindow.happyDOM.settings.fetch.interceptor = offlineFetchInterceptor;
}
