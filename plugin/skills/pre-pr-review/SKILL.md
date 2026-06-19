---
name: pre-pr-review
description: Self-review checklist before creating a PR — repo checks, diff review, reviewer specialists, and gate state creation before gh pr create.
keywords: review, self-review, pre-PR, checklist, before PR, quality, validation, before merge, before submit
related: pre-push, pr-lifecycle, git-commit-discipline, testing-patterns, pr-review-triage
---

# Pre-PR Review

> **Requires:** the four reviewer specialists at `plugin/reviewer-specialists/` (bundled with the `kookr-toolkit` plugin since 0.5 — see `docs/hooks-setup.md`). If the directory is missing (e.g. plugin not installed), stop and report the missing dependency rather than fabricating review output. The repo-level checks (build, tsc, tests) below still run.

Run this checklist before creating a pull request. When Kookr is installed via `scripts/install-hooks.sh`, the `pr-workflow-gate` hook enforces this skill before every `gh pr create` in *any* repo on your machine.

## When to Use

- Before every `gh pr create`
- After finishing implementation, before declaring the task complete

## Checklist

### 1. Detect Project Type

Detect the project's build system from the working directory. Pick the first row whose condition is true:

| Detected                                                          | Build command                                                              | Test command   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------- |
| **pnpm** (`pnpm-lock.yaml`)                                       | prefer `pnpm build`; else `pnpm tsc --noEmit` if `tsconfig.json` present   | `pnpm test`    |
| **npm** (`package-lock.json`)                                     | prefer `npm run build`; else `npx tsc --noEmit` if `tsconfig.json` present | `npm test`     |
| **yarn** (`yarn.lock`)                                            | prefer `yarn build`; else `yarn tsc --noEmit` if `tsconfig.json` present   | `yarn test`    |
| **Rust** (`Cargo.toml`)                                           | `cargo check`                                                              | `cargo test`   |
| **Python** (`pyproject.toml`)                                     | run configured typecheck (mypy / pyright) if any                           | `pytest` or `python -m pytest` if configured |
| **Other / unknown**                                               | skip step 2                                                                | skip step 3    |

"prefer X; else Y" means: run `X` only if the corresponding package-manifest script exists (check `package.json`'s `scripts` map); otherwise fall back to `Y`. If neither exists, skip the step and note "no build step detected" in the output contract.

Diff review (step 4) and commit hygiene (step 5) are **always** required regardless of project type.

### 2. Type Safety / Build

Run the build command from the detected row. Must be clean. No `any` casts introduced unless justified. No `@ts-ignore` added. For Rust, no new `#[allow(...)]` without a comment explaining why.

If the project is "Other / unknown", skip this step and state so in the output contract.

### 3. Tests

Run the test command from the detected row. Must be green. New functionality should have tests. Modified behavior should have updated tests.

If the project has no test script / test suite, skip this step and state so in the output contract.

### 3b. Bug Fix Reproduction (required for `fix:` PRs)

If the PR is a bug fix, **reproduce the buggy behavior and verify the fix eliminates it** before proceeding. Unit tests passing is necessary but not sufficient — the old code path must be shown to fail and the new code path must be shown to work.

Concretely:
1. **Reproduce the bug** — write a script, REPL snippet, or test that demonstrates the broken behavior on the old code (or explains why the test alone covers it if the bug is purely logic).
2. **Verify the fix** — run the same reproduction with the new code and confirm the correct behavior.
3. **Verify no regression** — confirm the happy path still works.

This step catches fixes that pass tests but don't actually address the reported issue (partial fixes, wrong assumptions about the failure mode, tests that don't exercise the real code path).

4. **Document in the PR description** — add a "Verification" section showing the before/after behavior (old code output vs. new code output). Reviewers appreciate seeing concrete evidence that the fix works, not just "tests pass."

Skip this step only for trivial fixes where the unit test IS the reproduction (e.g., a typo in a string constant).

### 4. Diff Review

```bash
git diff --stat          # overview of changed files
git diff --cached        # staged changes in detail
git diff                 # unstaged changes
```

Check for:
- **Accidental files** — build artifacts, `.env`, `node_modules`, lock files you didn't intend to change
- **Debug leftovers** — `console.log`, `debugger`, `TODO` comments that should be resolved
- **Secrets** — API keys, tokens, passwords, connection strings in the diff
- **Unrelated changes** — formatting-only changes, unrelated refactors mixed in

### 4b. Portability Check

