# Hooks setup

Kookr relies on two independent layers of hooks:

1. **Repo git hooks** — `.hooks/pre-push`, auto-installed via `pnpm install`. Enforces type-check and test pass before `git push`. **Required** for all contributors.
2. **Claude Code user-global hooks** — `~/.claude/hooks/*.sh`, wired into `~/.claude/settings.json`. Enforces the PR / OSS-contribution / scout workflow inside Claude Code and Codex CLI sessions. **Optional** — only relevant if you run those agents on this repo.

This document walks both newcomers through the setup, from the "I just want to contribute a PR" path (5 seconds) to the full "I want the same guardrails when running autonomous agents" path (a few minutes).

## OSS extension hooks (bundled with the repo)

> **Status:** The OSS-extension skills now ship with the `kookr-toolkit` marketplace plugin (`plugin/skills/pr-contribution-excellence/`, `plugin/reviewer-specialists/`, `plugin/skills/pre-pr-review/`). The PreToolUse / PostToolUse **hooks** stay in this repo at `hooks/` and `scripts/` (not under `plugin/`) because they require explicit user-global hook installation and support runtimes where plugin hooks are not injected. `scripts/install-hooks.sh` installs:
>
> - `hooks/oss-stale-scout-gate.sh` → `~/.claude/hooks/oss-stale-scout-gate.sh`
> - `hooks/pr-workflow-gate.sh` → `~/.claude/hooks/pr-workflow-gate.sh`
> - `hooks/oss-contribution-gate.sh` → `~/.claude/hooks/oss-contribution-gate.sh`
> - `hooks/post-merge-keyword-scan.sh` → `~/.claude/hooks/post-merge-keyword-scan.sh`
> - `hooks/kb-context-inject.sh` → `~/.claude/hooks/kb-context-inject.sh` (RFC 018 M2; off by default)
> - `plugin/skills/pre-pr-review/` → `~/.claude/skills/pre-pr-review/`
> - `plugin/reviewer-specialists/` → `~/.claude/reviewer-specialists/`
> - `plugin/skills/pr-contribution-excellence/` → `~/.claude/skills/pr-contribution-excellence/`
>
> `scripts/install-oss-tracking-hook.sh` installs the PostToolUse tracking hook from `scripts/oss-contribution-gate-posttool.sh`.
>
> The remaining user-global pieces (`claim-gate`, `ai-coauthor-push-guard`, plus the `oss-gate` and `oss-registry-check` CLIs) live outside this repo because they target unrelated workflows; bundling them is a separate effort and out of scope here.
>
> `pr-workflow-gate.sh` is **scope-gated**: it consults `~/.kookr/pr-gated-repos.json` and forms an opinion only about repos listed there. If the file is absent the hook falls back to the previous "gate everything" behavior — the upgrade is opt-out, not opt-in. See `Minimum install` below for the scope-list format and the "silent mode" (`[]`) recipe.

## KB context-injection hook (`kb-context-inject.sh`)

`hooks/kb-context-inject.sh` is a `UserPromptSubmit` hook implementing the
RFC 018 §11 consumer contract. Before an agent turn it runs a
relevance-gated `kb search` and injects the post-gate knowledge-base context
into the turn:

- Calls `kb search "<prompt>" --gate --task-context-file=<f> --format=json`.
- Assembles `task_context` from the prompt, stamped with a monotonic
  per-session turn id (the freshness contract).
- Validates the response's `gate_verdict` against the vendored
  relevance-gate schema (`src/core/relevance-gate-schema.ts`).
- Honors the verdict — `no-relevant-context` / `empty-index` inject nothing;
  `injected` + `low_confidence` injects but flags every snippet
  `[low-confidence]`.
- Echoes `gate_verdict` (state, by-stage drop counts, `degraded`) to stderr —
  the collapsed debug channel.

**OFF by default.** The hook is inert unless `KOOKR_KB_CONTEXT_INJECT` is
truthy (`1`/`true`/`on`/`yes`). RFC 018 M1 returned a **NO-GO** for defaulting
the gate on (see `docs/rfcs/018-m1-canary-report.md` in
`knowledge-base-mcp-server`), and `kb search --gate` invokes an LLM judge
that adds latency to every turn. M2 ships the mechanism; M3 decides
default-on. Opt in for a session with:

