import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { IssueClaimRegistry } from '../../core/issue-claim-registry.js';
import type { ClaimEvent, ClaimTaskPort, ClaimTaskView, IssueClaim } from '../../core/issue-claim-types.js';
import type { TaskStatus } from '../../core/task-status.js';
import { decorateClaim } from '../issue-claim-decorator.js';
import { registerIssueClaimRoutes, type IssueClaimRouteDeps, type ResolveClaimRepoResult } from './issue-claim-routes.js';

const KEY = { repo: 'github.com/kookr-ai/kookr', number: 779 };

/** In-memory ClaimTaskPort double mirroring TaskStore semantics (copied from
 *  src/core/issue-claim-registry.test.ts — see that file for the canonical
 *  version this mirrors). */
class FakePort implements ClaimTaskPort {
  tasks = new Map<string, ClaimTaskView>();

  addTask(id: string, status: TaskStatus = 'open', extra: Partial<ClaimTaskView> = {}): void {
    this.tasks.set(id, { id, status, ...extra });
  }

  setStatus(id: string, status: TaskStatus): void {
    const t = this.tasks.get(id);
    if (t) t.status = status;
  }

  activeTaskViews(): ClaimTaskView[] {
    return Array.from(this.tasks.values());
  }

  getTaskView(taskId: string): ClaimTaskView | undefined {
    return this.tasks.get(taskId);
  }

  setIssueClaim(taskId: string, claim: IssueClaim): void {
    const t = this.tasks.get(taskId);
    if (t) t.issueClaim = claim;
  }

  clearIssueClaim(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t) delete t.issueClaim;
  }
}

function mkApp(deps: IssueClaimRouteDeps): Hono {
  const app = new Hono();
  registerIssueClaimRoutes(app, deps);
  return app;
}

function jsonRequest(method: string, body?: unknown) {
  return {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  };
}

