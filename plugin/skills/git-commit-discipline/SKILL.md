---
name: git-commit-discipline
description: Git commit hygiene for AI agents - atomic commits, Conventional Commits, secret scanning, branch safety, history protection
keywords: git commit, commit message, atomic commit, conventional commits, git add, gitignore, secret scan, force push, branch protection, commit hygiene, monolithic commit, commit discipline
related: merge-handler, git-merge-advanced, git-worktree-cleanup, workflow-reliability, code-documentation-patterns, code-review-discipline
---

# Git Commit Discipline

Rules for AI agents making git commits that are safe, atomic, traceable, and CI-friendly.

**Research:** `docs/deepresearch/reports/Git Commit Discipline for AI Coding Agents.md`

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **Conventional Commits** | `git commit -m "fix"` | `git commit -m "fix(auth): prevent token reuse after logout"` |
| 2 | **Atomic commits** | One commit with feature + refactor + docs | Separate commits per logical change |
| 3 | **Never commit to main/master** | `git push origin main` | Work on feature branch, merge via PR/quality-gate |
| 4 | **No `git add .`** | `git add .` (catches junk, secrets) | `git add src/file.ts test/file.test.ts` (named files) |
| 5 | **No force-push on shared branches** | `git push -f origin develop` | `git push --force-with-lease` on personal branches only |
| 6 | **Never commit secrets** | `git add .env` | Scan staged files; block `.env*`, tokens, API keys |
| 7 | **Never bypass quality gates** | `git commit --no-verify` | Run lint + tests + commitlint before every commit |
| 8 | **Body explains WHY** | Subject-only commit for non-trivial changes | Add body with motivation, not implementation details |
| 9 | **Commits must not break CI** | Committing code that fails lint/tests | Verify green before committing |
| 10 | **Always `--no-ff` for merges** | `git merge feature` (fast-forward) | `git merge --no-ff feature -m "Merge: description"` |

## Conventional Commits Format

```
<type>(<scope>): <imperative summary>

<body: why this change was needed>

<footer: references, breaking changes>
```

### Types

| Type | Use When |
|------|----------|
| `feat` | New feature (correlates with MINOR in SemVer) |
| `fix` | Bug fix (correlates with PATCH) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `test` | Adding or correcting tests |
| `chore` | Build process, CI, tooling |
| `perf` | Performance improvement |
| `style` | Formatting, whitespace (no logic change) |

### Examples

```bash
# WRONG
git commit -m "update"
git commit -m "stuff"
git commit -m "wip"

# CORRECT
git commit -m "feat(auth): add OAuth2 PKCE flow

Implements RFC 7636 to protect against authorization code
interception attacks on public clients.

BREAKING CHANGE: /oauth/token now requires code_verifier for public clients.
Closes #4721"

# Trivial (one-liner OK)
git commit -m "docs: fix typo in README"
git commit -m "style: format with biome"
```

## Atomic Commits

One logical change per commit. A commit should be independently revertable without breaking unrelated functionality.

```bash
# WRONG: monolithic commit mixing concerns
git add .
git commit -m "big feature"
# Mixes: new feature + refactor + formatting + bugfix + docs

# CORRECT: staged, atomic commits
git add src/services/user-service.ts
git commit -m "refactor: extract UserService from UserController"

git add src/routes/password-reset.ts src/services/password-service.ts
git commit -m "feat: add password reset endpoint"

git add docs/api-reference.md
git commit -m "docs: update API reference for password reset"
```

### Size Guidelines

| Metric | Threshold | Action |
|--------|-----------|--------|
| Lines changed | > 400 | Split into multiple commits |
| Unrelated files | > 3 | Separate by concern |
| Mixed types | feat + fix in one | Separate commits |

## Branch Safety

```bash
# WRONG: direct push to protected branch
git commit -am "quick fix"
git push origin main

# CORRECT: feature branch workflow
git checkout -b feat/password-reset
# ... make changes, commit atomically ...
# Merge via quality-gate or PR (--no-ff enforced)
```

**AegisCore-specific:** Worker agents use `workflow/<type>/<branch-id>` branches. Never commit directly to `main` or `develop`.

## Staging Discipline

```bash
# WRONG: stages everything including junk
git add .
git add -A

# CORRECT: explicit file selection
git add src/routes/auth.ts src/services/auth-service.ts
git add tests/auth.test.ts

# CORRECT: interactive hunk staging for mixed changes
git add -p  # Review each hunk individually
```

### Automatic Junk Detection

Before any `git add`, verify no junk files are staged:

| Pattern | Why It's Dangerous |
|---------|--------------------|
| `node_modules/` | Bloats repo (hundreds of MB) |
| `.env`, `.env.*` | Contains secrets |
| `dist/`, `build/` | Generated artifacts |
| `.DS_Store` | OS metadata |
| `*.pyc`, `__pycache__/` | Compiled bytecode |
| `*.log` | Runtime logs |
| `data/`, `*.sqlite` | Runtime data |

