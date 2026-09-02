# RFC: Make worktree removal identity-safe and single-path

Status: Implemented
Date: 2026-07-16
Author: Codex

## Problem

Kookr now has several useful guardrails around worktree cleanup: a protected
marker, a protected-branch allowlist, primary-worktree detection, linked
worktree registry checks, task-sharing checks, cleanliness checks, and Git's
own `worktree remove` command in the workspace-cleanup surface. These checks
are not yet one coherent removal boundary.

The remaining risk is that different cleanup paths make different decisions
about the same path:

1. Task-terminal cleanup validates a path, then removes it with recursive
   filesystem deletion. It trusts the branch and detached-HEAD fields saved in
   a task session instead of deriving the current identity immediately before
   removal.
2. Reflection cleanup accepts an arbitrary path with an identity file and can
   fall back to recursive deletion. It does not require the path to be a
   direct child of the configured reflection root or verify Git worktree
   ownership before removing a registered worktree.
3. The safety registry check assumes that the first non-bare porcelain entry
   is always a primary checkout. That is false for a bare repository, where a
   `bare` entry is followed only by linked worktrees and there is no primary
   checkout at all. The live repository configuration also exercises the
   separate bare-entry-first ordering case.
4. Git subprocess environment handling is duplicated. Some cleanup subprocesses
   scrub nested `GIT_*` variables, while task and reflection cleanup do not.

The current implementation therefore has good local predicates but no single
invariant that every destructive path must satisfy:

> Kookr may remove only a currently registered, non-primary linked worktree;
> the repository identity, path, HEAD, branch, and protection state must be
> revalidated from Git immediately before the removal command; and all Git
> worktree removal must go through Git rather than recursive filesystem
> deletion.

This RFC narrows the first implementation slice to that invariant. It does not
attempt to solve every possible filesystem race or make Kookr an operating
system-level file deletion authority.

## Empirical evidence

The evidence was collected from the repository at `be3a4f13` (`fix: harden
worktree removal guards (#1406)`) and from the live worktree registry:

- The focused guardrail suite passes (6 files, 90 tests), but the tests mock
  the safety module at several cleanup call sites. There is no real-Git test
  proving that task-terminal cleanup cannot delete the primary checkout.
- `git worktree list --porcelain` for the live repository begins with a
  `bare` entry for the shared repository metadata and then lists linked
  worktrees; it has no primary checkout entry. The old registry and cleanup
  inspector logic could nevertheless designate the first non-bare entry as
  primary, hiding a valid linked worktree from cleanup and reporting it as a
  non-worktree session.
- `src/adapters/git-worktree.ts` performs `rm(worktreePath, { recursive: true,
  force: true })` after its guard and cleanliness checks. This bypasses Git's
  own refusal to remove a primary checkout and leaves registry cleanup to a
  later prune.
- `src/server/use-cases/request-task-reflect.ts` calls `git worktree remove
  --force` without a repository context and falls back to `rm -rf`. Its
  on-demand function accepts only the stored path and checks for the identity
  file, not the configured reflection root.
- `src/adapters/git-worktree.ts` has its own Git runner without the nested
  `GIT_*` environment scrub used by `src/core/git-helpers.ts` and the workspace
  cleanup service.
- The primary-check predicate itself is valuable: it compares the target's
  private Git directory with its common Git directory. The RFC retains this
  defense and adds exact registry membership rather than replacing it.

## Requirements

### Safety requirements

1. Every operation that removes a Git worktree directory SHALL use one shared
   removal primitive. There SHALL be no raw recursive-delete fallback for a
   path that Git recognizes as a worktree. A separate, explicitly root-scoped
   legacy reflection-directory cleanup may use filesystem deletion only after
   proving that the target is not a Git worktree.
2. The shared primitive SHALL fail closed unless the target is an exact,
   currently registered, non-bare worktree entry.
3. The shared primitive SHALL reject the primary working tree even when the
   caller supplies a stale or protected branch value.
4. Branch, detached state, and HEAD used for the final decision SHALL be
   derived from the current Git registry/target, not trusted solely from a
   persisted task or client record.
5. Protected branches SHALL remain protected by default. An explicit
   protected-branch confirmation may authorize the existing user-facing
   cleanup flow, but it SHALL not authorize primary or unregistered paths.
6. Git subprocesses involved in the guard and removal path SHALL run with
   inherited nested `GIT_*` context removed so a parent Git hook cannot redirect
   a command to another repository.
