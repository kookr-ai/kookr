import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRoutes } from './routes.js';
import type { RouteDeps } from './routes/shared.js';

function makeDeps(frontendDir: string, serverCwd: string): RouteDeps {
  return { frontendDir, serverCwd, serverPort: 4800 } as unknown as RouteDeps;
}

describe('createRoutes serveStatic gating', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-routes-static-'));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Regression: in `pnpm dev` mode the frontend is served by Vite and
  // dist/frontend doesn't exist. serveStatic must not be mounted, otherwise
  // @hono/node-server logs `serveStatic: root path '...' is not found` once
  // at registration time.
  it('skips serveStatic and emits no warning when frontendDir is absent', () => {
    const absentDir = join(tempDir, 'never-created');
    createRoutes(makeDeps(absentDir, tempDir));
    const warned = consoleErrorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('serveStatic') && a.includes('is not found')),
    );
    expect(warned).toBe(false);
  });

  it('mounts serveStatic without warning when frontendDir exists (production layout)', () => {
    const frontendDir = join(tempDir, 'frontend');
    mkdirSync(frontendDir, { recursive: true });
    const app = createRoutes(makeDeps(frontendDir, tempDir));
    const warned = consoleErrorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('serveStatic') && a.includes('is not found')),
    );
    expect(warned).toBe(false);
    expect(app).toBeDefined();
  });
});
