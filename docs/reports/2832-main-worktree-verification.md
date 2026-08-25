# Main-worktree verification for #2832

Captured at `2026-08-25T04:51:32Z` after `git fetch origin main`.

## Outcome

The primary checkout is back on a named branch, and the repository still
retains a reachable `main` ref. The cleanup invariant is not yet fully
restored: a separate linked worktree still has `main` checked out.

This report records the exact remaining blocker accepted by #2832. The
main-bound worktree contains ignored files, and the rescued staged snapshot is
still an unreviewed local branch. Both dispositions require human review and
explicit owner approval before any destructive cleanup. No pre-existing
worktree, branch, or user file was changed.

## Scope and method

The verification was read-only for all pre-existing worktrees. It used the
following checks from the fresh implementation worktree:

```text
git worktree list --porcelain
git remote get-url origin
git rev-parse --git-common-dir
git rev-parse refs/heads/main
git -C <exact-worktree> status --porcelain=v2 --branch --ignored
git -C <exact-worktree> rev-list --left-right --count origin/main...HEAD
git rev-list --left-right --count origin/main...refs/heads/main
git rev-list --left-right --count origin/main...refs/heads/rescue/gitlab-enoent-staged-snapshot
git diff --shortstat origin/main...refs/heads/rescue/gitlab-enoent-staged-snapshot
git ls-remote origin refs/heads/rescue/gitlab-enoent-staged-snapshot
gh pr list --repo kookr-ai/kookr --state all --head rescue/gitlab-enoent-staged-snapshot
```

The repository identity is consistent across the primary checkout, the
main-bound worktree, and the fresh audit worktree:

- Remote: `git@github.com:kookr-ai/kookr.git`
- Shared Git directory: `/home/jean/git/kookr/.git` <!-- portability-ok: exact local path required by #2832 evidence -->
- Fresh audit worktree: `/home/jean/git/kookr-issue-2832-verify-20260825` <!-- portability-ok: exact local path required by #2832 evidence -->
- `origin/main` at capture: `e025958c45bebed7fc5feb678bb5dc4e4c826026`

## Primary checkout

The primary checkout is `/home/jean/git/kookr` <!-- portability-ok: exact local path required by #2832 evidence -->. It is on the named branch `feat-issue-1393-relay-readyz`; its tracked-file status is clean. The local `refs/heads/main` ref resolves to commit `d856e1a5f7d10f869a1c54e9f0628acbb0ec5e19`, remains a commit object, and is an ancestor of `origin/main`.

The primary checkout also has pre-existing untracked files. This verification
did not inspect, remove, or modify them; the relevant invariant is that the
primary checkout is not on `main` and its tracked files were not changed.

## Main-bound worktree

The fresh registry inventory contains this exact non-primary binding:

```text
worktree /home/jean/git/kookr-issue-2682 # portability-ok: exact local path required by #2832 evidence
HEAD d856e1a5f7d10f869a1c54e9f0628acbb0ec5e19
branch refs/heads/main
```

The target is the same repository and has no tracked, staged, or non-ignored
untracked changes:

| Field | Evidence |
| --- | --- |
| Path | `/home/jean/git/kookr-issue-2682` <!-- portability-ok: exact local path required by #2832 evidence --> |
| Branch | `main` |
| HEAD | `d856e1a5f7d10f869a1c54e9f0628acbb0ec5e19` |
| Upstream relation | `0 ahead, 45 behind origin/main` |
| Tracked/staged/non-ignored changes | None |
| Git directory | `/home/jean/git/kookr/.git/worktrees/kookr-issue-2682` <!-- portability-ok: exact local path required by #2832 evidence --> |
| Shared Git directory | `/home/jean/git/kookr/.git` <!-- portability-ok: exact local path required by #2832 evidence --> |
| Ignored entries | `13,213` when enumerated with `--untracked-files=all` |

The top-level ignored-state sample is:

```text
!! .review-state/
!! .tmp/
!! dist/
!! node_modules/
!! tsconfig.e2e.tsbuildinfo
!! tsconfig.tsbuildinfo
!! vendor/
```

The ignored files are not automatically disposable: they may include local
configuration, caches, dependencies, or generated state. The worktree must
therefore remain in place until an owner reviews that disposition and
revalidates the exact path, repository identity, branch, HEAD, and ignored
contents immediately before removal.

## Rescue snapshot

The local rescue ref is
`refs/heads/rescue/gitlab-enoent-staged-snapshot`. It has no worktree binding,
matching remote branch, or GitHub PR.

| Field | Evidence |
| --- | --- |
| Commit | `ad4ebc8e13b80382b853402669a407366f866d42` |
| Parent | `4db70ffb87c9d47edf14e3956f5b854f3fcb704f` |
| Subject | `rescue: snapshot staged state found on hijacked main worktree (2026-07-27)` |
| Ahead/behind `origin/main` | `1 ahead, 921 behind` |
| Matching `origin` branch | None |
| GitHub PR | None |
| Worktree binding | None |
| Diff against `origin/main` | 1,354 files; 24,766 insertions and 235,680 deletions |

The rescue ref remains reachable through the local branch ref and is retained
and protected pending human triage. Deleting it would discard the only local
reference to its unique snapshot.

## Disposition and acceptance status

| Candidate | Disposition | Required next action |
| --- | --- | --- |
| `/home/jean/git/kookr-issue-2682` on `main` <!-- portability-ok: exact local path required by #2832 evidence --> | Blocked pending owner-approved exact-target removal | Review ignored contents and the rescue disposition in #1548; immediately revalidate identity, path, branch, HEAD, primary-worktree status, and ignored files before removing only this path. |
| `rescue/gitlab-enoent-staged-snapshot` | Retain/protect pending human triage | Review or preserve the snapshot before deleting its local branch or any former worktree. |

The #2832 cleanup invariant is therefore **blocked by the explicit human
approval and review required by #2831**, not by an unverified automation
failure. This exact evidence and both dispositions are posted on
[umbrella #1548](https://github.com/kookr-ai/kookr/issues/1548). Once the owner
records approval, #2831 can perform its guarded cleanup and a follow-up run of
this verification can confirm that no worktree binds `main`.
