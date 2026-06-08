import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { bootstrapAuthSession } from './auth-session.js';

const root = createRoot(document.getElementById('root')!);

function render(): void {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// #804: exchange a `#token=…` fragment for the HttpOnly session cookie (and the
// CSRF nonce + fetch wrapper) BEFORE rendering, so the first WebSocket upgrade
// and HTTP fetches carry the cookie. The exchange is a no-op on loopback / when
// no fragment token is present, so the loopback owner flow is unchanged.
void bootstrapAuthSession().finally(render);
