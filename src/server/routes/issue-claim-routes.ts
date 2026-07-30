import type { Context, Hono } from 'hono';
import { isSafeGithubProjectId, projectIdFromRepoSpecifier } from '../../core/project-identity.js';
import { isTerminalStatus, type TaskStatus } from '../../core/task-status.js';
import type { IssueClaimRegistry } from '../../core/issue-claim-registry.js';
import type { ClaimOwnerRecord } from '../../core/issue-claim-types.js';
import type { DecoratedClaim } from '../issue-claim-decorator.js';
import type { ResolveClaimRepoResult } from '../use-cases/resolve-claim-repo.js';

export type { ResolveClaimRepoResult } from '../use-cases/resolve-claim-repo.js';

export interface IssueClaimRouteDeps {
  /** KOOKR_ISSUE_CLAIMS resolved at startup (R7: restart-gated, not live-toggled). */
  enabled: boolean;
  registry: IssueClaimRegistry;
  decorate: (record: ClaimOwnerRecord) => DecoratedClaim;
  resolveRepo: (input: { cwd?: string; repoFlag?: string }) => Promise<ResolveClaimRepoResult>;
  /** TaskStateSaveScheduler.flush, bound — awaited after a grant (RFC R5). */
  flushTasks: () => Promise<void>;
  /** To 400 an unknown/terminal claimant task before ever touching the registry. */
  getTaskStatus: (taskId: string) => TaskStatus | undefined;
  /**
   * The claimant task's configured cwd, or undefined when unknown (#1351).
   *
   * When a caller omits an explicit `cwd`, the claim repo must be resolved
   * from the OWNING TASK's configured checkout — not the server's launch
   * checkout (`serverCwd`) or the agent session's bootstrap directory. A task
   * configured for repo A can then claim A even when the process that hosts
   * the API was bootstrapped from repo B. Returns undefined for pure API
   * callers with no known task, preserving the existing `serverCwd` fallback.
   */
  getTaskCwd: (taskId: string) => string | undefined;
}

const ISSUE_CLAIMS_PATH = '/api/issue-claims';

/**
 * Registers the three issue-claim routes (RFC §4) on the shared app,
 * following this codebase's `registerXRoutes(app, deps)` convention (see
 * `metrics-routes.ts`, `task-relations-routes.ts`) rather than a mounted
 * Hono sub-instance — every other route module in `src/server/routes/`
 * registers directly on the app passed in from `routes.ts`, and this stays
 * consistent so the (separately-done) wiring is a one-line addition there.
 *
 * NOTE (RFC deviation, R4 design table): `DELETE` takes `repo`/`number` in
 * the JSON body rather than the RFC sketch's `/:repo/:number` path params —
 * `repo` values contain slashes (`github.com/owner/repo`), which collide
 * with Hono path-param segmentation.
 */