## Secret Prevention

**Before every commit, scan staged files for:**
- API keys (`sk-`, `pk_`, `AKIA`, etc.)
- Tokens (JWT patterns, OAuth tokens)
- Passwords in config files
- Private keys (`-----BEGIN.*PRIVATE KEY-----`)
- Connection strings with credentials

```bash
# Check for common secret patterns in staged files
git diff --cached --name-only | xargs grep -l -E \
  '(sk-|pk_|AKIA|password|secret|token|-----BEGIN)' 2>/dev/null

# If found: BLOCK the commit, alert the user
```

**If a secret was already committed:**
1. Revoke the credential immediately
2. Remove from history with `git filter-repo` or BFG
3. Never assume `git rm` is sufficient (it stays in history)

## History Safety

```bash
# WRONG: rewriting shared history
git commit --amend   # on already-pushed commits
git push -f origin develop
git rebase -i HEAD~5  # on pushed branch

# CORRECT: only rewrite local/unpushed history
git commit --amend   # only if NOT pushed yet
git push --force-with-lease origin feat/my-branch  # safer than -f

# CORRECT: squash via PR merge strategy (not rebase)
# Let the merge tool handle squashing, not manual rebase
```

**Rule:** Never `git push -f` on any branch that has been pushed, unless it is a personal feature branch less than 24 hours old. Prefer `--force-with-lease`.

## Quality Gate Compliance

Every commit must pass quality gates before creation:

```bash
# Pre-commit checklist (automated via hooks)
1. Lint check (biome + eslint)
2. Type check (bun run typecheck)
3. Unit tests (affected files)
4. Secret scan (staged files)
5. Commit message format (commitlint / Conventional Commits)
```

**Rule:** If any gate fails, fix the issue and create a NEW commit. Never `--no-verify` to skip hooks. Never `--amend` a previous commit to work around a hook failure (this destroys the previous commit's content).

## Worker Checkpoint Commits

Autonomous agents MUST commit incrementally to protect progress against interruption (context exhaustion, cost limits, crashes). **Uncommitted work is LOST on failure** — worktrees are force-cleaned on error.

### Commit Triggers

Commit after **any** of these:

| Trigger | Examples |
|---------|----------|
| **1 function/method** implemented or modified | New route handler, service method, utility function |
| **1 test file** written or updated | `auth.test.ts` with its test cases |
| **1 module/class** completed | New service class, new config file |
| **3+ files** modified since last commit | Regardless of whether a "unit" feels complete |
| **A bug fix** that makes a test pass | Failing test → passing = commit immediately |
| **A config or schema change** | Migration file, `.env.example`, `tsconfig.json` |
| **Before a risky operation** | Large refactor, dependency upgrade, deleting code |
| **User explicitly asks to commit** | `commit your changes`, `commit fixes first`, `commit local changes` |
| **Before cleanup or live-state operations** | Removing worktrees, cleaning branches, restarting services, triggering workflows, reproducing against live state |

**Rule of thumb:** if reverting your uncommitted changes would lose more than ~50 lines of meaningful work, you should have already committed.

### Interactive Session Rule

Treat commit reminders as hard operator constraints, not soft preferences.

- If the user says to commit, checkpoint before continuing unrelated exploration.
- If you are about to touch runtime state after code edits, make a checkpoint commit first unless the user explicitly wants a dirty tree.
- If multiple logical changes are still in flight, use a narrow `wip:` checkpoint rather than waiting for a perfect final commit.

### Checkpoint Commit Format

```bash
# Use wip: prefix for in-progress checkpoints
git commit -m "wip(auth): implement token validation logic

Progress checkpoint - session protection."

# Final commit uses standard Conventional Commits
git commit -m "feat(auth): add OAuth2 PKCE flow"
```

### Squash Strategy

Checkpoint commits are squashed at merge time by the quality-gate, so frequent `wip:` commits have **zero cost** to final history cleanliness. Prefer committing too often over not enough.


## Common Anti-Patterns Checklist

Before committing, verify:

- [ ] Commit message follows Conventional Commits format
- [ ] Commit is atomic (one logical change)
- [ ] Not committing directly to main/develop
- [ ] No `git add .` or `git add -A` (use named files)
- [ ] No `.env`, secrets, or credentials staged
- [ ] No generated files (`dist/`, `node_modules/`, `build/`)
- [ ] Lint and tests pass
- [ ] Commit message body explains WHY (for non-trivial changes)
- [ ] Any explicit user request to commit has been satisfied before unrelated next steps
- [ ] No `--no-verify` or `--amend` on pushed commits
- [ ] Merge commits use `--no-ff`

## See Also

[[merge-handler]] - Operational merge commands and conflict resolution
[[git-merge-advanced]] - AI-assisted merge resolution and retry patterns
[[git-worktree-cleanup]] - Branch and worktree lifecycle management
[[workflow-reliability]] - Workflow state sync and recovery
[[code-review-discipline]] - PR scope, self-review checklists, review feedback handling
