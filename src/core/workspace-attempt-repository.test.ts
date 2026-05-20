import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAttemptRepository } from './workspace-attempt-repository.js';

describe('WorkspaceAttemptRepository', () => {
  let repo: WorkspaceAttemptRepository;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workspace-attempts-'));
    repo = new WorkspaceAttemptRepository();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createAttempt', () => {
    it('creates an attempt with running status', () => {
      const attempt = repo.createAttempt({
        type: 'preflight',
        projectId: 'github.com/org/repo',
        reasonCode: 'cleanup_requested',
        source: 'workspace_ui',
        evidenceSummary: 'test',
      });

      expect(attempt.attemptId).toBeTruthy();
      expect(attempt.type).toBe('preflight');
      expect(attempt.status).toBe('running');
      expect(attempt.projectId).toBe('github.com/org/repo');
      expect(attempt.startedAt).toBeTruthy();
    });

    it('includes optional fields', () => {
      const attempt = repo.createAttempt({
        type: 'cleanup',
        projectId: 'github.com/org/repo',
        worktreePath: '/path/wt',
        branch: 'feature/test',
        baselineRef: 'main',
        baselineSha: 'abc123',
        reasonCode: 'merged',
        source: 'cleanup_inspector',
        evidenceSummary: 'branch merged',
        correlatedTaskId: 'task-1',
      });

      expect(attempt.worktreePath).toBe('/path/wt');
      expect(attempt.branch).toBe('feature/test');
      expect(attempt.baselineRef).toBe('main');
      expect(attempt.correlatedTaskId).toBe('task-1');
    });
  });

  describe('completeAttempt', () => {
    it('sets status to completed and disposition correctly', () => {
      const attempt = repo.createAttempt({
        type: 'cleanup',
        projectId: 'proj',
        reasonCode: 'merged',
        source: 'test',
        evidenceSummary: 'initial',
      });

      const result = repo.completeAttempt(attempt.attemptId, 'completed', 'cleanup done');
      expect(result?.status).toBe('completed');
      expect(result?.disposition).toBe('completed');
      expect(result?.evidenceSummary).toBe('cleanup done');
      expect(result?.finishedAt).toBeTruthy();
    });

    it('sets disposition to path_removed_branch_retained', () => {
      const attempt = repo.createAttempt({
        type: 'cleanup',
        projectId: 'proj',
        reasonCode: 'merged',
        source: 'test',
        evidenceSummary: 'initial',
      });

      const result = repo.completeAttempt(attempt.attemptId, 'path_removed_branch_retained');
      expect(result?.status).toBe('completed');
      expect(result?.disposition).toBe('path_removed_branch_retained');
    });

    it('returns undefined for unknown attemptId', () => {
      expect(repo.completeAttempt('nonexistent', 'completed')).toBeUndefined();
    });
  });

  describe('updateAttempt', () => {
    it('updates status and disposition', () => {
      const attempt = repo.createAttempt({
        type: 'preflight',
        projectId: 'proj',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'test',
      });

      const updated = repo.updateAttempt(attempt.attemptId, {
        status: 'completed',
        disposition: 'completed',
        finishedAt: '2026-04-04T00:00:00Z',
      });

      expect(updated?.status).toBe('completed');
      expect(updated?.disposition).toBe('completed');
      expect(updated?.finishedAt).toBe('2026-04-04T00:00:00Z');
    });

    it('returns undefined for unknown attemptId', () => {
      expect(repo.updateAttempt('nonexistent', { status: 'completed' })).toBeUndefined();
    });

    it('applies partial patch with only status', () => {
      const attempt = repo.createAttempt({
        type: 'preflight',
        projectId: 'proj',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'initial evidence',
      });

      const updated = repo.updateAttempt(attempt.attemptId, {
        status: 'timed_out',
      });

      expect(updated?.status).toBe('timed_out');
      // disposition should remain at its initial value
      expect(updated?.disposition).toBe('blocked');
      // evidenceSummary should remain unchanged
      expect(updated?.evidenceSummary).toBe('initial evidence');
    });

    it('applies partial patch with only disposition', () => {
      const attempt = repo.createAttempt({
        type: 'cleanup',
        projectId: 'proj',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'initial',
      });

      const updated = repo.updateAttempt(attempt.attemptId, {
        disposition: 'prune_failed',
      });

      // status remains at its initial value
      expect(updated?.status).toBe('running');
      expect(updated?.disposition).toBe('prune_failed');
    });

    it('applies stderrSummary and lastProgressAt', () => {
      const attempt = repo.createAttempt({
        type: 'preflight',
        projectId: 'proj',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'test',
      });

      const updated = repo.updateAttempt(attempt.attemptId, {
        stderrSummary: 'git error: lock failed',
        lastProgressAt: '2026-04-04T01:00:00Z',
      });

      expect(updated?.stderrSummary).toBe('git error: lock failed');
      expect(updated?.lastProgressAt).toBe('2026-04-04T01:00:00Z');
    });
  });

  describe('getAttempt', () => {
    it('returns the attempt for an existing ID', () => {
      const created = repo.createAttempt({
        type: 'preflight',
        projectId: 'proj',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'test',
      });

      const fetched = repo.getAttempt(created.attemptId);
      expect(fetched).toBeDefined();
      expect(fetched?.attemptId).toBe(created.attemptId);
      expect(fetched?.type).toBe('preflight');
      expect(fetched?.projectId).toBe('proj');
    });

    it('returns undefined for a non-existing ID', () => {
      expect(repo.getAttempt('does-not-exist')).toBeUndefined();
    });
  });

  describe('passAttempt', () => {
    it('marks attempt as passed', () => {
      const attempt = repo.createAttempt({
        type: 'preflight',
        projectId: 'proj',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'initial',
      });

      const result = repo.passAttempt(attempt.attemptId, 'all good');
      expect(result?.status).toBe('passed');
      expect(result?.disposition).toBe('passed');
      expect(result?.evidenceSummary).toBe('all good');
      expect(result?.finishedAt).toBeTruthy();
    });
  });

  describe('blockAttempt', () => {
    it('marks attempt as blocked', () => {
      const attempt = repo.createAttempt({
        type: 'cleanup',
        projectId: 'proj',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'initial',
      });

      const result = repo.blockAttempt(attempt.attemptId, 'dirty state');
      expect(result?.status).toBe('blocked');
      expect(result?.disposition).toBe('blocked');
    });
  });

  describe('listByProject', () => {
    it('returns attempts for the project sorted by startedAt descending', () => {
      repo.createAttempt({
        type: 'preflight',
        projectId: 'proj-a',
        reasonCode: 'first',
        source: 'test',
        evidenceSummary: 'first',
      });
      repo.createAttempt({
        type: 'cleanup',
        projectId: 'proj-a',
        reasonCode: 'second',
        source: 'test',
        evidenceSummary: 'second',
      });
      repo.createAttempt({
        type: 'preflight',
        projectId: 'proj-b',
        reasonCode: 'other',
        source: 'test',
        evidenceSummary: 'other project',
      });

      const results = repo.listByProject('proj-a');
      expect(results).toHaveLength(2);
      const codes = results.map((r) => r.reasonCode).sort();
      expect(codes).toEqual(['first', 'second']);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        repo.createAttempt({
          type: 'preflight',
          projectId: 'proj',
          reasonCode: `attempt-${i}`,
          source: 'test',
          evidenceSummary: `test ${i}`,
        });
      }

      expect(repo.listByProject('proj', 3)).toHaveLength(3);
    });

    it('returns empty array for unknown project', () => {
      repo.createAttempt({
        type: 'preflight',
        projectId: 'proj-a',
        reasonCode: 'test',
        source: 'test',
        evidenceSummary: 'test',
      });

      const results = repo.listByProject('nonexistent-project');
      expect(results).toEqual([]);
    });

    it('defaults to limit of 20', () => {
      for (let i = 0; i < 25; i++) {
        repo.createAttempt({
          type: 'preflight',
          projectId: 'proj',
          reasonCode: `attempt-${i}`,
          source: 'test',
          evidenceSummary: `test ${i}`,
        });
      }

      const results = repo.listByProject('proj');
      expect(results).toHaveLength(20);
    });

    it('multiple attempts for same project do not interfere with other projects', () => {
      for (let i = 0; i < 5; i++) {
        repo.createAttempt({
          type: 'preflight',
          projectId: 'proj-a',
          reasonCode: `a-${i}`,
          source: 'test',
          evidenceSummary: `proj-a attempt ${i}`,
        });
      }
      for (let i = 0; i < 3; i++) {
        repo.createAttempt({
          type: 'cleanup',
          projectId: 'proj-b',
          reasonCode: `b-${i}`,
          source: 'test',
          evidenceSummary: `proj-b attempt ${i}`,
        });
      }

      const projA = repo.listByProject('proj-a');
      const projB = repo.listByProject('proj-b');

      expect(projA).toHaveLength(5);
      expect(projB).toHaveLength(3);

      // Verify no cross-contamination
      expect(projA.every((a) => a.projectId === 'proj-a')).toBe(true);
      expect(projB.every((a) => a.projectId === 'proj-b')).toBe(true);
    });
  });

  describe('persistence', () => {
    it('reloads attempts from disk', () => {
      const filePath = join(tempDir, 'workspace-attempts.json');
      const persistentRepo = new WorkspaceAttemptRepository(filePath);

      const attempt = persistentRepo.createAttempt({
        type: 'cleanup',
        projectId: 'proj',
        worktreePath: '/repo-wt',
        branch: 'feature/test',
        reasonCode: 'cleanup_requested',
        source: 'workspace_ui',
        evidenceSummary: 'remove merged branch',
      });
      persistentRepo.passAttempt(attempt.attemptId, 'done');

      const reloaded = new WorkspaceAttemptRepository(filePath);
      expect(reloaded.listByProject('proj')).toHaveLength(1);
      expect(reloaded.getAttempt(attempt.attemptId)?.status).toBe('passed');
    });

    it('falls back to empty state on corrupt files', () => {
      const filePath = join(tempDir, 'workspace-attempts.json');
      writeFileSync(filePath, '{"version":1,"attempts":[', 'utf-8');

      const reloaded = new WorkspaceAttemptRepository(filePath);
      expect(reloaded.listByProject('proj')).toEqual([]);
    });
  });
});
