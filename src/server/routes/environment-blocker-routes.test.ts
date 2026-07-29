import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { EnvironmentBlockerRegistry } from '../../core/environment-blocker-registry.js';
import { registerEnvironmentBlockerRoutes } from './environment-blocker-routes.js';

describe('environment-blocker routes', () => {
  let tempDir: string;
  let registry: EnvironmentBlockerRegistry;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'environment-blocker-routes-test-'));
    registry = new EnvironmentBlockerRegistry(tempDir);
    app = new Hono();
    registerEnvironmentBlockerRoutes(app, { registry });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('POST registers a blocker once and reports newlyRegistered', async () => {
    const res = await app.request('/api/environment-blockers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newlyRegistered).toBe(true);
    expect(body.blocker.key).toBe('ci-billing:github-actions');

    const res2 = await app.request('/api/environment-blockers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-2' }),
    });
    const body2 = await res2.json();
    expect(body2.newlyRegistered).toBe(false);
    expect(body2.blocker.detectedBy).toBe('task-1');
  });

  test('POST rejects a missing type/scope', async () => {
    const res = await app.request('/api/environment-blockers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'github-actions' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST rejects a missing scope (type present)', async () => {
    const res = await app.request('/api/environment-blockers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-billing' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST rejects a type/scope containing the ":" key delimiter', async () => {
    const res = await app.request('/api/environment-blockers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci:billing', scope: 'github-actions' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must not contain ':'/);
  });

  test('write endpoints reject a malformed JSON body with 400', async () => {
    for (const [path, method] of [
      ['/api/environment-blockers', 'POST'],
      ['/api/environment-blockers/probe', 'POST'],
      ['/api/environment-blockers', 'DELETE'],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid JSON body');
    }
  });

  test('GET lists active blockers', async () => {
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    const res = await app.request('/api/environment-blockers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].key).toBe('ci-billing:github-actions');
  });

  test('GET with type+scope consults for a blocked_external disposition', async () => {
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    const res = await app.request('/api/environment-blockers?type=ci-billing&scope=github-actions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(body.state).toBe('blocked_external');

    const miss = await app.request('/api/environment-blockers?type=ci-billing&scope=circleci');
    expect((await miss.json()).blocked).toBe(false);
  });

  test('GET consult with only one of type/scope is a 400', async () => {
    const res = await app.request('/api/environment-blockers?type=ci-billing');
    expect(res.status).toBe(400);
  });

  test('POST /probe with success clears the blocker', async () => {
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    const res = await app.request('/api/environment-blockers/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-billing', scope: 'github-actions', success: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toBe(true);
    expect(registry.consult('ci-billing', 'github-actions').blocked).toBe(false);
  });

  test('POST /probe with success=false keeps the blocker (cleared:false)', async () => {
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    const res = await app.request('/api/environment-blockers/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-billing', scope: 'github-actions', success: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toBe(false);
    expect(registry.consult('ci-billing', 'github-actions').blocked).toBe(true);
  });

  test('POST /probe requires a boolean success', async () => {
    const res = await app.request('/api/environment-blockers/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-billing', scope: 'github-actions' }),
    });
    expect(res.status).toBe(400);
  });

  test('DELETE clears a blocker', async () => {
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    const res = await app.request('/api/environment-blockers', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-billing', scope: 'github-actions' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toBe(true);
    expect(registry.size()).toBe(0);
  });
});
