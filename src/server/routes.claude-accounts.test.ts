import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutes } from './routes.js';
import type { RouteDeps } from './routes/shared.js';
import {
  emptyClaudeAccountRegistry,
  loadClaudeAccounts,
  saveClaudeAccounts,
  withAccount,
} from '../core/claude-accounts.js';

const TOKEN = 'sk-ant-oat01-' + 'q'.repeat(36) + 'WXYZ';

/**
 * The account routes have their own tests against a bare Hono app. This one
 * proves the server app built by createRoutes registers them: the Settings
 * page, the footer chip, the task badge and the Launch picker all load from
 * `GET /api/claude-accounts`.
 */
describe('createRoutes: Claude account routes', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routes-claude-accounts-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('answers GET /api/claude-accounts from the registry', async () => {
    const file = join(dir, 'accounts.json');
    saveClaudeAccounts(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN), file);
    const app = createRoutes({
      frontendDir: '/nonexistent-frontend',
      serverCwd: '/repo',
      serverPort: 4800,
      kookrDir: dir,
      claudeAccounts: { load: () => loadClaudeAccounts(file), save: (r) => saveClaudeAccounts(r, file) },
    } as unknown as RouteDeps);

    const res = await app.request('http://localhost/api/claude-accounts');

    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: Array<{ name: string }>; default: string };
    expect(body.accounts.map((a) => a.name)).toEqual(['host', 'work']);
    expect(body.default).toBe('host');
  });
});