Scan **changed lines only** (not the full repo) for user-specific absolute paths in scripts, docs, skills, agent definitions, and PR-template content. Replace with portable equivalents where practical.

```bash
scripts/check-portability.sh        # defaults to base ref origin/main
scripts/check-portability.sh main   # explicit base ref
```

The helper exits 0 when clean and 1 when added lines contain matches. It looks at added diff lines so existing intentional references elsewhere in the repo do not produce noise.

Patterns flagged:

- `/home/<user>/...` (Linux home directories)
- `/Users/<user>/...` (macOS home directories)
- `C:\Users\<user>\...` (Windows home directories)
- Other machine-local install/cache paths in reusable scripts, docs, skills, and templates

Replace with one of:

- `$HOME` or `~`
- Repo-root-relative paths (e.g. `scripts/<name>.sh`, `.claude/skills/<skill>/SKILL.md`)
- Documented env vars (e.g. `CODEX_SRC`, `CODEX_INSTALL_DIR`, ...)
- Placeholders (`/path/to/repo`, `<USER>`) in examples

Allowed without conversion:

- Explicitly documented canonical paths for Kookr's own production/dev machine (the canonical prod-worktree path documented in CLAUDE.md)
- Test fixtures that intentionally exercise path parsing
- Examples that already use `$HOME`, env vars, or placeholders

If a flagged line is intentional, either append a `portability-ok` marker comment on the same line so the helper skips it, or justify it in the PR description.

For projects other than Kookr that do not ship the helper, do this step as a manual diff scan for the same patterns.

### 4c. Cross-Platform (macOS) Compatibility

Code that works on Debian/Linux can silently break on macOS, which ships **bash 3.2** (frozen at GPLv2) and **BSD** variants of `sed`/`grep`/`stat`/`date`/`readlink`. Most onboarding and runtime bugs on macOS trace to this.

Run the deterministic linter on changed lines:

```bash
scripts/check-shell-portability.sh        # defaults to base ref origin/main
```

It flags the statically-detectable class. Use the catalog below for manual review of anything it can't see (heredocs, runtime behavior):

**GNU-only coreutils flags → use the portable form:**

- `grep -P` / `-oP` → POSIX ERE (`grep -E`) or `perl`/`awk` (BSD grep has no PCRE)
- `sed -i 's/…'` → `sed -i.bak 's/…' && rm file.bak` (BSD `sed -i` requires an explicit suffix; the no-backup form is the two-arg `sed -i '' …`)
- `sed -r` → `sed -E`
- `readlink -f` → a portable realpath helper / `python`/`perl` (older macOS `readlink` lacks `-f`)
- `stat -c` → gate on `uname` (BSD `stat` uses `-f`)
- `date -d` → gate on `uname` (BSD `date` uses `-v` / `-j -f`)
- `find -printf`, `xargs -r` → GNU-only; restructure

**bash 4+ syntax (macOS system bash is 3.2):**

- `mapfile` / `readarray` → `while read` loop
- `${var,,}` / `${var^^}` case conversion → `tr`
- `declare -A` / `local -A` associative arrays → not available
- `echo -n` / `echo -e` → `printf` (literal under POSIX `/bin/sh`)

**Runtime-only traps the linter CANNOT catch — review by hand, and rely on the macOS CI job to actually exercise them:**