7. Reflection cleanup SHALL require the target to be a direct child of the
   configured reflection-worktree root and carry a valid identity marker. A
   configured-root mismatch SHALL fail closed. The root and target SHALL be
   canonicalized, and symlinked target directories SHALL not qualify for the
   legacy filesystem-delete exception.
8. A Git removal failure SHALL leave the directory in place and return/log a
   cleanup failure. It SHALL NOT be converted into recursive deletion.
9. Kookr removal attempts SHALL be serialized per canonical Git common
   directory within the Kookr process. This is a concurrency guard for Kookr's
   own cleanup paths, not a claim to provide a cross-process filesystem lock.
   Callers SHALL continue to enforce their existing task/lease/session checks.

### Compatibility requirements

10. Automatic task cleanup SHALL keep its current policy decisions: shared,
   dirty, detached, unique-commit/non-patch-equivalent, protected-marker, and
   reopened-task checks still
   skip removal. Patch-equivalent branches may pass only the shared
   squash-aware merge-status check and its identity guards; this is not a
   broad policy relaxation. The change is the final removal mechanism and
   identity source.
11. Workspace cleanup SHALL retain its existing review, dirty-state, recovery,
    branch-ref compare-and-delete, and attempt-ledger behavior.
12. Reflection startup cleanup SHALL continue to recognize existing valid
    identity markers and the documented legacy UUID-directory format, while
    applying root containment and Git ownership checks before removal.
13. Existing callers that cannot establish the repository/root context SHALL
    fail closed rather than infer it from the target path.

### Observability requirements

14. Guard failures SHALL preserve a stable reason (`primary-working-tree`,
    `not-a-linked-worktree`, `protected-branch`, `repository-context-unavailable`,
    `repository-context-mismatch`, `worktree-identity-changed`, or
    `git-remove-failed`) in the existing interaction/attempt logs where a log
    exists.
15. The removal primitive SHALL expose enough result data for callers to
    distinguish “path was removed” from “Git cleanup failed” and avoid marking
    a session as cleaned up prematurely.
16. Task-level sharing checks SHALL compare canonical paths, so a trailing
    separator, equivalent relative path, or symlink alias cannot hide another
    active task's use of the same worktree.

## Design

### 1. One Git worktree identity inspection

Extend the adapter safety boundary with an inspection result containing:

```ts
type WorktreeRemovalTarget = {
  worktreePath: string;
  commonDir: string;
  gitDir: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: false;
};

type WorktreeRemovalFailureReason =
  | 'primary-working-tree'
  | 'not-a-linked-worktree'
  | 'protected-branch'
  | 'repository-context-unavailable'
  | 'repository-context-mismatch'
  | 'worktree-identity-changed'
  | 'git-remove-failed';
```

The inspector will:

1. Resolve the target's Git common directory with a sanitized Git subprocess.
2. If the caller supplies `repoPath`, resolve its common directory too and
   require it to be the same canonical common directory as the target. The
   caller-supplied path is an expected-repository assertion, not an authority
   that can redirect inspection to another repository.
3. Run `git worktree list --porcelain` against the target's validated common
   directory.
4. Parse all entries, including `bare` entries without a `HEAD` line.
5. Match the canonical target path exactly against a non-bare entry.
6. Reject the target when its private Git directory equals its common Git
   directory, regardless of entry order or caller-supplied branch metadata.
7. Use the matching entry's current `HEAD`, branch, and detached state for
   protection and downstream branch cleanup decisions.
8. Capture the target's private Git administrative directory (`gitDir`) in
   the inspection result. A caller that has an earlier target snapshot may
   pass it as `expectedGitDir`, so a path replacement with another linked
   worktree fails even when the branch happens to be unchanged.

The existing `getWorktreeRemovalGuardReason` API remains as a compatibility
wrapper over this inspector. Its `branch` option is retained for callers that
log request metadata, but it is no longer authoritative for the protection
decision.

The parser used by `WorktreeRegistry` and the cleanup inspector will share the
same ordering rule: a normal repository may identify its non-bare primary by
Git identity, but a registry containing a `bare` entry has no primary checkout.
Bare entries are metadata only: they are never removal targets, never marked as
the primary checkout, and never added as dashboard file-view roots.

### 2. One Git removal primitive

Add a function at the adapter boundary with this shape:

```ts
removeRegisteredWorktree(
  worktreePath: string,
  options?: {
    repoPath?: string;
    force?: boolean;
    confirmProtectedBranch?: boolean;
    expectedHead?: string;
    expectedBranch?: string;
    expectedDetached?: boolean;
    expectedGitDir?: string;
  },
): Promise<{
  removed: boolean;
  reason?: WorktreeRemovalFailureReason;
  target?: WorktreeRemovalTarget;
  stderr?: string;
}>;
```

The function performs a fresh identity inspection and then invokes:

```text
git -C <validated-repository-context> worktree remove [--force] -- <validated-path>
```

The command is deliberately repository-scoped and uses an absolute validated
path. The final Git command is itself a second backstop: Git refuses removal
of the primary checkout even if a concurrent process changes the registry
between inspection and invocation.

`force` is not a safety bypass. It is permitted only after the same identity
and protection checks pass, for existing automatic reflection cleanup and the
existing task cleanup behavior that intentionally discards ignored build
outputs. No caller may use `force` to bypass primary, registry, root, or
protected-branch checks. If an expected HEAD, branch, or detached state is
provided, the primitive compares it with the current target and returns
`worktree-identity-changed` before invoking Git. This is a staleness check, not
a filesystem lock; Git's command-level identity check remains the final
backstop.

The primitive takes an in-process async mutex keyed by `commonDir` around the
fresh inspection and removal command. This prevents Kookr's task cleanup,
workspace UI cleanup, and reflection cleanup from interleaving their own
validation/command pairs. It does not pretend to coordinate a separately
running Kookr process or a human invoking Git; for those cases the expected
identity checks and Git's command-level refusal are the remaining defenses.

### 3. Task-terminal cleanup

Update `cleanupTaskWorktrees` to:

- derive the actual target from the shared inspection result;
- keep the existing shared/clean/reopened checks;
- use the validated target branch and HEAD for logging and branch deletion;
- call `removeRegisteredWorktree` instead of `rm`, passing the inspected HEAD,
  branch, and detached state as expected identity;
- mark session worktree health as `cleaned_up` only after Git reports success;
- prune and delete the branch only after removal, preserving `branch -d` when
  it succeeds and using the validated squash-aware classification plus an
  OID-checked compare-and-delete fallback when raw ancestry rejects it;
- treat any removal failure as `worktree_cleanup_failed` and leave the path
  intact.

The task's persisted `gitBranch` and `gitIsDetached` fields remain useful as
diagnostic hints and for pre-removal cleanliness checks, but a mismatch with
the current Git target will cause a skip/failure rather than silently deleting
the newly repurposed path.

