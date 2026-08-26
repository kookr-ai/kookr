# Kookr — AI Agent Instructions

## What is Kookr?

Kookr is a **smart attention router** for developers running multiple AI coding agents. Its core is a **supervisor agent** — an AI that watches your coding agents' output streams, detects anomalies (stuck loops, repeated errors, permission blocks, budget burn), and explains what's going wrong in plain language. It then routes the developer to the most urgent agent.

It IS an AI agent — but a supervisor, not a coder. It watches agents, not code.

## Repository Structure

```
README.md              — Start here: problem, solution, design principles
docs/features.md       — What the app must do (user-facing)
docs/architecture.md   — System design: supervisor agent, adapters, reuse map
docs/roadmap.md        — 4 implementation phases (Phases 1-3 mostly complete)
docs/adr/              — Architecture Decision Records: accepted technical decisions
docs/poc/              — Proof-of-concept validation (hook mechanism)
docs/reports/          — One-time analysis artifacts (gap reports, audits)
src/core/              — Domain logic, contracts, parsers, stores, anomaly detection, attention queue, monitor, local persistence helpers
src/adapters/          — I/O boundaries: TerminalBackend + LocalDtachBackend, Claude Code adapter, Codex CLI adapter
src/server/            — HTTP (Hono) + WebSocket server, hook file watcher, reconciliation
src/frontend/          — React SPA: components, Zustand store, WebSocket hook, CSS
.claude/skills/        — Kookr-internal skills (project-scope; reference Kookr paths/commands)
.claude/agents/        — Kookr-internal review agents (project-scope)
plugin/                — Kookr Toolkit (Claude Code plugin distributed via marketplace)
plugin/.claude-plugin/plugin.json  — Plugin manifest (name, version, author)
plugin/skills/         — General-purpose toolkit skills (no Kookr-internal refs)
plugin/agents/         — General-purpose review subagents
.claude-plugin/marketplace.json    — Marketplace manifest pointing at ./plugin
```

## Key principles

1. **Reuse, don't reinvent** — Agent drivers from aegiscore, skill format from Claude Code. Check existing solutions before designing new ones.
2. **Smart supervisor, not coder** — Kookr's AI understands what agents are doing and explains anomalies. It doesn't write code itself.
3. **Simple first** — Keep the product local-first and single-package by default. Prefer existing shipped mechanisms (local JSON/JSONL/SQLite stores, Kookr Toolkit plugin, hosted relay transport) before adding new persistence, plugin, or cloud surfaces.
4. **TypeScript strict** — Full TypeScript stack, strict mode, discriminated unions, exhaustive switches.
5. **Spec-driven** — Write spec → write tests (Vitest + Playwright) → implement.

## Decided