describe('issue-claim routes', () => {
  let port: FakePort;
  let events: ClaimEvent[];
  let registry: IssueClaimRegistry;
  let flushTasks: ReturnType<typeof vi.fn>;
  let resolveRepo: ReturnType<typeof vi.fn>;
  let taskCwds: Map<string, string>;
  let deps: IssueClaimRouteDeps;

  beforeEach(() => {
    port = new FakePort();
    events = [];
    registry = new IssueClaimRegistry(port, (e) => events.push(e));
    flushTasks = vi.fn(async () => {});
    resolveRepo = vi.fn(async (): Promise<ResolveClaimRepoResult> => ({ ok: true, repo: KEY.repo }));
    taskCwds = new Map();
    deps = {
      enabled: true,
      registry,
      decorate: (record) => decorateClaim(record, { getAgentEvents: () => undefined }),
      resolveRepo,
      flushTasks,
      getTaskStatus: (taskId) => port.getTaskView(taskId)?.status,
      getTaskCwd: (taskId) => taskCwds.get(taskId),
    };
  });

  describe('flag off (RFC R7c)', () => {
    beforeEach(() => {
      deps.enabled = false;
    });

    test('POST returns 404', async () => {
      port.addTask('a');
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'issue-claims-disabled' });
    });

    test('DELETE returns 404', async () => {
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('DELETE', { repo: KEY.repo, number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(404);
    });

    test('GET returns 404', async () => {
      const res = await mkApp(deps).request('/api/issue-claims');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/issue-claims', () => {
    test('grants a free claim and flushes tasks (RFC R5)', async () => {
      port.addTask('a');
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'a', sessionId: 'kookr-aaa' }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ owned: true, reentrant: false });
      expect(flushTasks).toHaveBeenCalledTimes(1);
      expect(port.tasks.get('a')?.issueClaim).toMatchObject({ repo: KEY.repo, number: KEY.number });
    });

    test('does not flush tasks on a conflict', async () => {
      port.addTask('a', 'inProgress', { name: 'owner task' });
      port.addTask('b');
      registry.claim(KEY, { taskId: 'a' });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'b' }),
      );
      expect(res.status).toBe(409);
      const body = await res.json() as { owned: boolean; owner: Record<string, unknown> };
      expect(body.owned).toBe(false);
      expect(body.owner).toMatchObject({ taskId: 'a', ownerName: 'owner task' });
      expect(body.owner.ageMs).toBeTypeOf('number');
      expect(flushTasks).not.toHaveBeenCalled();
    });

    test('rejects an unknown taskId with 400', async () => {
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'ghost' }),
      );
      expect(res.status).toBe(400);
    });

    test('rejects a terminal taskId with 400', async () => {
      port.addTask('a', 'completed');
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(400);
    });

    test.each([0, -1, 1.5, 'nope', undefined])('rejects a bad issue number (%j) with 400', async (badNumber) => {
      port.addTask('a');
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: KEY.repo, number: badNumber, taskId: 'a' }),
      );
      expect(res.status).toBe(400);
    });

    test('400 with the resolver code+candidates when repo resolution fails', async () => {
      port.addTask('a');
      resolveRepo.mockResolvedValueOnce({
        ok: false,
        code: 'ambiguous_bare_name',
        message: 'ambiguous repo',
        candidates: ['github.com/a/lucy', 'github.com/b/lucy'],
      });
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { cwd: '/some/cwd', number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: 'ambiguous repo',
        code: 'ambiguous_bare_name',
        candidates: ['github.com/a/lucy', 'github.com/b/lucy'],
      });
      expect(resolveRepo).toHaveBeenCalledWith({ cwd: '/some/cwd', repoFlag: undefined });
    });

    test('skips resolveRepo when repo is already a canonical, safe project id', async () => {
      port.addTask('a');
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(200);
      expect(resolveRepo).not.toHaveBeenCalled();
    });

    test('is re-entrant for the same owning task', async () => {
      port.addTask('a');
      const app = mkApp(deps);
      await app.request('/api/issue-claims', jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'a' }));
      const res = await app.request('/api/issue-claims', jsonRequest('POST', { repo: KEY.repo, number: KEY.number, taskId: 'a' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ owned: true, reentrant: true });
    });

    // #1351: when the caller omits `cwd`, repo resolution must use the
    // claimant TASK's configured checkout, not the server/session bootstrap
    // cwd. A task configured for repo A can then claim A even though the host
    // process was bootstrapped from repo B.
    test('resolves repo from the claimant task cwd when body has no cwd (#1351)', async () => {
      port.addTask('a');
      taskCwds.set('a', '/work/lucy');
      resolveRepo.mockImplementationOnce(async (input) => {
        expect(input).toEqual({ cwd: '/work/lucy', repoFlag: 'jeanibarz/lucy' });
        return { ok: true, repo: 'github.com/jeanibarz/lucy' };
      });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        // owner/repo short form + NO cwd — exactly what an instrumented
        // playbook POSTs; previously this fell back to serverCwd and 400'd.
        jsonRequest('POST', { repo: 'jeanibarz/lucy', number: KEY.number, taskId: 'a' }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ owned: true, reentrant: false });
      expect(resolveRepo).toHaveBeenCalledWith({ cwd: '/work/lucy', repoFlag: 'jeanibarz/lucy' });
      expect(port.tasks.get('a')?.issueClaim).toMatchObject({ repo: 'github.com/jeanibarz/lucy', number: KEY.number });
    });

    // #1351: the task-cwd path must NOT weaken the mismatch guard — a genuinely
    // unrelated repo still fails closed (resolveClaimRepo returns `mismatch`).
    test('still rejects a repo unrelated to the task cwd (#1351)', async () => {
      port.addTask('a');
      taskCwds.set('a', '/work/lucy');
      resolveRepo.mockResolvedValueOnce({
        ok: false,
        code: 'mismatch',
        message: '--repo other/thing (resolves to github.com/other/thing) does not match cwd repo github.com/jeanibarz/lucy, and is not its upstream',
      });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('POST', { repo: 'other/thing', number: KEY.number, taskId: 'a' }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'mismatch' });
      expect(resolveRepo).toHaveBeenCalledWith({ cwd: '/work/lucy', repoFlag: 'other/thing' });
      expect(registry.ownerRecord({ repo: 'github.com/other/thing', number: KEY.number })).toBeNull();
    });
  });

  describe('DELETE /api/issue-claims', () => {
    test('releases the claim when called by its owner', async () => {
      port.addTask('a');
      registry.claim(KEY, { taskId: 'a' });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('DELETE', { repo: KEY.repo, number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
      expect(registry.ownerRecord(KEY)).toBeNull();
      expect(port.tasks.get('a')?.issueClaim).toBeUndefined();
    });

    test('403s when called by a non-owner', async () => {
      port.addTask('a');
      port.addTask('b');
      registry.claim(KEY, { taskId: 'a' });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('DELETE', { repo: KEY.repo, number: KEY.number, taskId: 'b' }),
      );
      expect(res.status).toBe(403);
      expect(registry.ownerRecord(KEY)?.taskId).toBe('a');
    });

    test('403s when the claim has no current owner', async () => {
      port.addTask('a');
      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('DELETE', { repo: KEY.repo, number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(403);
    });

    // Regression pin (correctness review, PR 1a): `kookr issue release 779`
    // sends NO repo — the route must resolve it from cwd like POST does,
    // not 400 on a missing repo string.
    test('releases with no repo in the body, resolving from cwd', async () => {
      port.addTask('a');
      registry.claim(KEY, { taskId: 'a' });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('DELETE', { cwd: '/some/checkout', number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(200);
      expect(resolveRepo).toHaveBeenCalledWith({ cwd: '/some/checkout', repoFlag: undefined });
      expect(registry.ownerRecord(KEY)).toBeNull();
      expect(flushTasks).toHaveBeenCalled(); // release persists too (R5)
    });

    // #1351: DELETE mirrors POST — with no cwd/repo in the body it must
    // resolve against the claimant task's configured checkout so the release
    // targets the same key the grant used.
    test('releases with no cwd/repo, resolving from the claimant task cwd (#1351)', async () => {
      port.addTask('a');
      taskCwds.set('a', '/work/lucy');
      registry.claim(KEY, { taskId: 'a' });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('DELETE', { number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(200);
      expect(resolveRepo).toHaveBeenCalledWith({ cwd: '/work/lucy', repoFlag: undefined });
      expect(registry.ownerRecord(KEY)).toBeNull();
    });

    // Regression pin: the `owner/repo` short form must normalize to the
    // canonical claim key, not miss it and 403 the legitimate owner.
    test('releases with an owner/repo short form, normalized via resolveRepo', async () => {
      port.addTask('a');
      registry.claim(KEY, { taskId: 'a' });

      const res = await mkApp(deps).request(
        '/api/issue-claims',
        jsonRequest('DELETE', { repo: 'kookr-ai/kookr', cwd: '/some/checkout', number: KEY.number, taskId: 'a' }),
      );
      expect(res.status).toBe(200);
      expect(resolveRepo).toHaveBeenCalledWith({ cwd: '/some/checkout', repoFlag: 'kookr-ai/kookr' });
      expect(registry.ownerRecord(KEY)).toBeNull();
    });
  });

  describe('GET /api/issue-claims', () => {
    test('lists decorated records with ageMs and lastActivityAt', async () => {
      port.addTask('a', 'inProgress');
      registry.claim(KEY, { taskId: 'a', sessionId: 'kookr-aaa' });

      const res = await mkApp(deps).request('/api/issue-claims');
      expect(res.status).toBe(200);
      const body = await res.json() as Array<Record<string, unknown>>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ repo: KEY.repo, number: KEY.number, taskId: 'a' });
      expect(body[0].ageMs).toBeTypeOf('number');
    });

    test('filters by repo and number', async () => {
      port.addTask('a', 'inProgress');
      port.addTask('b', 'inProgress');
      registry.claim(KEY, { taskId: 'a' });
      registry.claim({ repo: 'github.com/jeanibarz/lucy', number: 12 }, { taskId: 'b' });

      const app = mkApp(deps);
      const all = await app.request('/api/issue-claims');
      expect(await all.json()).toHaveLength(2);

      const filtered = await app.request(`/api/issue-claims?repo=${encodeURIComponent(KEY.repo)}`);
      const filteredBody = await filtered.json() as Array<Record<string, unknown>>;
      expect(filteredBody).toHaveLength(1);
      expect(filteredBody[0].taskId).toBe('a');

      const byNumber = await app.request(`/api/issue-claims?repo=${encodeURIComponent(KEY.repo)}&number=780`);
      expect(await byNumber.json()).toHaveLength(0);
    });
  });
});