```bash
export KOOKR_KB_CONTEXT_INJECT=1
```

`scripts/install-hooks.sh` symlinks and registers the hook like the others.
When enabled it needs the `kb` CLI (`knowledge-base-mcp-server`) on `PATH`
and `node` + `tsx` (resolved from the `node_modules` of the repo the hook
symlinks back to — run `pnpm install` there). It is fail-open: a missing
dependency, an unreachable judge, a malformed response, or any crash
degrades to "inject nothing" — the turn always proceeds.

## Fast path: repo pre-push hook only

```bash
git clone git@github.com:kookr-ai/kookr.git
cd kookr
pnpm install         # runs `prepare` → `git config core.hooksPath .hooks`
```

That's it. Every `git push` from this point on will run `pnpm build:server`, `pnpm check:e2e`, and `pnpm test` before uploading. If any of those fail, the push is rejected.

You don't need to do anything else if you don't use Claude Code on this repo.

## Full path: Claude Code workflow guardrails

If you use Claude Code (or Codex CLI) to work on this repo, there is a larger hook stack that enforces PR-creation workflow, rate-limits external OSS contributions, and blocks zombie PRs. All of these live in `~/.claude/hooks/` and are wired via `~/.claude/settings.json` **per user**, not per repo — Claude Code loads settings from the user's home, not the working directory.

### Hook inventory

| Hook | Event / Matcher | Purpose | Source |
|------|-----------------|---------|--------|
| `pr-workflow-gate.sh` | `PreToolUse` / `Bash(gh pr create*)` | Blocks `gh pr create` until the `pre-pr-review` skill has created a state file proving pre-PR checks ran | **In this repo at `hooks/pr-workflow-gate.sh`** |
| `oss-contribution-gate.sh` | `PreToolUse` / `Bash` | Rate-limits external OSS PRs (default 1/day/repo) and enforces the blocked-repo list (`~/.kookr/rate-limits.json`) | **In this repo at `hooks/oss-contribution-gate.sh`** |
| `oss-contribution-gate-posttool.sh` | `PostToolUse` / `Bash(gh pr create*)` | Captures successfully-created PRs into `~/.kookr/oss-attempts.json` via Kookr's HTTP API | **In this repo at `scripts/oss-contribution-gate-posttool.sh`** |
| `oss-stale-scout-gate.sh` | `PreToolUse` / `Bash(gh pr create*)` | Blocks `gh pr create` when the PR body references an already-closed upstream issue (any of the 9 GitHub closing keywords + cross-repo refs + URL form) | **In this repo at `hooks/oss-stale-scout-gate.sh`** |
| `claim-gate.sh` | `PreToolUse` / `Bash` | Blocks issue-claim comments (`gh issue comment`, `gh api .../comments -X POST`) if a competing PR or assignment already exists | User-global, not bundled |
| `ai-coauthor-push-guard.sh` | `PreToolUse` / `Bash(git push*)` | Rejects `git push` to external remotes when commits carry AI attribution markers (`Co-Authored-By: Claude`, etc.) that the target repo forbids | User-global, not bundled |
| `kookr-prod-readonly-guard.sh` | `PreToolUse` / `Edit`, `Write` | Blocks edits to files under `../kookr-prod` (the production worktree at `~/git/kookr-prod`) so agents can't accidentally mutate prod | User-global, not bundled |
| `fix-bare-after-worktree.sh` | `PostToolUse` / `EnterWorktree` | Unsets `core.bare` on the main repo if a worktree creation set it, preventing "fatal: this operation must be run in a work tree" errors | User-global workaround |
| `oss-gate` (CLI) | N/A (invoked manually) | Status / reset / log / health commands for the rate-limit gate | User-global helper |
| `oss-registry-check` (CLI) | N/A (invoked manually) | Resolves a repo against the `~/.kookr/oss-repos.json` registry to check eligibility | User-global helper |

