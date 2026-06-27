import type { MiddlewareHandler } from 'hono';

export const DASHBOARD_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
].join('; ');

export function createDashboardSecurityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    if (!isDashboardResponse(c.res)) return;

    c.header('Content-Security-Policy', DASHBOARD_CONTENT_SECURITY_POLICY);
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  };
}

function isDashboardResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType) return false;

  return (
    contentType === 'text/html' ||
    contentType === 'text/css' ||
    contentType === 'text/javascript' ||
    contentType === 'application/javascript' ||
    contentType === 'application/x-javascript' ||
    contentType === 'application/wasm' ||
    contentType.startsWith('image/') ||
    contentType.startsWith('font/') ||
    contentType.includes('font')
  );
}
