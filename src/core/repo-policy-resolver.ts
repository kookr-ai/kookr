/**
 * RepoPolicyResolver — single owner of repo policy and baseline resolution.
 *
 * Determines known_policy vs unknown_policy for a project and resolves
 * the authoritative cleanup baseline. Fail-closed: if baseline cannot
 * be determined, classification stops at 'unknown'.
 */

import type { RepoPolicy, BaselineResolution } from './workspace-types.js';
import { gitIn } from './git-helpers.js';

/**
 * Repo profile: explicit baseline configuration for a project.
 * In V1, these are hardcoded for first-party repos. Future phases
 * may load from a config file.
 */
export interface RepoProfile {
  projectId: string;
  baselineRef: string;
}

export interface RepoPolicyResolverOptions {
  /** Known repo profiles (first-party repos with explicit baselines). */
  profiles?: RepoProfile[];
  /** The server's own project ID (always known_policy). */
  serverProjectId?: string;
}

export class RepoPolicyResolver {
  private profiles = new Map<string, RepoProfile>();
  private serverProjectId?: string;

  constructor(opts?: RepoPolicyResolverOptions) {
    for (const p of opts?.profiles ?? []) {
      this.profiles.set(p.projectId, p);
    }
    this.serverProjectId = opts?.serverProjectId;
  }

  /** Determine the policy for a project. */
  getPolicy(projectId: string): RepoPolicy {
    // Explicit profile → known
    if (this.profiles.has(projectId)) return 'known_policy';
    // Server's own project → known
    if (this.serverProjectId && projectId === this.serverProjectId) return 'known_policy';
    // Local projects → known (they're on this machine)
    if (projectId.startsWith('local/')) return 'known_policy';
    // Everything else → unknown until configured
    return 'unknown_policy';
  }

  /**
   * Resolve the authoritative baseline for cleanup classification.
   *
   * Resolution order:
   * 1. Repo profile baseline, if configured
   * 2. Git default branch for any repo with a resolvable origin/HEAD or common
   *    main/master ref
   * 3. Otherwise unknown (fail-closed)
   */
  async resolveBaseline(projectId: string, repoPath: string): Promise<BaselineResolution> {
    const policy = this.getPolicy(projectId);
    const checkedAt = new Date().toISOString();

    // 1. Explicit profile baseline
    const profile = this.profiles.get(projectId);
    if (profile) {
      const sha = await gitIn(repoPath, 'rev-parse', profile.baselineRef);
      if (sha) {
        return {
          policy,
          baselineRef: profile.baselineRef,
          baselineSha: sha,
          checkedAt,
        };
      }
      // Profile exists but ref can't be resolved — fail closed
      return { policy: 'unknown_policy', checkedAt };
    }

    // 2. Default branch from git metadata. The repo policy remains unchanged:
    // an unprofiled github.com/* project can still be "unknown_policy", but a
    // resolved read-only baseline lets cleanup classify safely merged branches.
    const defaultBranch = await resolveDefaultBranch(repoPath, { allowLocalFallback: policy === 'known_policy' });
    if (defaultBranch) {
      const sha = await gitIn(repoPath, 'rev-parse', defaultBranch);
      if (sha) {
        return {
          policy,
          baselineRef: defaultBranch,
          baselineSha: sha,
          checkedAt,
        };
      }
    }

    // 3. Unknown — fail closed
    return { policy: 'unknown_policy', checkedAt };
  }

  /** Add or update a repo profile. */
  setProfile(profile: RepoProfile): void {
    this.profiles.set(profile.projectId, profile);
  }
}

interface ResolveDefaultBranchOptions {
  allowLocalFallback: boolean;
}

/** Resolve the default branch from origin/HEAD, remote common names, or optionally local common names. */
async function resolveDefaultBranch(
  repoPath: string,
  opts: ResolveDefaultBranchOptions,
): Promise<string | null> {
  // Try symbolic ref first. Use the remote-tracking ref as the cleanup
  // baseline so a freshly fetched GitHub merge is visible even when the local
  // main/master branch has not been advanced.
  const ref = await gitIn(repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD');
  if (ref) {
    const parts = ref.split('/');
    const branchName = parts[parts.length - 1];
    if (branchName) return `origin/${branchName}`;
  }

  // Prefer remote-tracking defaults when origin/HEAD is missing. For known
  // local/server projects only, fall back to local branches for repos without
  // a remote. Unprofiled external repos must not classify against local main.
  const names = opts.allowLocalFallback
    ? ['origin/main', 'origin/master', 'main', 'master']
    : ['origin/main', 'origin/master'];

  for (const name of names) {
    const result = await gitIn(repoPath, 'rev-parse', '--verify', name);
    if (result) return name;
  }

  return null;
}