**The four OSS-extension PreToolUse / PostToolUse hooks (`pr-workflow-gate`, `oss-stale-scout-gate`, `oss-contribution-gate`, `oss-contribution-gate-posttool`) have canonical source in this repo under `hooks/` and `scripts/`, alongside the `pre-pr-review` and `pr-contribution-excellence` skills at `plugin/skills/`, and the reviewer specialists at `plugin/reviewer-specialists/`. The hooks are not under `plugin/` because they require explicit user-global hook installation and support runtimes where plugin hooks are not injected.** Remaining items — `claim-gate.sh`, `ai-coauthor-push-guard.sh`, `kookr-prod-readonly-guard.sh`, `fix-bare-after-worktree.sh`, plus the `oss-gate` and `oss-registry-check` CLIs — still live as standalone files in `~/.claude/hooks/` and `~/.local/bin/`. Bundling those is tracked in the "Future work" section at the bottom.

### Interaction with `kookr spawn`

`kookr spawn` (see `README.md` Terminal Usage section) is a CLI that POSTs prompts to `POST /api/tasks`. Hooks like `pr-workflow-gate.sh` and `oss-stale-scout-gate.sh` inspect `tool_input.command` — the entire bash command text, including argv.

**Hook-safe — prompt NOT on the bash command line:**
- `kookr spawn --prompt-file /tmp/prompt.md` — hook sees only the flag and the path.
- `cat /tmp/prompt.md | kookr spawn` — hook sees only the pipe, not the file contents.

**Not hook-safe — prompt IS on the bash command line:**
- `kookr spawn "please gh pr create for the release branch"` — positional argv.
- `kookr spawn --criteria "ensure gh pr create succeeds"` — flag values are argv too.

If your prompt or criteria contain strings that PreToolUse hooks match on (`gh pr create`, `git push --force`, `rm -rf`, closing-issue keywords on upstream issues), use `--prompt-file` or piped stdin. The CLI does not try to auto-detect Claude Code sessions or inject workaround magic — see the `kookr spawn --help` text for the human-facing rule.

### Minimum install for running Claude Code agents in this repo

1. **Install the bundled hooks and skill** with a single command:

   ```bash
   # Run from the main kookr checkout (NOT a worktree)
   cd ~/git/kookr
   bash scripts/install-hooks.sh
   ```

   The script creates these symlinks and registers the hooks in `~/.claude/settings.json` idempotently:

   - `~/.claude/hooks/oss-stale-scout-gate.sh` → `$(repo-root)/hooks/oss-stale-scout-gate.sh`
   - `~/.claude/hooks/pr-workflow-gate.sh` → `$(repo-root)/hooks/pr-workflow-gate.sh`
   - `~/.claude/hooks/oss-contribution-gate.sh` → `$(repo-root)/hooks/oss-contribution-gate.sh`
   - `~/.claude/hooks/post-merge-keyword-scan.sh` → `$(repo-root)/hooks/post-merge-keyword-scan.sh`
   - `~/.claude/hooks/kb-context-inject.sh` → `$(repo-root)/hooks/kb-context-inject.sh`
   - `~/.claude/skills/pre-pr-review` → `$(repo-root)/plugin/skills/pre-pr-review`
   - `~/.claude/skills/pr-contribution-excellence` → `$(repo-root)/plugin/skills/pr-contribution-excellence`
   - `~/.claude/reviewer-specialists` → `$(repo-root)/plugin/reviewer-specialists`

   Re-running is safe; it never duplicates entries or clobbers non-symlink files or directories.

   After this, `pr-workflow-gate.sh` will fire on every `gh pr create` whose target repo is listed in `~/.kookr/pr-gated-repos.json`. The active repo's branch must first produce a `/dev/shm/.pr-gate-<repo>-<branch>-pre-done` state file via the `pre-pr-review` skill. One-time bypass: `touch /dev/shm/.pr-gate-<repo>-<branch>-bypass`.