- Backend + Frontend: TypeScript (ADR-001)
- Frontend framework: React + Vite, Zustand for state (ADR-002)
- Deployment: Local Node.js backend + browser frontend (ADR-003)
- Testing: Vitest (unit/integration) + Playwright (E2E)
- Agent execution: Managed terminal sessions — agents run in interactive mode inside dtach-backed sessions owned by LocalDtachBackend. One persistent attach per session, ring-buffered for replay. Input via byte-level writes. Anomaly monitoring uses hooks; transcript JSONL feeds token/cost and freshness tracking (ADR-014 supersedes ADR-007)
- Agent monitoring: Claude Code hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`) injected via `--settings` flag. Hooks are additive to user settings. See docs/poc/001-hook-mechanism-validation.md
- Skill/agent distribution: Kookr Toolkit ships as a Claude Code plugin at `plugin/` with `.claude-plugin/marketplace.json` listing it. `ClaudeCodeAdapter` injects `--plugin-dir <kookr>/plugin` into every spawned `claude` so Kookr-spawned agents see the toolkit regardless of cwd. Other developers install via `/plugin marketplace add kookr-ai/kookr` + `/plugin install kookr-toolkit@kookr`.

## CI policy: GitHub Actions is DISABLED — local verification is the merge gate (operator decision, standing)

**GitHub Actions is turned OFF at the repository level for this repo.** Even
though this repo is public (free minutes), its CI kept going red on real
failures and coding agents wasted whole iterations waiting for a green that
never came, then merged red anyway. The operator is the **sole merger** here and
relies on LOCAL verification as the authoritative gate, so CI was disabled
outright rather than left to run:

- **No workflow under `.github/workflows/` runs.** Do not treat "no checks on
  the PR" as an outage — it is the intended, permanent state. State it explicitly
  if asked.
- **The automated CI workflows were neutered** (`push` / `pull_request` /
  `issue_comment` triggers replaced with manual-only `workflow_dispatch`) as
  defense-in-depth, so re-enabling Actions cannot silently resurrect red PR
  checks. The files are kept only as a reference for what the gates used to
  check. See `.github/workflows/README.md`.
- **`cla.yml` is intentionally left functional** (its triggers were NOT
  neutered): it is a legal CLA collector for outside contributors, not a
  test/CI gate. If Actions is ever re-enabled for legal reasons, CLA must work
  as-is. Do not neuter it as part of the CI-disable policy.
- **Verify locally, fully, before opening the PR.** Typecheck, the full test
  suite, and touched-surface gates run on this machine, are enforced by the
  pre-push review hooks, and are the ONLY authoritative green. Record the
  evidence (commands + summary counts) in the PR body.
- **Then create the PR and merge it yourself** once local gates are green. There
  are no GitHub checks to wait for — do not stall on pending checks, bot
  reviewers, or a human unless the task explicitly says otherwise.
- **Never** re-enable Actions, restore automatic triggers, add required status
  checks, alert about CI billing, file issues to "fix CI billing", propose
  paying for CI, or add workflows that consume paid minutes. This is a standing
  decision — do not revisit or suggest reversing it.
- Playbook parameter `ignoreBudgetCiFailures` defaults to `true` accordingly.

## Where to put a new skill or agent

Two homes only (RFC: `docs/rfc/rfc-skill-agent-distribution.md`):

- **Kookr-internal** (references `pnpm prod:*`, `pnpm build:server`, `KOOKR_*`, `~/.kookr/`, `.hooks/`, hardcoded `/home/.../git/kookr`, or describes Kookr internals like the dashboard / supervisor / playbook system / `.review-state` markers): goes in `<kookr>/.claude/{skills,agents}/` with a **`kookr-`** prefix in the directory or file name. Loaded as project-scope when cwd is the Kookr repo. Not shipped to other developers.
- **General-purpose** (no Kookr-internal references): goes in `<kookr>/plugin/{skills,agents}/` with **no** `kookr-` prefix. Ships via the toolkit plugin to all consumers. **Bump `plugin/.claude-plugin/plugin.json#version`** in the same PR — the pre-push hook enforces this.

The `hooks/skill-placement-gate.sh` script (called from `.hooks/pre-push`) enforces both rules: every dir in `.claude/skills/` and every file in `.claude/agents/` must start with `kookr-`; nothing in `plugin/skills/` may; no name collision between the two trees; no unqualified `subagent_type` references inside skill bodies.

User-scope (`~/.claude/skills/<name>`) **wins over** project-scope (`<cwd>/.claude/skills/<name>`) on name collision (silent shadow — empirically verified).

Plugin skill invocation backwards-compat is **narrower than previously stated**: natural-language prompts ("use the `typescript-type-safety` skill") still resolve via model-mapping to `kookr-toolkit:typescript-type-safety`, but **slash commands** (e.g., `/typescript-type-safety` would not resolve) and **programmatic `subagent_type` calls** require the qualified form (`/kookr-toolkit:typescript-type-safety`, `subagent_type: "kookr-toolkit:boundary-critic"`). The placement gate rejects unqualified `subagent_type` references inside skill bodies.

The `KOOKR_PLUGIN_DIR` env var overrides the auto-resolved plugin path. Set to empty string to disable injection for a session (hermetic mode).
- Platform: Linux + macOS required. Windows deferred.

## Related projects