- **`set -u` + empty array:** `"${arr[@]}"` raises "unbound variable" on bash 3.2 when `arr` is empty. Use `"${arr[@]+"${arr[@]}"}"`.
- **Heredoc inside `$(...)`:** bash 3.2 cannot parse a heredoc nested in command substitution when the body contains a backtick. Move the program to a sibling file and invoke it by path.
- **No `/proc`:** resolve pids/process trees via `ps`, not `/proc`, when `/proc` is absent.
- **`/var` → `/private/var` symlink:** `mktemp` paths differ from `git rev-parse` / `realpath` output; resolve both sides with `realpath`/`pwd -P` before comparing.
- **pnpm drops the exec bit** on native binaries (e.g. node-pty's `spawn-helper`); restore `+x` in a `prepare` step.
- **Unix socket `sun_path` ≤ 103 bytes:** macOS `os.tmpdir()` is long; use a short `/tmp` base for socket paths.

When in doubt, spawn the `macos-compat-reviewer` subagent on the diff, and label the PR `macos` so the macOS CI job runs.

### 5. Commit Hygiene

- Commits follow Conventional Commits format (`feat:`, `fix:`, `chore:`, `docs:`, `test:`)
- Each commit is atomic — one logical change per commit
- No commits with messages like "wip", "fix", "temp"

### 6. PR Scope

Ask: **"Does every change in this diff directly serve the PR's stated goal?"**

If you find unrelated improvements, either:
- Remove them from the PR (stash for a separate PR)
- Or justify them in the PR description

### 7. Architecture Sanity

For non-trivial changes, quick-check:
- Does the change follow existing patterns in the codebase?
- Are imports going in the right direction (no circular deps, no core importing from adapters)?
- Are new files in the right directory?

### 8. Subagent Review

Run specialized reviewer subagents in parallel against the diff. **Skip for trivial changes** (typo fixes, comment updates, single-line config changes).

**Two reviewer layers are available:**

#### Layer 1: Reviewer Specialists (`plugin/reviewer-specialists/`)
Narrow prompt templates for PR-level review. Use for all non-trivial PRs:
- **conventions-specialist** — style, naming, imports, code organization
- **correctness-specialist** — logic bugs, edge cases, data flow, security
- **deadcode-specialist** — unused code introduced or orphaned by the PR
- **test-specialist** — test quality, tautologies, missing coverage
- **a11y-specialist** — ARIA validity, accessible names, keyboard semantics (UI-component diffs only)

Each specialist expects:
- `{repoDir}` — path to the full repo checkout (the worktree)
- PR context: `git diff main..HEAD` output and list of changed files

#### Layer 2: Architecture Agents (kookr-toolkit plugin agents)

> **Invocation note:** Agent names below appear unqualified for readability. When calling `Agent({ subagent_type: "..." })`, prepend `kookr-toolkit:` (e.g., `kookr-toolkit:dependency-graph-analyzer`). Unqualified `subagent_type` does not resolve for plugin-namespaced agents.

Use when the change touches module boundaries, imports, or public APIs:
- **dependency-graph-analyzer** — import graph, circular deps, layering violations
- **module-interface-auditor** — public API clarity, leaky abstractions
- **architecture-drift-detector** — doc/code divergence

**Selection guide:**

| Change type | Which reviewers |
|---|---|
| Any non-trivial code change | conventions / correctness / deadcode / test specialists (Layer 1) |
| UI-component change (`.tsx` / `.jsx` / `.vue` / `.svelte` touching `aria-*`, `role=`, semantic HTML, or spreading props onto HTML elements) | + a11y-specialist |
| Module boundary / import refactor | + dependency-graph-analyzer, module-interface-auditor |
| New public API / API changes | + api-surface-auditor, module-interface-auditor |
| State / workflow logic | + state-machine-verifier, failure-mode-analyst |

**How to run:**
1. Prepare context: `git diff main..HEAD` and `git diff main..HEAD --stat`
2. Launch selected agents **in parallel** as subagents, passing the diff and repo path.
   For the test-focused reviewer, explicitly ask whether the changed runtime path is tested directly or only inferred through helper/unit coverage.

   **Claude Code:** spawn each Layer-1 specialist via the `Agent` tool, reading the specialist's `.md` file from `plugin/reviewer-specialists/` as the prompt body:
   ```
   Agent({ subagent_type: "general-purpose", prompt: "<contents of plugin/reviewer-specialists/correctness-specialist.md, with {repoDir} and the diff inlined>" })
   ```
   For Layer-2 architecture agents use `Agent({ subagent_type: "kookr-toolkit:<name>" })`.

   **Codex CLI:** spawn each Layer-1 specialist via the `spawn_agent` tool with the specialist's `.md` content as the task instructions. This is an *authorized skill-workflow spawn* under clause (b) of the `spawn_agent` tool description — you do NOT need the user to re-confirm. Pattern:
   ```
   spawn_agent({
     task_name: "review_correctness",
     instructions: "<contents of plugin/reviewer-specialists/correctness-specialist.md, with {repoDir} and the diff inlined>"
   })
   ```
   Then `wait_agent` on all spawned ids. Do NOT fall back to forging a `.review-state/<branch>.json` marker via shell — that bypasses the review the gate exists to enforce. Layer-2 architecture agents on Codex follow the same `spawn_agent` pattern, naming the role in `task_name`.
3. Collect findings — fix any **blocking** issues before proceeding.
4. Note informational findings in the PR description if relevant.

### 9. OSS base-branch policy check (external upstream PRs only)

If this PR targets an **external upstream** (i.e. `gh pr create -R <other>/<repo>`
against a fork you own), verify the `--base` argument matches the recon's
declared policy. This catches cases where upstream added a guard workflow that
rejects fork→main PRs (real incident: `berriai/litellm` added `Guard main branch`
mid-April 2026).

```bash
# Variables you already know at this point:
#   REPO      = {owner}/{repo} (the upstream, not the fork)
#   BASE      = the --base argument you will pass to gh pr create
#
SLUG=$(echo "${REPO}" | tr '/' '-' | tr '.' '-')
RECON="${HOME}/.claude/${SLUG}-recon/recon-report.md"
if [ -f "${RECON}" ]; then
  # Strict grammar: "- external_pr_base: <branch>" (one space after dash, one after colon)
  RULE=$(grep -oP '^- external_pr_base: \K\S+' "${RECON}" || true)
  if [ -n "${RULE}" ] && [ "${RULE}" != "${BASE}" ]; then
    echo "ERROR: recon says external_pr_base=${RULE} but PR targets ${BASE}."
    echo "Either retarget (git rebase --onto upstream/${RULE} upstream/${BASE} \${BRANCH}"
    echo "+ gh api repos/${REPO}/pulls/N -X PATCH -f base=${RULE}) or update the recon"
    echo "if the upstream policy has genuinely changed."
    exit 1
  fi
fi
```

If the recon has no `## Policies` section or no `external_pr_base:` line, skip
silently — absence means "no declared policy for this repo." Do not invent a rule.

For non-OSS PRs (internal to Kookr or any repo where `-R` is not used), skip
this step entirely — the check only applies when pushing from a fork to an
upstream that declares a base-branch rule.

## Create Gate State File

**After ALL mandatory checks above pass**, create the state file that allows `gh pr create` through the hook gate. The key must match the hook's derivation, which prefers `-R owner/repo` / `--head` parsed from the command and only falls back to the cwd when a flag is absent — so deriving `REPO_NAME` from the git remote URL matches both paths:

Important: the hook parses the raw shell command text before the shell expands variables. If the eventual `gh pr create` command uses `--head "$BRANCH"` or `--head "$SYNC_BRANCH"`, the hook may look for a gate marker keyed to the literal variable token rather than the branch value. Prefer writing the final `gh pr create` command with a literal `--head branch-name`. If the PR head is not the currently checked-out branch, set `PR_HEAD_BRANCH` below to that exact head branch; the snippet converts `/` to `-`.

```bash
# Match pr-workflow-gate.sh's `-R owner/repo` parsing by deriving REPO_NAME
# from the remote URL, not the worktree's directory basename. Worktrees
# typically have dir names like `kookr-feature-x` while the remote and the
# hook agree on `kookr`; using the basename there produces a key the hook
# never looks up. See issue #406.
REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || true)
REPO_NAME=$(basename -s .git "${REMOTE_URL:-$(git rev-parse --show-toplevel)}")
SAFE_BRANCH=${PR_HEAD_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}
SAFE_BRANCH=$(printf '%s' "$SAFE_BRANCH" | tr '/' '-')
touch "/dev/shm/.pr-gate-${REPO_NAME}-${SAFE_BRANCH}-pre-done"
```

**Do NOT create the state file if any mandatory check failed.** Fix the issue first, re-run the checks, then create it.

The state file is the contract between this skill and the `pr-workflow-gate` hook. The hook checks for its existence before allowing `gh pr create`.

## Output Contract

Before you conclude this skill, report the checklist result explicitly:

- detected project type: `pnpm|npm|yarn|rust|python|other`
- type/build checks: passed / failed / skipped (with reason)
- tests: passed / failed / skipped (with reason)
- bug reproduction (fix PRs only): reproduced / verified / skipped with reason
- diff review: done
- portability check: clean / flagged (with reason or fix) / skipped
- reviewer specialists: run / skipped, with reason
- OSS base-branch policy (external PRs only): matched / failed / skipped with reason
- gate file: created / not created

Do not say the branch is PR-ready without stating whether the reviewer specialists were run and whether the gate file was actually created.

## Quick Version

For small/obvious changes, the minimum is: run the detected build + test commands, then `git diff --stat`, then create the state file (see above).

## See Also

- [[pre-push]] — Delivery-cycle entrypoint before push (project-specific)
- [[pr-lifecycle]] — Full PR lifecycle after this checklist passes
- [[git-commit-discipline]] — Commit message and branch safety
- [[testing-patterns]] — Test configuration and isolation
