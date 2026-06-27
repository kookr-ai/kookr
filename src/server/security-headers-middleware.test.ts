import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutes } from './routes.js';
import { DASHBOARD_CONTENT_SECURITY_POLICY } from './security-headers-middleware.js';
import type { RouteDeps } from './routes/shared.js';

function makeDeps(frontendDir: string, serverCwd: string): RouteDeps {
  return { frontendDir, serverCwd, serverPort: 4800 } as unknown as RouteDeps;
}

function expectDashboardSecurityHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(DASHBOARD_CONTENT_SECURITY_POLICY);
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

function expectNoDashboardSecurityHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBeNull();
  expect(res.headers.get('x-frame-options')).toBeNull();
  expect(res.headers.get('x-content-type-options')).toBeNull();
  expect(res.headers.get('referrer-policy')).toBeNull();
}

function parseCspDirectives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name, values];
    }),
  );
}

describe('dashboard security headers', () => {
  let tempDir: string;
  let frontendDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-security-headers-'));
    frontendDir = join(tempDir, 'frontend');
    mkdirSync(join(frontendDir, 'assets'), { recursive: true });
    writeFileSync(
      join(frontendDir, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
    );
    writeFileSync(join(frontendDir, 'assets', 'app.js'), 'console.log("kookr");');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('attaches browser security headers to the dashboard HTML fallback', async () => {
    const app = createRoutes(makeDeps(frontendDir, tempDir));

    const res = await app.request('http://localhost/dashboard');

    expect(res.status).toBe(200);
    expectDashboardSecurityHeaders(res);
  });

  it('attaches browser security headers to dashboard asset responses', async () => {
    const app = createRoutes(makeDeps(frontendDir, tempDir));

    const res = await app.request('http://localhost/assets/app.js');

    expect(res.status).toBe(200);
    expectDashboardSecurityHeaders(res);
  });

  it('keeps the CSP compatible with the dashboard runtime', () => {
    const directives = parseCspDirectives(DASHBOARD_CONTENT_SECURITY_POLICY);

    expect(directives).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'media-src': ["'self'", 'data:', 'blob:'],
      'worker-src': ["'self'", 'blob:'],
    });
  });

  it('does not add dashboard headers to API responses', async () => {
    const app = createRoutes(makeDeps(frontendDir, tempDir));

    const res = await app.request('http://localhost/api/does-not-exist');

    expect(res.status).toBe(404);
    expectNoDashboardSecurityHeaders(res);
  });

  it('attaches browser security headers to SPA fallbacks on reserved roots', async () => {
    const app = createRoutes(makeDeps(frontendDir, tempDir));

    const apiRoot = await app.request('http://localhost/api');
    const wsRoot = await app.request('http://localhost/ws');
    const terminalWsPath = await app.request('http://localhost/ws/terminal/session-1');

    expect(apiRoot.status).toBe(200);
    expect(wsRoot.status).toBe(200);
    expect(terminalWsPath.status).toBe(200);
    expectDashboardSecurityHeaders(apiRoot);
    expectDashboardSecurityHeaders(wsRoot);
    expectDashboardSecurityHeaders(terminalWsPath);
  });

  it('does not add dashboard headers to non-dashboard text responses', async () => {
    const app = createRoutes(makeDeps(frontendDir, tempDir));

    const res = await app.request('http://localhost/metrics');

    expect(res.status).toBe(200);
    expectNoDashboardSecurityHeaders(res);
  });
});