Task-terminal cleanup also passes the session's last observed commit as an
expected HEAD (Git's persisted session value is a short SHA prefix), alongside
the persisted branch/detached hints. The primitive accepts a full SHA or a
prefix of at least seven characters. A reused path whose branch happens to be
the same but whose commit changed therefore fails with
`worktree-identity-changed`; callers that have no persisted commit still retain
the current registry/primary/protection checks and fail closed on any Git
inspection failure.

The existing task sharing predicate will use the same canonical path comparison
as the Git safety inspector. It remains a task-store policy check rather than
being folded into the adapter primitive, because the adapter cannot know which
Kookr tasks own a path.

### 4. Workspace cleanup

Replace the direct `git worktree remove` call with the shared primitive while
keeping its existing candidate revalidation and attempt ledger. The primitive
will receive `repoPath`, the candidate's current protected-branch confirmation,
and `force: discardDirtyState` only for the already-reviewed dirty cleanup
case. The existing fingerprint and branch-ref compare-and-delete checks remain
unchanged.

The implementation will add a final identity revalidation immediately before
the destructive command. This closes the current gap where preflight and
candidate inspection are separated from removal by recovery-stash and policy
work.

### 5. Reflection cleanup

The configured reflection root becomes a required safety input for cleanup:

- canonicalize root and target;
- require the target to be an immediate child of the root, not the root itself
  and not a nested path;
- require a valid identity file for on-demand removal;
- for registered Git worktrees, call `removeRegisteredWorktree` with the
  target-derived repository context and never fall back to filesystem
  deletion;
- retain a narrowly scoped filesystem deletion only for non-Git legacy
  reflection directories that have a valid identity marker (or the documented
  legacy UUID basename when running the startup sweep), pass the direct-child/
  root check, and are not symlinked directories;
- if Git removal fails, leave the path for the next sweep and report failure.

Creation/launch-failure cleanup will use the same root-scoped helper. If an
identity write fails, the newly created Git worktree will be removed through
the Git primitive or left for operator-visible recovery; it will not be
recursively deleted without Git identity validation.

### 6. Git subprocess environment

Promote the nested Git environment scrub to a shared helper used by all
worktree guard/removal subprocesses. At minimum it removes:

```text
GIT_ALTERNATE_OBJECT_DIRECTORIES
GIT_CEILING_DIRECTORIES
GIT_COMMON_DIR
GIT_CONFIG_COUNT
GIT_CONFIG_PARAMETERS
GIT_DIR
GIT_INDEX_FILE
GIT_OBJECT_DIRECTORY
GIT_PREFIX
GIT_WORK_TREE
```

The helper remains an environment-only change; it does not alter user Git
configuration or hooks.

### 7. Test strategy

Add real-Git tests for the shared boundary, not only consumer mocks:

- primary checkout is blocked even when it has a clean tree, marker, or
  protected branch;
- exact linked worktree is accepted and removed through Git;
- bare-first porcelain ordering does not reject a valid linked worktree;
- forged `.git`/identity paths and unregistered directories are rejected;
- a current branch differs from stale caller metadata and the current branch
  wins for protection/logging;
- canonical path aliases still trigger the existing shared-task/active-lease
  checks;
- Git failure leaves the target directory and does not invoke `rm`;
- reflection cleanup rejects paths outside the configured root, the root
  itself, and nested paths;
- reflection cleanup removes a registered target only through Git and retains
  the legacy non-Git marker case;
- inherited nested Git environment variables cannot redirect the inspection;
- task-terminal cleanup cannot remove the primary worktree in an integration
  fixture.

Retain the existing focused suite and workspace cleanup tests. Add one
integration fixture that uses a repository with a bare entry first, matching
the live failure mode rather than relying only on hand-written porcelain.

## Files to change

| Path | Change |
| --- | --- |
| `src/adapters/worktree-safety.ts` | Shared identity parser/inspection/removal primitive; exact registry membership; current branch/HEAD derivation; stable failure reasons. |
| `src/core/git-helpers.ts` | Shared nested-Git environment sanitizer, if needed by the adapter boundary. |
| `src/adapters/git-worktree.ts` | Replace recursive deletion with the shared primitive and use current identity. |
| `src/server/use-cases/workspace-cleanup-service.ts` | Route removal through the primitive and perform final identity validation. |
| `src/server/use-cases/request-task-reflect.ts` | Enforce root containment/identity and route Git cleanup through the primitive. |
| `src/server/agent-lifecycle.ts` / `src/server/index.ts` | Pass the configured reflection root into terminal cleanup. |
| `src/adapters/git-worktree-registry.ts` | Correct bare-entry parsing and primary classification. |
| `src/adapters/git-info.ts` / `src/core/session-read-model.ts` | Preserve linked-worktree private Git-directory identity and keep bare entries out of worktree status. |
| `src/server/reconciliation.ts` | Refresh persisted session identity when the private Git directory changes. |
| `src/server/use-cases/cleanup-inspector.ts` | Keep primary selection identity/order-safe and reuse parsed entry semantics. |
| `src/server/routes/file-routes.ts` | Exclude bare Git common directories from file-view roots. |
| `src/adapters/worktree-safety.test.ts` (new) | Real-Git safety and removal contract tests. |
| Existing worktree/cleanup/reflect tests | Regression coverage for each caller and failure mode. |
| `docs/requirements.md` / `docs/user-guide.md` | Keep the requirement evidence and user-facing behavior aligned with the single removal boundary. |

The installed global Claude hook is currently an operational concern outside
this repository's source tree and points at an older product path. It should
be repaired separately; this RFC does not silently edit user-level hook files.

## Edge cases and failure behavior

- **Bare repository or bare-first registry:** bare entries are parsed but never
  considered removable targets, the primary checkout, or file-view roots; a
  bare repository with only linked worktrees has no primary checkout.
- **Primary checkout with a `.kookr-protected` marker:** the identity reason is
  still `primary-working-tree`; confirmation cannot override it.
- **Detached linked worktree:** task automatic cleanup keeps the current
  conservative skip; workspace UI classification remains authoritative.
- **Branch renamed/repointed after task launch:** the current registry branch
  wins. If it is protected, cleanup stops; if it no longer matches the task's
  expected identity, the operation records a mismatch and does not delete the
  branch.
- **Target disappears before removal:** Git failure is reported; no raw delete
  or guessed repository prune is attempted.
- **Target becomes dirty after inspection:** non-force Git removal fails and
  leaves it in place. Force callers still pass only the identity/protection
  gate and are limited to the existing reviewed/automatic policies.
- **Active task/session or lease:** the shared primitive does not infer
  liveness. Task cleanup keeps its task-store sharing check, workspace cleanup
  keeps its lease check, and reflection terminal cleanup runs after the managed
  session is stopped. A caller that cannot establish its existing liveness
  precondition must skip before invoking the primitive.
- **Reflection root is missing:** cleanup is a no-op/failure, not a guessed
  parent directory. Startup sweep keeps the existing missing-root behavior.
- **Legacy reflection directory without a Git registration:** the startup
  sweep may remove it only when it is a direct child of the configured root and
  carries the documented legacy UUID basename; on-demand deletion requires the
  current identity marker. A Git-looking or symlinked path is never sent to
  the filesystem-delete exception.
- **Concurrent cleanup:** Git's worktree registry and command-level refusal
  remain the final backstop. A second cleanup observes missing/unregistered or
  Git failure and does not recursively delete anything.
- **Nested Git environment from a hook:** all safety/removal subprocesses use
  the sanitized environment and explicit `-C` context.
- **Symlinked marker or target:** marker authorization requires a regular
  marker file; a symlinked target is never eligible for the legacy plain-dir
  deletion exception.

## Alternatives considered

### Keep adding predicates at each call site

Rejected. This is the current shape and is why task, workspace, and reflection
cleanup have drifted. A shared primitive makes the destructive operation and
its evidence contract reviewable in one place.

### Keep `rm -rf` after a successful guard

Rejected. A guard followed by a separate filesystem deletion loses Git's
identity backstop and makes registry state depend on a later prune. Git's
`worktree remove` is the correct primitive for Git-owned directories.

### Trust the persisted task branch and detached flags

Rejected. They are snapshots, not ownership proof. A path can be repurposed,
renamed, or attached to a different branch after the task record is written.

### Delete every path under the reflection root

Rejected. Root containment is necessary but not sufficient; the identity marker
and, for Git worktrees, current registry membership are still required.

### Add an OS-level lock or filesystem watcher first

Deferred. Locks and watchers can reduce races but do not fix the existing
identity and raw-delete gaps. They can be added after this invariant is
implemented and measured.

## Rollout and follow-ups

This ships as a behavior-preserving safety fix. Cleanup becomes more
conservative when repository context or current identity cannot be established;
the path remains available for manual recovery.

Follow-ups:

1. Add a startup diagnostic for repositories whose Git config reports a bare
   entry before the primary checkout or whose worktree metadata is stale.
2. Repair and test the user-level production-readonly hook installation.
3. Consider a cross-process cleanup lock after measuring concurrent cleanup
   conflicts; this RFC provides only an in-process mutex.
4. Add an operator repair command for stale Git worktree registrations rather
   than broadening automatic deletion.

## Revision notes

Round 1 triage: the first parallel reviewer panel timed out without returning
reports. The draft was therefore tightened against the observed code and live
registry before a second bounded review attempt: repository context is now an
assertion, stale identity has an explicit failure reason, and the legacy
filesystem exception is narrowly separated from Git worktree removal. One
bounded safety review then identified the remaining lifecycle concern: the
RFC now requires an in-process common-directory mutex, captures private Git
administrative identity, and states the existing caller-owned liveness checks
explicitly; cross-process TOCTOU remains a documented limit rather than an
unverifiable promise.

Round 2 triage: the second parallel panel timed out without returning reports.
The concrete local correction is that task ownership checks must canonicalize
paths using the same identity as the Git guard, and the test plan now proves
that aliasing cannot bypass the shared-task check.

Round 3 triage: the final parallel panel also timed out without reports. The
RFC was frozen after a local implementation-readiness check: the failure union
is explicit, the primitive's expected-identity inputs are testable, and the
delivery checklist below is the acceptance gate for the implementation.

Implementation acceptance checklist:

- no `rm(..., { recursive: true })` remains on a registered Git worktree path;
- the live bare-first registry fixture passes;
- task, workspace, and reflection cleanup all exercise the shared primitive;
- real-Git tests cover primary, linked, stale identity, root containment,
  environment scrubbing, failure preservation, and canonical ownership;
- focused tests, TypeScript build, and the repository verification script pass.

Implementation result: all checklist items are covered by the shared adapter
primitive, its real-Git test fixture, the task/workspace/reflection callers, and
the focused regression suites. The repository verification command remains a
delivery-stage check and is recorded with the pull request result.
