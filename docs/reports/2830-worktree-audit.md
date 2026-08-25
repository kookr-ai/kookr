# Worktree audit for #2830

Captured at `2026-08-25T01:52:37Z` after `git fetch origin main`.

## Scope and method

This audit classifies the exact worktree currently binding `main` and the
local `rescue/gitlab-enoent-staged-snapshot` candidate. It is read-only with
respect to every pre-existing worktree. The audit used:

```text
git worktree list --porcelain
git remote get-url origin
git -C <exact-worktree> status --porcelain=v2 --branch --ignored
git -C <exact-worktree> diff --stat
git -C <exact-worktree> diff --cached --stat
git -C <exact-worktree> rev-list --left-right --count origin/main...HEAD
git rev-list --left-right --count origin/main...refs/heads/rescue/gitlab-enoent-staged-snapshot
git ls-remote origin refs/heads/rescue/gitlab-enoent-staged-snapshot
gh pr list --repo kookr-ai/kookr --state all --head rescue/gitlab-enoent-staged-snapshot
```

Repository identity:

- Fetch remote: `git@github.com:kookr-ai/kookr.git`
- Push remote: `https://github.com/kookr-ai/kookr.git`
- Shared Git directory: `/home/jean/git/kookr/.git` <!-- portability-ok: exact local path required by #2830 evidence -->
- Fresh audit worktree: `/home/jean/git/kookr-feat-issue-2830-audit-worktrees` <!-- portability-ok: exact local path required by #2830 evidence -->
- `origin/main` at capture: `9c73f89f79676511a53433edbba905b7cf90e376`

The fresh `git worktree list --porcelain` inventory contains this exact
`main` binding:

```text
worktree /home/jean/git/kookr-issue-2682 # portability-ok: exact local path required by #2830 evidence
HEAD d856e1a5f7d10f869a1c54e9f0628acbb0ec5e19
branch refs/heads/main
```

No worktree record binds `refs/heads/rescue/gitlab-enoent-staged-snapshot`.

## Candidate 1: exact `main` binding

Path: `/home/jean/git/kookr-issue-2682` <!-- portability-ok: exact local path required by #2830 evidence -->

| Field | Evidence |
| --- | --- |
| HEAD | `d856e1a5f7d10f869a1c54e9f0628acbb0ec5e19` |
| Branch | `main` |
| Upstream | `origin/main` |
| Ahead/behind | `0 ahead, 44 behind` |
| Tracked changes | None |
| Staged changes | None |
| Status | `## main...origin/main [behind 44]` |
| Git directory | `/home/jean/git/kookr/.git/worktrees/kookr-issue-2682` <!-- portability-ok: exact local path required by #2830 evidence --> |
| Common directory | `/home/jean/git/kookr/.git` <!-- portability-ok: exact local path required by #2830 evidence --> |

Ignored-file evidence (`git status --ignored`):

```text
!! .review-state/
!! .tmp/
!! dist/
!! node_modules/
!! tsconfig.e2e.tsbuildinfo
!! tsconfig.tsbuildinfo
!! vendor/
```

The entries are ignored by the repository rules for review state, temporary
files, build output, dependencies, TypeScript build info, and vendored files.
They were not deleted or modified by this audit.

## Candidate 2: rescue snapshot

Ref: `refs/heads/rescue/gitlab-enoent-staged-snapshot`

| Field | Evidence |
| --- | --- |
| Commit | `ad4ebc8e13b80382b853402669a407366f866d42` |
| Parent | `4db70ffb87c9d47edf14e3956f5b854f3fcb704f` |
| Subject | `rescue: snapshot staged state found on hijacked main worktree (2026-07-27)` |
| Local reachability | Ref resolves to a commit in the shared object database |
| Ahead/behind `origin/main` | `1 ahead, 920 behind` |
| Matching `origin` branch | None (`git ls-remote` returned no matching ref) |
| GitHub PR | None |
| Worktree binding | None |
| Diff against `origin/main` | 1,354 files: 31 added, 831 deleted, 492 modified/renamed; 24,766 insertions and 235,680 deletions |

Because the rescue ref has no worktree binding, staged, dirty, and ignored-file
state is not applicable to the candidate itself. The commit contents remain
reachable through the local branch ref; the branch must be retained while its
contents are triaged. No branch deletion, force operation, or worktree removal
was performed.

## Disposition

| Candidate | Disposition | Rationale |
| --- | --- | --- |
| `/home/jean/git/kookr-issue-2682` on `main` <!-- portability-ok: exact local path required by #2830 evidence --> | Blocked pending owner-approved exact-target removal | Tracked state is clean, but ignored state exists and the worktree is the live binding of `main`. Revalidate path, branch, HEAD, and ignored files immediately before any owner-approved removal. |
| `rescue/gitlab-enoent-staged-snapshot` | Retain/protect pending human triage | The local rescue commit is reachable, with no matching `origin` branch or GitHub PR found by the exact checks above, and diverges from `origin/main` across 1,354 files. Do not delete the branch or its former worktree until its contents are reviewed or preserved elsewhere. |

This audit performed no cleanup and did not modify tracked or untracked user
files in any pre-existing worktree. The required fetch updated shared Git
metadata only (including `FETCH_HEAD` and the `origin/main` remote-tracking
ref), and the report was written in the fresh implementation worktree. The
evidence and dispositions are posted on
[umbrella #1548](https://github.com/kookr-ai/kookr/issues/1548).
