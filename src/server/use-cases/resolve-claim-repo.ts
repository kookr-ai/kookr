import { isSafeGithubProjectId, projectIdFromRepoSpecifier } from '../../core/project-identity.js';

export interface ResolveClaimRepoDeps {
  /** Inject `src/core/project-identity.js` `getProjectId`. */
  getProjectId: (cwd: string) => Promise<string>;
  /** Inject `TaskStore.getProjectIds` bound. */
  activeProjectIds: () => string[];
  /** gh-backed fork→parent lookup; may reject or time out — callers must guard. */
  upstreamOf: (projectId: string) => Promise<string | null>;
}

export type ResolveClaimRepoResult =
  | { ok: true; repo: string }
  | {
      ok: false;
      code: 'unresolvable' | 'fork_needs_repo' | 'mismatch' | 'ambiguous_bare_name';
      message: string;
      candidates?: string[];
    };

export interface ResolveClaimRepoInput {
  cwd: string;
  repoFlag?: string;
}

/**
 * Resolve the canonical claim-key repo for an issue claim (RFC
 * docs/rfc/rfc-issue-ownership-lock.md §6, R19/R20).
 *
 * The claim key is always the issue's HOME repo — for forks that's the
 * upstream, so two forks of one upstream collide on one key.
 *
 * v1 deliberately does NOT attempt fork auto-detection on the no-flag path
 * (R19): resolving cwd's upstream requires a gh call, and the no-flag path
 * must stay a fast, local-only resolution. Without `--repo`, cwd's own
 * project id is accepted as-is, even if it happens to be a fork. Fork
 * awareness only kicks in once a `--repo` flag is present (typically
 * auto-populated by instrumented playbooks from their own repo parameter),
 * at which point `deps.upstreamOf` is consulted — and fail-closed (`mismatch`)
 * on any error, timeout, or non-matching upstream, per R20's hallucination
 * guard. Automatic gh-backed upstream detection without a flag is a deferred
 * fast-follow; the `fork_needs_repo` code is reserved for that future path.
 */
export async function resolveClaimRepo(
  input: ResolveClaimRepoInput,
  deps: ResolveClaimRepoDeps,
): Promise<ResolveClaimRepoResult> {
  const cwdProjectId = await deps.getProjectId(input.cwd);
  const fromCwd = cwdProjectId.startsWith('local/') ? null : cwdProjectId;

  const repoFlag = input.repoFlag?.trim();
  if (!repoFlag) {
    if (fromCwd && isSafeGithubProjectId(fromCwd)) {
      return { ok: true, repo: fromCwd };
    }
    return {
      ok: false,
      code: 'unresolvable',
      message: unresolvableMessage(fromCwd, deps.activeProjectIds()),
    };
  }

  const parsedFlag = projectIdFromRepoSpecifier(repoFlag);
  if (!parsedFlag) {
    return resolveBareName(repoFlag, deps.activeProjectIds());
  }

  if (fromCwd === null || fromCwd.toLowerCase() === parsedFlag.toLowerCase()) {
    return validate(parsedFlag);
  }

  let upstream: string | null = null;
  try {
    upstream = await deps.upstreamOf(fromCwd);
  } catch {
    // Fail closed (R20): a gh error or timeout must never be treated as a
    // silent pass — an unverified upstream claim is exactly the
    // hallucination this guard exists to prevent.
    upstream = null;
  }

  if (upstream && upstream.toLowerCase() === parsedFlag.toLowerCase()) {
    return validate(parsedFlag);
  }

  return {
    ok: false,
    code: 'mismatch',
    message: `--repo ${repoFlag} (resolves to ${parsedFlag}) does not match cwd repo ${fromCwd}, and is not its upstream`,
  };
}

function resolveBareName(bareName: string, activeProjectIds: string[]): ResolveClaimRepoResult {
  const needle = bareName.toLowerCase();
  const matches = activeProjectIds.filter((id) => {
    const segments = id.split('/');
    const repoName = segments[segments.length - 1];
    return repoName.toLowerCase() === needle;
  });

  if (matches.length === 1) {
    return validate(matches[0]);
  }

  return {
    ok: false,
    code: 'ambiguous_bare_name',
    message:
      matches.length === 0
        ? `"${bareName}" does not match any active repo; specify owner/repo`
        : `"${bareName}" matches ${matches.length} active repos; specify owner/repo`,
    candidates: matches,
  };
}

function validate(repo: string): ResolveClaimRepoResult {
  if (isSafeGithubProjectId(repo)) {
    return { ok: true, repo };
  }
  return {
    ok: false,
    code: 'unresolvable',
    message: `resolved repo "${repo}" failed safety validation`,
  };
}

function unresolvableMessage(fromCwd: string | null, activeProjectIds: string[]): string {
  const cwdPart = fromCwd ? `cwd repo: ${fromCwd}` : 'cwd repo: none (local checkout, no remote)';
  const activePart =
    activeProjectIds.length > 0 ? `active repos: ${activeProjectIds.join(', ')}` : 'active repos: (none)';
  return `unable to resolve a repo for this claim (${cwdPart}; ${activePart})`;
}