- `~/git/aegiscore` — Agent drivers, stuck detector, JSONL parsers (we fork code from here)
- `~/git/openclaw` — Plugin SDK, skills, gateway protocol (we study patterns from here)
- `~/git/codex` — Forked Codex CLI with Claude-compatible skill loading (`.claude/skills` instead of `.agents/skills`)

## Codex CLI binary

Kookr's Codex adapter (`src/adapters/codex-cli-adapter.ts`) calls a Codex CLI binary configured via `KOOKR_CODEX_BIN` (defaults to `codex` on PATH). This binary comes from the forked repo at `~/git/codex`.

- **Rebuild after fork changes:** `pnpm codex:rebuild` (defaults to the faster `kookr-dev` build path in `scripts/rebuild-codex.sh`). Installs **both** `codex` and `codex-code-mode-host` into `CODEX_INSTALL_DIR` (default `~/bin`) — the host is a sibling binary the CLI spawns for shell/tool execution; a CLI-only install boots but fails every tool call with `failed to spawn code-mode host …/codex-code-mode-host`.
- **Override paths:** `CODEX_SRC` (fork location), `CODEX_INSTALL_DIR` (install target), `CODEX_BUILD_PROFILE` (`kookr-dev` by default, set to `release` for the full slow build), `CODEX_HOST_FROM_RELEASE=1` (skip host source build; fetch official musl host), `CODEX_HOST_RELEASE_TAG=rust-v0.145.0` (pin the release when auto-derived tag is wrong).
- **Host source-build fallback:** building `codex-code-mode-host` pulls `v8` with `v8_enable_sandbox`, which often 404s the rusty_v8 prebuilt (`librusty_v8_ptrcomp_sandbox_release_…`). The rebuild script falls back to the matching `openai/codex` GitHub release asset automatically; force that path with `CODEX_HOST_FROM_RELEASE=1`.
- **After rebuilding:** restart Kookr (`pnpm prod:update`) so the new binary is picked up
- **Known gaps in the fork:** plugin marketplace paths and permission logic still reference `.agents` — see [#210](https://github.com/kookr-ai/kookr/issues/210)

## Bypassing agent permission prompts

Set `KOOKR_BYPASS_ALL_PERMISSIONS=true` in `.env` to make Kookr launch spawned agents without any permission prompts:

- **Claude Code:** adds `--dangerously-skip-permissions` AND `--setting-sources ""` to the launch command. The pair is required because user `permissions.ask` rules in `~/.claude/settings.json` would otherwise match before the bypass mode is consulted. Side effect: spawned sessions do not see user-level deny rules or hooks. See `docs/poc/006-bypass-permissions-ask-rule-override.md`.
- **Codex CLI:** replaces `--full-auto` with `--dangerously-bypass-approvals-and-sandbox` (skips approvals AND the sandbox, allowing writes outside the workspace).

Off by default. Opt-in because both flags remove important safety guardrails.

## Production instance

A stable Kookr instance runs from a separate git worktree at `../kookr-prod` on port 4800. It is isolated from this dev checkout — building here does not affect it.

- **All dev commands default to port 4801** (`pnpm dev`, `pnpm start:dev`) — no conflict with production
- **Do not modify `../kookr-prod`** — it is updated explicitly via `pnpm prod:update`. This includes skills, source, docs, and config files. Even if your cwd is `kookr-prod`, edit files in `~/git/kookr` instead. A PreToolUse hook enforces this — if it blocks your edit, switch to the main repo.
- `pnpm prod:update` fetches, builds, and **auto-restarts** the server (kills port 4800, restarts, health-checks)
- `pnpm prod:restart` restarts without rebuilding (uses `lsof` — works on Linux and macOS)
- **When asked to "restart server"** → run `pnpm prod:update` (includes build + restart)
- **Commit and push before `pnpm prod:update`** — the prod worktree pulls from `origin/main`, so uncommitted or unpushed changes will not be deployed
- Tests are safe — they use random ports and temp directories. Git operations in tests MUST target a `mkdtemp` repo (`git -C <tmpdir> …`), never the ambient checkout: worktrees share `.git/config`, so a stray `git config`/`git init` poisons the whole repo's identity or flips `core.bare`. Enforced by the `test/git-repo-guard.ts` vitest globalSetup, which fails the run if the shared config is corrupted.

## When working on this project

- **Never work on `main` without permission** — Do not edit Kookr from the main repo on branch `main` unless the user explicitly approves that exception first.
- **All changes in worktrees** — Always use `EnterWorktree` before making changes. Never switch branches on the main repo. Start by reporting the current branch/worktree and any dirty files in this repo, and keep reporting dirty files for any additional repos you touch. If a worktree with a similar name already exists, ask the user whether to reuse it or create a new one. If you must switch branches on the main repo (edge case), explain why and wait for explicit user approval. See `.claude/skills/github-issue-workflow/SKILL.md` for naming conventions.
- **Use injected Kookr session context** — Kookr-managed agent sessions export `KOOKR_TASK_ID`, `KOOKR_PARENT_TASK_ID` (when present), `KOOKR_API_BASE_URL`, and `KOOKR_GIT_COMMON_DIR` (when in a worktree). Use these instead of dtach/process probing when spawning child tasks or diagnosing worktree behavior.
- **Complete the delivery cycle** — After finishing implementation work, don't end your turn silently. Commit your changes, then — unless the task already told you to deliver — *ask* the user whether to push the branch and open a PR. Make it a question they can answer in one step, not a status report that forces them to start a new turn. If the task did authorize delivery, push and create (or update) the PR proactively, verifying any PR checklist first.
- **Use the delivery-cycle skills explicitly** — Before a non-trivial `git push`, run `kookr-pre-push`. After pushing a branch with a PR, or after creating/updating the PR, run `kookr-post-push`. These skills compose the repo pre-push hook, `pre-pr-review`, `kookr-pr-lifecycle`, and `pr-review-triage` into one flow.
- **Use the efficiency retrofit skill for agent-waste analysis** — When asked to analyze recent Claude Code/Codex CLI conversations for repeated inefficient tool calls, token waste, retry loops, or avoidable errors, load `agent-efficiency-retrofit`; do not rely on a playbook or docs file being discovered by chance.
- **Report completion clearly** — When you finish a task, explicitly state what was done, what was committed/pushed, and the PR URL (if created). Don't leave the user guessing whether you're done or still working. End with a clear status: "Done — PR created at [URL]" or "Done — changes committed and pushed to [branch]".
- **Keep the deliverable inspectable** — Before reporting done on a task that produces a user-visible artifact (running UI, video, generated image/doc, screenshot set), do two things: (1) verify the artifact actually contains what was requested — `ffprobe` audio/video streams, render the page, check file size, open the doc — never trust the build script's exit code as proof of completeness; (2) leave the user a working inspection path — if a dev server is running, leave it running and report the URL; if the artifact is a file, print the absolute path and a one-line verification command. Tearing down the inspection environment before the user has seen the result forces them to ask "where can I see that?" — that's a system failure, not a request.
- Read `docs/features.md` for what to build
- Read `docs/architecture.md` for how
- Before designing any new system, check if aegiscore or openclaw already solved it
- Keep V1-era constraints in mind: single package and local-first. Prefer existing persistence and plugin mechanisms over introducing new surfaces.
- **Verify with real data, don't assume** — Before designing a fix for any behavior bug, find the actual inputs causing the problem (hook logs in `~/.kookr/hooks/*.jsonl`, transcripts, DB records). Reproduce the issue programmatically with real data. Scan broadly to measure real-world frequency of both false-positives and true-positives. The data may reveal the right solution is fundamentally different from what you'd assume.
- **Capitalize on gathered knowledge** — When a research task, POC, or debugging session produces reusable knowledge (how a system works, validated patterns, gotchas), distill it into a skill in `.claude/skills/`. Don't let hard-won insights evaporate with the conversation. If a skill already exists for the topic, update it. If not, create one. The bar is: "would a future agent benefit from knowing this without re-discovering it?"
- **Persistence Mechanism Picker** — When you need to persist anything (a rule, a learning, a correction), consult the picker below **before** choosing where it goes. The system-prompt `# auto memory` section actively trains you toward memory as a default; this section overrides that default for behavioral rules.
- **Load `codex-claude-compatibility` skill before Codex fork work** — Before modifying, building, or deploying `~/git/codex`, load the skill first. It documents the exact build command, install path, version scheme, branch policy, and verification workflow.

- **RFC workflow** — When generating an RFC or design document, follow the iterative review pattern: draft in worktree → run parallel critic subagents → incorporate feedback → repeat (default 3 rounds) → present to user and wait for approval before committing or implementing. See `rfc-iterative-review` skill. The sole exception is `plugin/playbooks/architecture-refactor-rfc.md` when `callerPlaybook: architecture-refactor-rfc.md`, `rfcDeliveryAuthorized: true`, and a readable durable state are all present; that flow follows its exact-head review, exact-head merge, fresh-main reachability, umbrella, and Phase-1 gates without another approval.
- **Technical prose for humans** — PR bodies, changelogs, status updates, and similar summaries follow **Technical writing** below and the distributed `clear-technical-writing` skill. Do not ship telegraphic identifier dumps as the only explanation. Mark `kookr:check:prose` in the PR template; optional second pass via `kookr-toolkit:clear-writing-reviewer`.

## Technical writing (PRs, changelogs, summaries, status updates, and code documentation)

Six weeks from now someone competent — often you, or an agent with no memory
of this session — will open this PR or docstring because something broke.
They will see every identifier and still not know what changed for a human.
That reconstruction is a tax on the *cold reader* — the competent person who
last touched this weeks ago. Pay it once here, while the context is free.
A passage you cannot make clear is usually one you have not finished
understanding.

Applies to **everything you write**, including documentation embedded in code
(docstrings, comments, module/API/reference docs) — not just human-facing
summaries. There is no "internal, so cryptic" tier.

Audience: a competent teammate who last touched this area **weeks ago** — not
the agent that just wrote the code.

**Concise ≠ cryptic.** Cut filler and repetition; do **not** cut cold-reader
explanations. Density is not professionalism.

**Full guide (examples, tables, PR workflow):** plugin skill `clear-technical-writing`. **Reviewer:** `kookr-toolkit:clear-writing-reviewer`.

Always-on rules:

1. **Intent first** — 2–4 plain sentences (1 for tiny fixes): problem, change, why. No function names/constants/paths yet.
2. **Gloss jargon on first use** — short parenthetical for project-specific compounds.
3. **Then technical details** — names, thresholds in words *and* constants, wiring, repo-relative paths.
4. **Verification last** — commands + outcomes.
5. **No stacked density** — one new concept/threshold cluster per sentence; symbol lists only in the technical section.
6. **Self-check** — would a smart engineer cold to this subsystem understand what/why without opening the diff?
7. **Hard ideas** — build the intuition before the formalism; an analogy must carry the real mechanism and say where it breaks (as simple as possible, *but no simpler*). Respect the reader; never talk down.

## KB-First Task Policy

This policy governs knowledge-base lookup. It is separate from the Persistence Mechanism Picker below, which governs where to save new rules, workflow corrections, and context.

Run `kb search "<2-line gist of the task>"` before designing or implementing any task in these classes:

- Non-trivial research, architecture, RFC, issue-synthesis, or requirements work.
- Machine-specific operations, production/deployment work, Kookr runtime behavior, or anything likely to depend on local operating-environment notes.
- Long-running task handoff, crash recovery, or any task expected to cross session boundaries.
- Repeated failures, confusing tool behavior, stale assumptions, or a request that resembles a previous incident.
- Cross-project work where prior decisions may live outside the current repo.

You may skip the KB lookup for purely mechanical edits, direct terminal questions, small known-file changes, or repo-local facts already answered by code search, git history, or the current issue/PR context. If you skip it, say `KB lookup skipped: <reason>` in your working notes or final summary when the task is otherwise non-trivial.

For required lookups, report the result before relying on it:

- `KB hits:` summarize the relevant prior note(s), or say `none`.
- `KB miss:` state that no relevant prior note was found.
- `KB stale warning:` if the CLI reports a stale index, mention it and decide whether `kb search --refresh` is warranted before proceeding.

After finishing a task that produced a generic lesson, append it to `agent-task-lessons` with `kb remember --kb=agent-task-lessons --title="<short headline>" --stdin --yes`. Use the **Mistake / Why it happened / Better next time** shape. Keep this generic: no PR numbers, file paths, branch names, or proper nouns.

### Post-task lesson decision

Before your final answer for any non-trivial task (investigation, debugging, workflow discovery, RFC implementation, ops diagnosis, multi-step feature), make the decision *visible in the Bash hook trail* — silence is indistinguishable from forgetting. Pick exactly one:

- **Wrote a lesson** — run the `kb remember --kb=agent-task-lessons --title="<short headline>" --stdin --yes` command above with the **Mistake / Why it happened / Better next time** body, generic only.
- **Explicit skip** — run `printf 'No generic KB lesson: %s\n' '<one-line reason>'`. Use this when nothing reusably generic came out of the task (purely repo-local fact, already-documented gotcha, follow-up of a prior decision).

**Lifecycle gate (issue #1538 / #1868):** `kookr signal completion-ready` is rejected with HTTP 409 when the task has launched sessions but neither a lesson write nor an explicit skip appears in its hook trail. Code is `lesson_decision_required` when logs exist without a decision, or `lesson_decision_hooks_missing` when every session hook log is absent (pruned/rotated) — both fail-closed. Emit the decision *before* signaling completion-ready. Purely mechanical tasks still need the explicit skip marker if they signal completion-ready — silent no-decision is no longer allowed at the lifecycle boundary. Yield is auditable via `GET /api/diagnostics/lesson-yield?days=N`, the `lessonYield` block on `GET /api/health`, or `kookr lesson yield --days N`.

The `pnpm kb:usage` report classifies tasks by the strongest signal in their hook log — `kb remember` → wrote-lesson, `No generic KB lesson:` → explicit-skip, otherwise search-only or no-kb-activity — so the explicit-skip marker is what turns "no lesson" from a metric blind spot into a counted, reviewable signal.

## Persistence Mechanism Picker

Canonical body: `kookr-toolkit:placement-picker` plugin skill. Stub fallback for sessions without `--plugin-dir`:

| KIND of artifact | s1: me, all projects | s2: this repo | s3: kookr-toolkit users, all repos | s4: kookr-internal only |
|---|---|---|---|---|
| (a) Rule | user CLAUDE.md | project CLAUDE.md | **plugin skill (rule-shaped)** | `<kookr>/.claude/skills/kookr-<n>/` |
| (b) Context | project memory (CC-only) OR user CLAUDE.md (cross-runtime) | project memory OR project CLAUDE.md | n/a | project memory |
| (c) Procedure | user skill | project skill | **plugin skill** | `<kookr>/.claude/skills/kookr-<n>/` |
| (d) Guard | user hook | project hook | **plugin hook + plugin/hooks/hooks.json** | project hook |
| (e) Domain knowledge | KB (`~/knowledge_bases/`) via `kb remember` | repo docs | n/a | repo docs |

**Cross-runtime calibration (rules/procedures/guards only — not context, not domain)**: *"Will this work on Codex CLI tomorrow, in a kookr-toolkit-user's repo, on a different machine?"* If "no" anywhere → reduce scope.

**Memory is BANNED for behavioral rules** — Codex CLI cannot read Claude Code's memory system. Rules go in CLAUDE.md, skill, or hook. Memory is for context (who, why) — never how.

See `kookr-toolkit:placement-picker` skill body for worked examples and anti-patterns.

## Design document conventions

- **ADRs** → `docs/adr/<NNN>-<slug>.md` — accepted architecture decisions (numbered, with README index)
- **POCs** → `docs/poc/<NNN>-<slug>.md` — proof-of-concept validations
- **Reports** → `docs/reports/` — one-time analysis artifacts (gap reports, audits)
- Never put design documents directly in `docs/` — use the appropriate subdirectory
- Core docs in `docs/` root: `architecture.md`, `features.md`, `requirements.md`, `roadmap.md` only
