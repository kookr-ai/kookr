import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RepoPolicyResolver } from './repo-policy-resolver.js';

// Mock child_process to avoid real git calls
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    // Default: resolve with empty stdout
    cb(null, { stdout: '' }, '');
  }),
}));

import { execFile } from 'node:child_process';
const mockExecFile = vi.mocked(execFile);

function mockGitResponse(response: string | null) {
  if (response === null) {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(new Error('git failed'), { stdout: '' }, '');
    });
  } else {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, { stdout: response + '\n' }, '');
    });
  }
}

describe('RepoPolicyResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPolicy', () => {
    it('returns known_policy for configured profiles', () => {
      const resolver = new RepoPolicyResolver({
        profiles: [{ projectId: 'github.com/kookr-ai/kookr', baselineRef: 'main' }],
      });
      expect(resolver.getPolicy('github.com/kookr-ai/kookr')).toBe('known_policy');
    });

    it('returns known_policy for server project', () => {
      const resolver = new RepoPolicyResolver({
        serverProjectId: 'github.com/kookr-ai/kookr',
      });
      expect(resolver.getPolicy('github.com/kookr-ai/kookr')).toBe('known_policy');
    });

    it('returns known_policy for local projects', () => {
      const resolver = new RepoPolicyResolver();
      expect(resolver.getPolicy('local/myproject')).toBe('known_policy');
    });

    it('returns unknown_policy for unconfigured external repos', () => {
      const resolver = new RepoPolicyResolver();
      expect(resolver.getPolicy('github.com/unknown/repo')).toBe('unknown_policy');
    });

    it('returns known_policy with multiple profiles', () => {
      const resolver = new RepoPolicyResolver({
        profiles: [
          { projectId: 'github.com/org/repo-a', baselineRef: 'main' },
          { projectId: 'github.com/org/repo-b', baselineRef: 'develop' },
          { projectId: 'github.com/other/repo-c', baselineRef: 'trunk' },
        ],
      });

      expect(resolver.getPolicy('github.com/org/repo-a')).toBe('known_policy');
      expect(resolver.getPolicy('github.com/org/repo-b')).toBe('known_policy');
      expect(resolver.getPolicy('github.com/other/repo-c')).toBe('known_policy');
      // Not in profiles
      expect(resolver.getPolicy('github.com/org/repo-d')).toBe('unknown_policy');
    });

    it('serverProjectId takes precedence over missing profile', () => {
      const resolver = new RepoPolicyResolver({
        serverProjectId: 'github.com/kookr-ai/kookr',
        profiles: [
          { projectId: 'github.com/other/repo', baselineRef: 'main' },
        ],
      });

      // Server project is known even though it's not in profiles
      expect(resolver.getPolicy('github.com/kookr-ai/kookr')).toBe('known_policy');
      // Profile entry is also known
      expect(resolver.getPolicy('github.com/other/repo')).toBe('known_policy');
      // Neither server nor profile
      expect(resolver.getPolicy('github.com/random/repo')).toBe('unknown_policy');
    });

    it('empty profiles array behaves same as no profiles', () => {
      const withEmpty = new RepoPolicyResolver({ profiles: [] });
      const withNone = new RepoPolicyResolver();

      // Both should return unknown for external repos
      expect(withEmpty.getPolicy('github.com/org/repo')).toBe('unknown_policy');
      expect(withNone.getPolicy('github.com/org/repo')).toBe('unknown_policy');

      // Both should return known for local projects
      expect(withEmpty.getPolicy('local/project')).toBe('known_policy');
      expect(withNone.getPolicy('local/project')).toBe('known_policy');
    });
  });

  describe('resolveBaseline', () => {
    it('uses profile baseline when configured', async () => {
      const resolver = new RepoPolicyResolver({
        profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'develop' }],
      });
      mockGitResponse('abc123');

      const result = await resolver.resolveBaseline('github.com/org/repo', '/repo');
      expect(result.policy).toBe('known_policy');
      expect(result.baselineRef).toBe('develop');
      expect(result.baselineSha).toBe('abc123');
      expect(result.checkedAt).toBeTruthy();
    });

    it('fails closed when profile ref cannot be resolved', async () => {
      const resolver = new RepoPolicyResolver({
        profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'develop' }],
      });
      mockGitResponse(null);

      const result = await resolver.resolveBaseline('github.com/org/repo', '/repo');
      expect(result.policy).toBe('unknown_policy');
      expect(result.baselineRef).toBeUndefined();
    });

    it('returns unknown for unconfigured external repos', async () => {
      const resolver = new RepoPolicyResolver();
      const result = await resolver.resolveBaseline('github.com/unknown/repo', '/repo');
      expect(result.policy).toBe('unknown_policy');
      expect(result.baselineRef).toBeUndefined();
    });

    it('resolves the remote default branch for known local repos', async () => {
      const resolver = new RepoPolicyResolver({
        serverProjectId: 'local/myproject',
      });
      // First call: symbolic-ref returns the default branch
      // Second call: rev-parse returns the SHA
      let callCount = 0;
      mockExecFile.mockImplementation((_cmd, args: any, _opts, cb: any) => {
        callCount++;
        if (callCount === 1) {
          // symbolic-ref
          cb(null, { stdout: 'refs/remotes/origin/main\n' }, '');
        } else {
          // rev-parse
          cb(null, { stdout: 'def456\n' }, '');
        }
      });

      const result = await resolver.resolveBaseline('local/myproject', '/repo');
      expect(result.policy).toBe('known_policy');
      expect(result.baselineRef).toBe('origin/main');
      expect(result.baselineSha).toBe('def456');
    });

    it('fallback chain: symbolic-ref fails, prefers remote main over stale local branches', async () => {
      const resolver = new RepoPolicyResolver({
        serverProjectId: 'local/myproject',
      });

      let callCount = 0;
      mockExecFile.mockImplementation((_cmd, args: any, _opts, cb: any) => {
        callCount++;
        if (callCount === 1) {
          // symbolic-ref fails (no origin/HEAD)
          cb(new Error('not a symbolic ref'), { stdout: '' }, '');
        } else if (callCount === 2) {
          // rev-parse --verify origin/main succeeds
          cb(null, { stdout: 'origin-main-sha\n' }, '');
        } else if (callCount === 3) {
          // rev-parse origin/main (resolve SHA for the baseline)
          cb(null, { stdout: 'origin-main-sha\n' }, '');
        }
      });

      const result = await resolver.resolveBaseline('local/myproject', '/repo');
      expect(result.policy).toBe('known_policy');
      expect(result.baselineRef).toBe('origin/main');
      expect(result.baselineSha).toBe('origin-main-sha');
    });

    it('falls back to local branches when no remote default branch exists', async () => {
      const resolver = new RepoPolicyResolver({
        serverProjectId: 'local/myproject',
      });

      let callCount = 0;
      mockExecFile.mockImplementation((_cmd, args: any, _opts, cb: any) => {
        callCount++;
        if (callCount === 1) {
          // symbolic-ref fails (no origin/HEAD)
          cb(new Error('not a symbolic ref'), { stdout: '' }, '');
        } else if (callCount === 2) {
          // rev-parse --verify origin/main fails
          cb(new Error('not found'), { stdout: '' }, '');
        } else if (callCount === 3) {
          // rev-parse --verify origin/master fails
          cb(new Error('not found'), { stdout: '' }, '');
        } else if (callCount === 4) {
          // rev-parse --verify main fails
          cb(new Error('not found'), { stdout: '' }, '');
        } else if (callCount === 5) {
          // rev-parse --verify master succeeds
          cb(null, { stdout: 'master-sha-789\n' }, '');
        } else if (callCount === 6) {
          // rev-parse master (resolve SHA for the baseline)
          cb(null, { stdout: 'master-sha-789\n' }, '');
        }
      });

      const result = await resolver.resolveBaseline('local/myproject', '/repo');
      expect(result.policy).toBe('known_policy');
      expect(result.baselineRef).toBe('master');
      expect(result.baselineSha).toBe('master-sha-789');
    });

    it('resolves baseline for local project with no git remote', async () => {
      const resolver = new RepoPolicyResolver({
        serverProjectId: 'local/no-remote',
      });

      // All git commands fail (no remote, no main, no master)
      mockGitResponse(null);

      const result = await resolver.resolveBaseline('local/no-remote', '/repo');
      // Fail-closed: even though it's a known project, we can't resolve baseline
      expect(result.policy).toBe('unknown_policy');
      expect(result.baselineRef).toBeUndefined();
      expect(result.baselineSha).toBeUndefined();
    });

    it('each call is fresh (no caching)', async () => {
      const resolver = new RepoPolicyResolver({
        profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }],
      });

      // First call: resolve successfully
      mockGitResponse('sha-first');
      const result1 = await resolver.resolveBaseline('github.com/org/repo', '/repo');
      expect(result1.baselineSha).toBe('sha-first');

      // Second call: different SHA (simulating the branch moved)
      mockGitResponse('sha-second');
      const result2 = await resolver.resolveBaseline('github.com/org/repo', '/repo');
      expect(result2.baselineSha).toBe('sha-second');

      // The mock was called twice (once per resolveBaseline call)
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('setProfile', () => {
    it('adds a new profile', () => {
      const resolver = new RepoPolicyResolver();
      expect(resolver.getPolicy('github.com/new/repo')).toBe('unknown_policy');
      resolver.setProfile({ projectId: 'github.com/new/repo', baselineRef: 'main' });
      expect(resolver.getPolicy('github.com/new/repo')).toBe('known_policy');
    });

    it('overrides existing profile', async () => {
      const resolver = new RepoPolicyResolver({
        profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }],
      });

      // Override the baseline ref
      resolver.setProfile({ projectId: 'github.com/org/repo', baselineRef: 'develop' });

      // Verify the new baseline is used
      mockGitResponse('new-sha-999');
      const result = await resolver.resolveBaseline('github.com/org/repo', '/repo');
      expect(result.baselineRef).toBe('develop');
      expect(result.baselineSha).toBe('new-sha-999');
    });
  });
});
