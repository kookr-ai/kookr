import { describe, it, expect, vi } from 'vitest';
import { resolveClaimRepo, type ResolveClaimRepoDeps } from './resolve-claim-repo.js';

function makeDeps(overrides: Partial<ResolveClaimRepoDeps> = {}): ResolveClaimRepoDeps {
  return {
    getProjectId: vi.fn(async () => 'github.com/owner/repo'),
    activeProjectIds: vi.fn(() => []),
    upstreamOf: vi.fn(async () => null),
    ...overrides,
  };
}

describe('resolveClaimRepo', () => {
  it('resolves from cwd when no --repo flag is given', async () => {
    const deps = makeDeps({ getProjectId: vi.fn(async () => 'github.com/owner/repo') });

    const result = await resolveClaimRepo({ cwd: '/repo' }, deps);

    expect(result).toEqual({ ok: true, repo: 'github.com/owner/repo' });
  });

  it('fails as unresolvable for a local/ cwd with no flag, listing active repos', async () => {
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'local/my-project'),
      activeProjectIds: vi.fn(() => ['github.com/foo/bar', 'github.com/baz/qux']),
    });

    const result = await resolveClaimRepo({ cwd: '/local' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('unresolvable');
    expect(result.message).toContain('github.com/foo/bar');
    expect(result.message).toContain('github.com/baz/qux');
  });

  it('accepts a --repo flag that matches cwd', async () => {
    const deps = makeDeps({ getProjectId: vi.fn(async () => 'github.com/owner/repo') });

    const result = await resolveClaimRepo({ cwd: '/repo', repoFlag: 'owner/repo' }, deps);

    expect(result).toEqual({ ok: true, repo: 'github.com/owner/repo' });
  });

  it('accepts a --repo flag matching the upstream of a fork cwd', async () => {
    const upstreamOf = vi.fn(async (projectId: string) => {
      expect(projectId).toBe('github.com/forker/repo');
      return 'github.com/upstream-owner/repo';
    });
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'github.com/forker/repo'),
      upstreamOf,
    });

    const result = await resolveClaimRepo(
      { cwd: '/fork', repoFlag: 'upstream-owner/repo' },
      deps,
    );

    expect(result).toEqual({ ok: true, repo: 'github.com/upstream-owner/repo' });
    expect(upstreamOf).toHaveBeenCalledWith('github.com/forker/repo');
  });

  it('fails closed as mismatch when --repo is unrelated to cwd and its upstream', async () => {
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'github.com/forker/repo'),
      upstreamOf: vi.fn(async () => 'github.com/upstream-owner/repo'),
    });

    const result = await resolveClaimRepo(
      { cwd: '/fork', repoFlag: 'unrelated-owner/other-repo' },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('mismatch');
    expect(result.message).toContain('github.com/forker/repo');
    expect(result.message).toContain('github.com/unrelated-owner/other-repo');
  });

  it('fails closed as mismatch when upstreamOf throws (hallucination guard)', async () => {
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'github.com/forker/repo'),
      upstreamOf: vi.fn(async () => {
        throw new Error('gh timed out');
      }),
    });

    const result = await resolveClaimRepo(
      { cwd: '/fork', repoFlag: 'upstream-owner/repo' },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('mismatch');
    expect(result.message).toContain('github.com/forker/repo');
    expect(result.message).toContain('github.com/upstream-owner/repo');
  });

  it('resolves a unique bare repo name among active project ids', async () => {
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'local/some-dir'),
      activeProjectIds: vi.fn(() => ['github.com/someone/lucy', 'github.com/other/unrelated']),
    });

    const result = await resolveClaimRepo({ cwd: '/local', repoFlag: 'lucy' }, deps);

    expect(result).toEqual({ ok: true, repo: 'github.com/someone/lucy' });
  });

  it('is case-insensitive when matching a bare repo name', async () => {
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'local/some-dir'),
      activeProjectIds: vi.fn(() => ['github.com/someone/lucy']),
    });

    const result = await resolveClaimRepo({ cwd: '/local', repoFlag: 'LUCY' }, deps);

    expect(result).toEqual({ ok: true, repo: 'github.com/someone/lucy' });
  });

  it('fails as ambiguous_bare_name when a bare name matches multiple active repos', async () => {
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'local/some-dir'),
      activeProjectIds: vi.fn(() => ['github.com/foo/lucy', 'github.com/bar/lucy']),
    });

    const result = await resolveClaimRepo({ cwd: '/local', repoFlag: 'lucy' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('ambiguous_bare_name');
    expect(result.candidates).toEqual(['github.com/foo/lucy', 'github.com/bar/lucy']);
  });

  it('fails as ambiguous_bare_name when a bare name matches no active repos', async () => {
    const deps = makeDeps({
      getProjectId: vi.fn(async () => 'local/some-dir'),
      activeProjectIds: vi.fn(() => ['github.com/foo/bar']),
    });

    const result = await resolveClaimRepo({ cwd: '/local', repoFlag: 'lucy' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('ambiguous_bare_name');
    expect(result.candidates).toEqual([]);
  });

  it('normalizes an SSH-URL --repo flag that matches cwd', async () => {
    const deps = makeDeps({ getProjectId: vi.fn(async () => 'github.com/owner/repo') });

    const result = await resolveClaimRepo(
      { cwd: '/repo', repoFlag: 'git@github.com:owner/repo.git' },
      deps,
    );

    expect(result).toEqual({ ok: true, repo: 'github.com/owner/repo' });
  });

  it('rejects an unsafe project id even when accepted from cwd', async () => {
    const deps = makeDeps({ getProjectId: vi.fn(async () => 'local/whatever') });

    const result = await resolveClaimRepo({ cwd: '/local', repoFlag: 'owner/..' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('unresolvable');
  });
});