export function registerIssueClaimRoutes(app: Hono, deps: IssueClaimRouteDeps): void {
  app.post(ISSUE_CLAIMS_PATH, async (c) => {
    if (!deps.enabled) return disabledResponse(c);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const number = body.number;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
      return c.json({ error: 'number must be a positive integer' }, 400);
    }

    const taskId = body.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return c.json({ error: 'taskId is required and must be a string' }, 400);
    }
    const taskStatus = deps.getTaskStatus(taskId);
    if (taskStatus === undefined) {
      return c.json({ error: `unknown taskId: ${taskId}`, code: 'unknown_task' }, 400);
    }
    if (isTerminalStatus(taskStatus)) {
      return c.json({ error: `taskId ${taskId} is already terminal (${taskStatus})`, code: 'terminal_task' }, 400);
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const force = body.force === true;
    const bodyCwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    const repoFlag = typeof body.repo === 'string' ? body.repo : undefined;

    let repo: string;
    if (repoFlag !== undefined && isSafeGithubProjectId(repoFlag) && bodyCwd === undefined) {
      // Canonical repo with NO explicit cwd context (pure API caller):
      // nothing to check a mismatch against, accept as-is. When cwd IS
      // present, always run resolveRepo so the R20 hallucination guard
      // applies even to canonical-form input.
      repo = repoFlag;
    } else {
      // #1351: when the caller supplies no explicit cwd, fall back to the
      // claimant task's configured checkout rather than the server's launch
      // cwd, so repo resolution reflects the task's project. Applied only on
      // the resolve path so the canonical short-circuit above is unchanged.
      const cwd = bodyCwd ?? deps.getTaskCwd(taskId);
      const resolution = await deps.resolveRepo({ cwd, repoFlag });
      if (!resolution.ok) {
        return c.json(
          {
            error: resolution.message,
            code: resolution.code,
            ...(resolution.candidates ? { candidates: resolution.candidates } : {}),
          },
          400,
        );
      }
      repo = resolution.repo;
    }

    // F4 (TOCTOU): resolveRepo may await (gh fork lookup, up to ~3s); the
    // claimant could have gone terminal meanwhile. Re-check before granting.
    const statusAfterResolve = deps.getTaskStatus(taskId);
    if (statusAfterResolve === undefined || isTerminalStatus(statusAfterResolve)) {
      return c.json({ error: `taskId ${taskId} is no longer claimable`, code: 'terminal_task' }, 400);
    }

    const result = deps.registry.claim(
      { repo, number },
      { taskId, ...(sessionId !== undefined ? { sessionId } : {}) },
      { force },
    );

    if (!result.ok) {
      return c.json({ owned: false, owner: deps.decorate(result.owner) }, 409);
    }

    await deps.flushTasks();
    return c.json({
      owned: true,
      reentrant: result.reentrant,
      // Include resolved repo so CLI success lines never print "(unknown repo)"
      // when --repo was omitted (issue #1230 dogfood).
      repo,
      number,
      ...(result.tookOver ? { tookOver: deps.decorate(result.tookOver) } : {}),
    });
  });

  app.delete(ISSUE_CLAIMS_PATH, async (c) => {
    if (!deps.enabled) return disabledResponse(c);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const number = body.number;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
      return c.json({ error: 'number must be a positive integer' }, 400);
    }
    const taskId = body.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return c.json({ error: 'taskId is required and must be a string' }, 400);
    }

    // Same repo resolution as POST: cwd default, normalization, and the R20
    // mismatch guard — `kookr issue release 779` with no --repo must work,
    // and an `owner/repo` short form must normalize to the canonical key.
    const bodyCwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    const repoFlag = typeof body.repo === 'string' ? body.repo : undefined;
    let repo: string;
    if (repoFlag !== undefined && isSafeGithubProjectId(repoFlag) && bodyCwd === undefined) {
      repo = repoFlag;
    } else {
      // #1351: mirror POST's task-cwd fallback so a release resolves against
      // the same key the claim was granted under.
      const cwd = bodyCwd ?? deps.getTaskCwd(taskId);
      const resolution = await deps.resolveRepo({ cwd, repoFlag });
      if (!resolution.ok) {
        return c.json(
          {
            error: resolution.message,
            code: resolution.code,
            ...(resolution.candidates ? { candidates: resolution.candidates } : {}),
          },
          400,
        );
      }
      repo = resolution.repo;
    }

    // Holder-checked (RFC R10): only the current live owner may release.
    const owner = deps.registry.ownerRecord({ repo, number });
    if (!owner || owner.taskId !== taskId) {
      return c.json({ error: 'not the current owner of this claim' }, 403);
    }

    deps.registry.releaseAllFor(taskId);
    // Persist the cleared projection (R5 applies to releases too — an
    // unflushed release could resurrect the claim at reboot).
    await deps.flushTasks();
    return c.json({ ok: true });
  });

  app.get(ISSUE_CLAIMS_PATH, (c) => {
    if (!deps.enabled) return disabledResponse(c);

    const rawRepo = c.req.query('repo');
    let repo: string | undefined;
    if (rawRepo) {
      const normalized = projectIdFromRepoSpecifier(rawRepo);
      if (!normalized) return c.json({ error: `invalid repo: ${rawRepo}` }, 400);
      repo = normalized;
    }

    const rawNumber = c.req.query('number');
    let number: number | undefined;
    if (rawNumber !== undefined) {
      const parsed = Number(rawNumber);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return c.json({ error: `invalid number: ${rawNumber}` }, 400);
      }
      number = parsed;
    }

    const records = deps.registry.listRecords({ repo, number }).map((record) => deps.decorate(record));
    return c.json(records);
  });

  // R16: automatic caller exhausted re-selection after exit-6 denials.
  // Emits an `exhausted` audit event so give-up is observable (not silent).
  app.post(`${ISSUE_CLAIMS_PATH}/exhausted`, async (c) => {
    if (!deps.enabled) return disabledResponse(c);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const number = body.number;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
      return c.json({ error: 'number must be a positive integer' }, 400);
    }
    if (typeof body.repo !== 'string' || body.repo.trim() === '') {
      return c.json({ error: 'repo is required for exhausted events' }, 400);
    }
    const repo =
      projectIdFromRepoSpecifier(body.repo)
      ?? (isSafeGithubProjectId(body.repo) ? body.repo : null);
    if (!repo) {
      return c.json({ error: `invalid repo: ${body.repo}` }, 400);
    }
    const requestingTaskId = typeof body.taskId === 'string' ? body.taskId : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;

    deps.registry.recordExhausted(
      { repo, number },
      {
        ...(requestingTaskId !== undefined ? { requestingTaskId } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
    );
    return c.json({ ok: true, decision: 'exhausted', repo, number });
  });
}

function disabledResponse(c: Context): Response {
  return c.json({ error: 'issue-claims-disabled' }, 404);
}
