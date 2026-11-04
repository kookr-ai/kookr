import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { bootstrapAuthSession } from './auth-session.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { installPreloadErrorReload } from './lazy-with-reload.js';

// A long-lived client holds the old hashed module graph after a server rebuild.
// If a `<link rel="modulepreload">` for a now-deleted chunk fails, Vite fires
// `vite:preloadError`; pull the fresh index with a single guarded reload rather
// than letting the stale preload surface as a panel crash. (Dynamic
// `import()`s inside lazy boundaries are covered separately by lazyWithReload.)
installPreloadErrorReload();

const root = createRoot(document.getElementById('root')!);

function render(): void {
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

// #804: exchange a `#token=…` fragment for the HttpOnly session cookie (and the
// CSRF nonce + fetch wrapper) BEFORE rendering, so the first WebSocket upgrade
// and HTTP fetches carry the cookie. The exchange is a no-op on loopback / when
// no fragment token is present, so the loopback owner flow is unchanged.
void bootstrapAuthSession().finally(render);