2. **Configure the PR-gate scope list** (opt-out default preserved if you skip this step):

   ```bash
   # Gate PRs only for these repos; stay silent on every other gh pr create.
   # IMPORTANT: the tmp file must live next to the target so `mv` is a
   # rename(2) and therefore atomic. Cross-filesystem mv is copy+unlink,
   # not atomic, and torn reads during edits become routine.
   cat > ~/.kookr/pr-gated-repos.json.tmp <<'EOF'
   [
     "kookr-ai/kookr"
   ]
   EOF
   mv ~/.kookr/pr-gated-repos.json.tmp ~/.kookr/pr-gated-repos.json
   ```

   Entries are matched case-insensitively against the target `owner/repo` of every `gh pr create`. Resolution order:
   1. `-R owner/repo` on the command line, if present.
   2. `gh`'s persisted default remote (set via `gh repo set-default`), recorded under `remote.<name>.gh-resolved` in git config.
   3. `upstream` remote, then `origin`.

   **Semantic of the file:**
   - Absent → gate everything (previous behavior; safe for maintainer upgrades).
   - JSON array of strings (`["owner/repo", ...]`) → gate only those; exit 0 on every other `gh pr create`.
   - Empty array (`[]`) → gate nothing (silent mode — the hook is installed but forms no opinion).
   - Any other shape / invalid JSON → log to `~/.kookr/hook-errors.log` and fall through to gate-everything (never silently drops the gate on a corrupt file).

3. **Install the PostToolUse OSS tracking hook** (optional, recommended for OSS contribution workflows):

   ```bash
   bash scripts/install-oss-tracking-hook.sh
   ```

   Copies `plugin/hooks/oss-contribution-gate-posttool.sh` to `~/.claude/hooks/` and prints the `~/.claude/settings.json` snippet to register it under `PostToolUse`.

4. **(Optional) Install the still-user-global hooks.** A few hooks are not bundled because they target unrelated workflows: `claim-gate`, `ai-coauthor-push-guard`, `kookr-prod-readonly-guard`, `fix-bare-after-worktree`. Options:
   - On the maintainer's machine they are already at `~/.claude/hooks/`.
   - To replicate on a new machine, read the RFCs listed above — each RFC includes the hook pseudocode and its behavior contract in enough detail to re-implement from scratch.
   - Register each hook in `~/.claude/settings.json` under `PreToolUse` or `PostToolUse` as the RFC specifies.

### Verifying your setup

After installing, sanity-check the stack:

```bash
# 1. Confirm the repo pre-push hook is wired
git config core.hooksPath
# Expected: .hooks

# 2. Confirm the Claude Code hooks and skill are symlinked
ls -l ~/.claude/hooks/oss-stale-scout-gate.sh ~/.claude/hooks/pr-workflow-gate.sh
ls -l ~/.claude/skills/pre-pr-review
# Expected: symlinks pointing to your kookr checkout's hooks/ and .claude/skills/ dirs

# 3. Confirm settings.json entries exist
jq '.hooks.PreToolUse[] | select(.hooks[0].command | test("oss-stale-scout-gate|pr-workflow-gate|oss-contribution-gate"))' \
  ~/.claude/settings.json
# Expected: three JSON objects (one per PreToolUse hook)

# 4. Run the hook tests
pnpm test:hooks
# Expected: all cases pass across oss-stale-scout-gate, pr-workflow-gate, no-personal-paths

# 4b. Confirm the PR-gate scope list (if you created one)
cat ~/.kookr/pr-gated-repos.json 2>/dev/null \
  || echo "(no scope list — hook will gate every gh pr create)"

# 5. End-to-end smoke test against a known-closed issue
# (Replace with an issue you know is closed in a repo you have read access to.)
printf '{"tool_name":"Bash","tool_input":{"command":"gh pr create --repo OWNER/REPO --title t --body \"%s\""},"cwd":"/tmp"}' \
  '$(cat <<<EOF\nFixes #N\nEOF\n)' \
  | bash ~/.claude/hooks/oss-stale-scout-gate.sh
# Expected: a JSON deny payload naming the closing PR.
```

If step 3 returns empty or step 4 shows any failure, re-run `bash scripts/install-hooks.sh` and check its output.

### Uninstall

Easiest:

```bash
cd ~/git/kookr
bash scripts/install-hooks.sh --uninstall
```

This removes both hook symlinks, the `pre-pr-review` skill symlink, and the corresponding `settings.json` entries. Manual equivalent:

```bash
# 1. Remove the hook and skill symlinks
rm -f ~/.claude/hooks/oss-stale-scout-gate.sh
rm -f ~/.claude/hooks/pr-workflow-gate.sh
rm -f ~/.claude/hooks/oss-contribution-gate.sh
rm -f ~/.claude/skills/pre-pr-review

# 2. Remove the settings.json entries
tmp=$(mktemp)
jq 'del(.hooks.PreToolUse[] | select(
      (.hooks // [])[0].command // "" | test("oss-stale-scout-gate|pr-workflow-gate|oss-contribution-gate")
    ))' ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json
```

