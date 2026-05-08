# Contributing to Kookr

Thanks for your interest in Kookr! This guide covers everything you need to ship a PR — local setup, the verification matrix, conventions, and how the merge gates work. For the project overview, what Kookr does, and design rationale, start with the [README](README.md).

## Dev environment

Setup, prerequisites, and the daily-use vs. development split are documented once, in the [README's Quick Start](README.md#quick-start). The short version:

```bash
git clone https://github.com/kookr-ai/kookr.git && cd kookr
pnpm install
pnpm dev         # backend on :4801 + Vite frontend on :5173
```

If anything fails, run `pnpm doctor` — it diagnoses Node/pnpm versions, build tools, the dtach binary, GPU availability, and port conflicts, then prints copy-pasteable fix commands.

## Verification matrix

Before opening a PR, run the same commands the pre-push hook will run:

| Command | What it checks |
|---|---|
| `pnpm test` | Unit + integration tests (Vitest) |
| `pnpm test:hooks` | Bash hook tests under `.claude/hooks-tests/` |
| `pnpm check:e2e` | TypeScript check for E2E tests (`tsc -p tsconfig.e2e.json`) |
| `pnpm exec playwright test` | Playwright E2E suite |
| `pnpm build:server` | Server TypeScript compile (subset of `pnpm build`) |
| `pnpm build` | Full build — dtach binary + server `tsc` + Vite frontend |

There is no separate `lint` step — TypeScript strict mode (enforced by `tsc`) serves that role.

If you touch E2E mocks, also run the canary check listed in the [PR template](.github/pull_request_template.md) to validate fixtures against real Claude Code.

## Commit messages

Kookr uses [Conventional Commits](https://www.conventionalcommits.org/). Common prefixes:

- `feat:` — new user-facing capability
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — internal restructuring without behaviour change
- `test:` — test-only changes
- `chore:` — tooling, config, deps

Scope is optional but useful for cross-cutting work, e.g. `feat(cost-comparison): always-on (drop KOOKR_COST_PANEL flag)`.

## Branch naming

Use a slash-prefixed slug matching your commit type:

- `feat/<slug>` — new features
- `fix/<slug>` — bug fixes
- `docs/<slug>` — docs-only changes
- `chore/<slug>` — tooling, deps, repo housekeeping

Long-form examples from the recent commit history: `feat/launch-task-cwd-button`, `fix/adapter-file-based-agents`, `docs/strip-rfc-and-tmux-refs`, `chore/add-license`. Issue-driven branches that include the issue number (e.g. `feat-issue-101-onboarding-ci-prereqs`) are also fine — the slug is what matters for review and history readability.

## Contributor License Agreement

Contributions require signing the [CLA](CLA.md). The CLA Assistant bot comments on your first pull request with a one-line sign-off phrase — post that comment on the PR and you're set. Future PRs (matched by GitHub username) are auto-recognized; you only need to sign once.

The CLA grants the project owner a broad license to relicense contributions, which keeps dual-licensing and commercial offerings open while ensuring publicly-released versions stay under Apache 2.0. See [CLA.md](CLA.md) for the full text.

## PR sizing

Smaller PRs land faster. Aim for one focused change per PR — feature, fix, or refactor — rather than bundling unrelated work. If your change spans multiple concerns, split it into a stack of PRs that each pass tests independently.

A useful rule of thumb: if the diff exceeds a few hundred lines outside generated/locked files, consider whether it can be split. Large refactors are fine when they're cohesive (one mechanical rename, one architectural move) but should arrive as a single reviewable shape — not mixed with feature work.

## How the pre-push hook gates work

`pnpm install` wires `git config core.hooksPath .hooks` via the `prepare` script, so `.hooks/pre-push` runs on every `git push`. The gate runs in this order, fail-closed:

1. **`.review-state` files in the index → reject.** These markers are local-only; remove with `git rm --cached`.
2. **`node_modules` missing → self-heal.** Runs `pnpm install --frozen-lockfile` first.
3. **Reviewer-specialist gate** for non-trivial diffs. The gate inspects the merge-base diff against `origin/main` and skips an allowlist (top-level `*.md`, `docs/`, `.github/`, test files, tsconfig, `.gitignore`). Non-trivial pushes need a SHA-bound marker at `.review-state/<branch>.json` written by running the `pre-push` skill in Claude Code (it spawns reviewer specialists in parallel and writes `{sha, status: "approved" | "bypass", reason}`). The marker SHA must match `HEAD`.
4. **Server type-check** — `pnpm build:server` (`tsc`).
5. **E2E type-check** — `pnpm check:e2e` (`tsc -p tsconfig.e2e.json`).
6. **Tests** — `pnpm test`.
7. **Plugin classification + version bump** for changes under `plugin/`. Rejects Kookr-internal references (the toolkit ships to all consumers, so `pnpm prod:*`, `KOOKR_*`, `~/.kookr/`, etc. must not appear), name collisions between `.claude/<kind>/` and `plugin/<kind>/`, and `plugin/{skills,agents}/**` edits without a corresponding bump in `plugin/.claude-plugin/plugin.json#version`.

If any step fails, fix the underlying issue and re-run `git push`. Don't bypass with `--no-verify` — the gates exist because they've caught real regressions.

## Where to ask for help

- **Bug reports & feature requests** — open a [GitHub issue](https://github.com/kookr-ai/kookr/issues).
- **Security disclosures** — use [GitHub Security Advisories](https://github.com/kookr-ai/kookr/security/advisories/new) (private).
- **Questions while contributing** — comment on the relevant issue or PR. GitHub Discussions are not enabled yet.

## Working with AI agents

If you use Claude Code or Codex CLI to work on this repo, the bundled `.claude/skills/`, `.claude/agents/`, and `.claude/playbooks/` are picked up automatically. The `pre-push` skill is the supported entry point for satisfying the reviewer-specialist gate above. See [`docs/hooks-setup.md`](docs/hooks-setup.md) for the optional user-global hook stack.

## Maintainer notes

- Comparison tables, roadmap snapshots, and similar README sections drift fast. Refresh them as part of release prep, and bump explicit cross-references when filenames or anchors move.
- The CLA flow applies equally to maintainers — first PR after the CLA gate landed needs the sign-off comment once, then future PRs are auto-recognized.