The Kookr repo pre-push hook stays active unless you also run `git config --unset core.hooksPath` and re-install.

### How hook enforcement actually works

Key things to know if you're debugging a denied action or a missing block:

- **Claude Code runs matched PreToolUse hooks in parallel**, not sequentially. Registration order in `settings.json` is cosmetic. See `rfc-oss-stale-scout-gate.md` §Hook parallelism for the full story.
- **`deny` wins** — when multiple hooks return different decisions, any `deny` blocks the tool call.
- **Every hook in this stack fails open** — if the script crashes, times out, or returns a non-zero exit without a permissionDecision payload, Claude Code treats that as "no opinion" and the tool call proceeds. Failures are logged to `~/.kookr/hook-errors.log`, not surfaced as block errors.
- **State files live in `/dev/shm`** — tmpfs, cleared on reboot. This is deliberate: developer bypasses are short-lived escape hatches, not durable config.
- **Ledger is `~/.kookr/contribution-ledger.jsonl`** — append-only JSONL, authoritative for OSS PR counting and stale-scout block history. Inspect with `oss-gate log` or `jq`.

### Common troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `gh pr create` denied with "Pre-PR review has not been completed" | You ran `gh pr create` without first running the `pre-pr-review` skill | Run `pre-pr-review` (or use the `pre-push` skill which composes it), then retry. One-time bypass: `touch /dev/shm/.pr-gate-<repo>-<branch>-bypass` |
| `gh pr create` allowed through without a state file for a repo I expected to be gated | Repo is not listed in `~/.kookr/pr-gated-repos.json`, or the scope list is `[]` (silent mode) | Add `owner/repo` to the scope list, or delete the file to fall back to gate-everything |
| `gh pr create` denied on a repo I don't care about | The scope-list file is absent — the hook defaults to gating every `gh pr create` | Create `~/.kookr/pr-gated-repos.json` with only the repos you want gated (use `[]` to disable globally) |
| `gh pr create` denied with "Rate limit exceeded" | You already created 1 PR to this repo today | Wait until UTC midnight, or `oss-gate reset <owner/repo>` if the previous PR failed |
| `gh pr create` denied with "BLOCK: ... is closed" | The referenced issue is already closed upstream (stale-scout hook) | Either pick a different issue, or bypass deliberately: `touch /dev/shm/.stale-scout-<owner>-<repo>-<N>-bypass` |
| `gh pr create` denied with "Repository X is blocked" | Target repo is on the blocked list in `~/.kookr/rate-limits.json` | Intentional — these are anti-AI-policy repos. Don't bypass |
| `gh issue comment` denied with "Claim blocked" | Another open PR already references this issue, or it's assigned to someone else | Pick a different issue |
| `git push` denied with "Commits contain AI attribution" | You're pushing to an external remote with `Co-Authored-By: Claude` in a commit | Either remove the trailer if the target repo forbids it, or push to a fork and wait for the external policy check |
| Edit/Write denied with "kookr-prod readonly" | You tried to edit a file under `../kookr-prod` | Edit the main repo; prod gets updated via `pnpm prod:update` |
| A hook used to fire and now doesn't | `~/.kookr/hook-errors.log` has silent fail-open entries, OR the symlink / settings entry was removed | Re-run `bash scripts/install-hooks.sh`, then `cat ~/.kookr/hook-errors.log \| tail -20` |

### Future work

The four OSS-extension PreToolUse / PostToolUse hooks and the `pr-contribution-excellence` skill are bundled. Remaining user-global hooks (`claim-gate`, `ai-coauthor-push-guard`, `kookr-prod-readonly-guard`, `fix-bare-after-worktree`) and CLIs (`oss-gate`, `oss-registry-check`) are not bundled because they sit outside the OSS PR workflow this stack targets — bundling them is a separate effort. The scope-gate that `pr-workflow-gate.sh` uses (consults `~/.kookr/pr-gated-repos.json`) is implemented; an analogous scope-gate for `oss-contribution-gate.sh` (so non-Kookr users can adopt the bundle without forcing rate-limits on every `gh pr create`) is a follow-up.
