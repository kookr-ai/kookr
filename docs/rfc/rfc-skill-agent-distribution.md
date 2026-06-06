# RFC: Skill & Agent Distribution Strategy

## Status

**Draft v3.1 — post-round-3 critic review (boundary + socratic fixes)**
**Date:** 2026-05-10
**Author:** Jean Ibarz (with Claude)

**Major revisions in v3.1 (round 3 incorporation):**
- **Env var renamed `KOOKR_CHECKPOINT_DIR` → `TASK_CHECKPOINT_DIR`** in PR2. Round-3 boundary-critic + socratic both flagged the leaky abstraction in a "general" skill body. Verified blast radius: 6 files in PR2 (already touched 3 of them).
- **§G cleanup match tightened** from `startsWith <kookr-prefix>/plugin` to a sentinel-file check (`.claude-plugin/plugin.json#name == "kookr-toolkit"`). Round-3 socratic Q5 found the prefix heuristic too permissive (sibling `kookr-experiments/plugin/` would match).
- **PR1 manual step adds user-scope backup** (`cp -r` to `/tmp/kookr-rfc-backup-…/`) before deletion. Round-3 socratic Q6: PR1 is the largest PR in this RFC; revert recovery needs the user-scope copies if not reachable from git history.

**Major revisions in v3 (round 2 incorporation):**
- **Migration collapsed from 4 PRs to 3.** Round-2 found PR1-as-standalone caused a self-DoS (hook fails on every commit between PR1 and PR2). PR1 (hook) merges with the moves it enforces.
- **Bypass-mode Vitest test cut** — round-2 found the existing test pattern is args-only and wouldn't catch the runtime regression. The structural fix (no project-scope agents) IS the guard. Replaced with a CLAUDE.md invariant note.
- **CI duplicate of placement-gate hook cut** — single-tenant scale has no adversarial-`--no-verify` threat model.
- **`plugin/CHANGELOG.md` cut** — Open Q3 resolved: GitHub release-note one-liner suffices.
- **§G acceptance test trimmed** — cases 3 and 4 (collision-skip variants) cut; they're `lstat` guards, not logic. KOOKR_CODEX_BIN integration test cut — source verification (round-1 design-experimenter) is sufficient.
- **`rfc-iterative-review` reclassified to Bucket 2** — has 11 unqualified `subagent_type` calls; not a mechanical move.
- **Bounded startup sweep added to §G** — failure-mode-analyst flagged the orphan-symlink discoverability gap. `taskStore.getTasks()` already tracks cwd; ~10 lines; cheap.

**v2's substantive structural changes (carried forward):**
- §G as a single dir-symlink overlay (no ledger, no crash recovery, no `.git/info/exclude` patching). Verified via Codex `loader.rs:479–487` + existing test `loads_skills_via_symlinked_subdir_for_repo_scope`.
- §C drops the env-var fallback chain (one var, `KOOKR_CHECKPOINT_DIR`) and renames `oss-task-checkpointing` → `task-checkpointing`.
- Open Q2 falsified: unqualified `subagent_type` does NOT resolve. All callers rewritten in the move PR.

---

## Problem

Skills and agents that Kookr produces or curates live in **five** locations with inconsistent naming, partial duplication, and **three** distribution mechanisms. The stated goal — *"any project that opts in should see the same skills and agents that Kookr's own dev sessions use"* — is not achievable today without manual symlinks or path-specific knowledge.

Concretely, today the maintainer has shipped what is supposed to be the same `oss-task-checkpointing` skill three different ways (project-scope, user-scope, plugin), the canonical version is silently shadowed by a stale user-scope copy, and `oss-issue-scout` exists as both a project skill *and* a project agent that the bypass-mode flag transparently drops.

## Empirical grounding (current state, 2026-05-10)

### Inventory

| Location | Loaded when | Count | Naming | Notes |
|---|---|---|---|---|
| `<kookr>/.claude/skills/` | cwd is the kookr repo | 24 | mixed (`kookr-*` for 12; **unprefixed for 12**: `oss-issue-scout`, `pr-lifecycle`, `rfc-iterative-review`, `oss-task-checkpointing`, `oss-repo-recon`, `mbse-system-modeling`, `post-push`, `pre-push`, `pre-pr-review`, `self-reflect`, `session-reflect`, `github-labels`) | The naming-convention skill says kookr-internal **MUST** be `kookr-*`. 50% of entries violate the rule. |
| `<kookr>/.claude/agents/` | cwd is kookr repo, **NOT** bypass mode | 1 (`oss-issue-scout.md`) | unprefixed | Duplicates `<kookr>/.claude/skills/oss-issue-scout/`. Bypass mode (`KOOKR_BYPASS_ALL_PERMISSIONS=true`) silently strips `--setting-sources` and this agent disappears (per `project_kookr_bypass_strips_file_agents`). |
| `<kookr>/plugin/skills/` | plugin installed OR `--plugin-dir` injected | 48 | `kookr-toolkit:*` namespace | Ships via the marketplace; the `ClaudeCodeAdapter` injects `--plugin-dir <kookr>/plugin` into every spawned `claude` (`src/adapters/claude-code-adapter.ts:225`). |
| `<kookr>/plugin/agents/` | same as above | 17 | `kookr-toolkit:*` | Same shipping path as plugin skills. |
| `~/.claude/skills/` | every session for this user | 8 (`oss-task-checkpointing`, `pre-pr-review`, `pr-contribution-excellence`, `playwright-video-verification`, `ui-visual-verification`, `knowledge-base`, `graphify`, `local-research-agent`) | unprefixed | Three of these silently shadow kookr-shipped copies (user-scope wins on collision). |
| `~/.claude/agents/` | every session for this user | 1 (`kb-scout.md`) | unprefixed | Personal-deps agent (uses `~/knowledge_bases/`, `bin/kb`). |

### Distribution paths today

1. **Kookr's own dev sessions** — see `<kookr>/.claude/*` + user-scope `~/.claude/*` + (when adapter resolves it) `--plugin-dir <kookr>/plugin`.
2. **Other developers in their own repos** — see the `kookr-toolkit` plugin (namespaced as `kookr-toolkit:*`) once they install via the marketplace.
3. **Kookr-spawned agents in any repo** — see the plugin via `--plugin-dir` injection (auto-resolved or `KOOKR_PLUGIN_DIR`); see project-scope `<cwd>/.claude/*` of the spawned-into repo (which is *not* Kookr's `.claude/`).
4. **Kookr-spawned agents in bypass mode** — same as (3) **minus** project-scope agents, because `--setting-sources ""` is added.
5. **Codex CLI sessions** — read `<spawned-cwd>/.claude/skills/` (per the kookr Codex fork) and **not** `--plugin-dir` (Codex doesn't accept that flag). Plugin skills are invisible to Codex.

### Concrete problems

1. **Three duplicates that already exist.**
   - `oss-issue-scout` is a project skill **and** a project agent.
   - `oss-task-checkpointing` and `pre-pr-review` exist as project skills (kookr) **and** user-scope skills.
   - `pr-contribution-excellence` exists as a user-scope skill **and** a plugin skill.
2. **12 of 24 `<kookr>/.claude/skills/` directories violate the documented `kookr-*` naming rule.** Most of those are distributed skills that should have moved to `plugin/skills/` long ago.
3. **User-scope shadows kill the kookr copy silently.** `<kookr>/.claude/skills/oss-task-checkpointing/` is dead code on the maintainer's machine but lives on for other contributors who don't have the user-scope shadow — guaranteeing version drift.
4. **Bypass mode loses agents.** Any project-scope agent disappears when `KOOKR_BYPASS_ALL_PERMISSIONS=true`, breaking parity between normal and bypass spawns.
5. **The `kookr-toolkit:` namespace is visible but the unqualified name is documented as backward-compatible** — that backward-compat hasn't been spike-tested for the skills that are about to move from project-scope to plugin-scope.
6. **Codex sessions see nothing kookr-curated.** Skills only ship via `--plugin-dir`, which Codex ignores. This is unaddressed today.

## Goals

1. **One canonical home** for every skill and agent.
2. **A single shipping mechanism** for "any project that wants Kookr's curated toolkit."
3. **No silent shadowing** — never two same-named artifacts that both load.
4. **Bypass-mode parity** — agents that load in normal kookr-spawn mode also load in bypass mode.
5. **No regression in invocation backward-compat** — existing prompts that say `typescript-type-safety` continue to resolve once the skill is namespaced.

## Non-goals

- Changing how skills are *authored* (the `SKILL.md` format and frontmatter stay).
- Replacing the plugin-marketplace mechanism with something custom.
- Distributing the maintainer's personal-only skills (`kb-scout`, `knowledge-base`, `graphify`, `local-research-agent`, `ui-visual-verification`, `playwright-video-verification`) to other developers — those have personal runtime deps and stay user-scope (see `feedback_user_scope_when_deps_personal`).

## Design principles

1. **Two homes, not five.** Every Kookr-managed skill or agent is either *repo-local* (loads only in the kookr repo) or *distributed* (ships via the toolkit plugin, whether reached by Kookr injection, marketplace install, or local sync).
2. **No project-scope agents.** All agents go in the plugin. Eliminates the bypass-mode silent drop.
3. **The plugin is the only ship surface.** No skills get distributed via copy/symlink/user-scope from this repo.
4. **User-scope is for personal deps Kookr does not own.** Stay out of `~/.claude/skills/*` and `~/.claude/agents/*` unless the artifact has runtime deps that can't be vendored.

## Design

### A. Two-home model (mandatory)

```
<kookr>/
├── .claude/
│   └── skills/              ← Kookr repo-local only. Names MUST start with `kookr-`.
│   (no agents/ subdirectory — moved to plugin/agents/)
└── plugin/
    ├── .claude-plugin/plugin.json
    ├── skills/              ← Distributed skills, including Kookr-runtime and general skills.
    └── agents/              ← Distributed agents. Namespaced as `kookr-toolkit:*`.
```

Rules:

- A skill whose natural cwd is the Kookr repository, such as editing Kookr
  source, tests, hooks, build/release scripts, or repo-local architecture docs
  → `<kookr>/.claude/skills/kookr-<name>/`.
- A skill that an agent needs while working outside the Kookr repository
  → `<kookr>/plugin/skills/<name>/`. This includes Kookr runtime operations
  such as `kookr-spawn`, task supervision, and CLI/API usage. The agent may get
  the skill through Kookr's `--plugin-dir` injection, marketplace plugin
  installation, or local sync/symlink setup.
- All agents → `<kookr>/plugin/agents/<name>.md`. No project-scope agents.

### B. Eliminate duplicates (one-time cleanup)

| Path today | Action |
|---|---|
| `<kookr>/.claude/agents/oss-issue-scout.md` | DELETE. The skill at `<kookr>/.claude/skills/oss-issue-scout/` is the canonical version. (Re-classify and move to `plugin/skills/` per §C.) |
| `~/.claude/skills/oss-task-checkpointing/` | DELETE (user-scope shadow). After §C the kookr copy lives at `<kookr>/plugin/skills/oss-task-checkpointing/`. |
| `~/.claude/skills/pre-pr-review/` | Same. |
| `~/.claude/skills/pr-contribution-excellence/` | DELETE; canonical copy is in `<kookr>/plugin/skills/`. |
| `~/.claude/skills/{ui-visual-verification, playwright-video-verification, knowledge-base, graphify, local-research-agent}/` | KEEP. Personal deps, outside this RFC. |
| `~/.claude/agents/kb-scout.md` | KEEP. Personal-deps agent. |

### C. Reclassify the 12 unprefixed `<kookr>/.claude/skills/` entries

Per the kookr-internal test in `kookr-skill-naming-convention/SKILL.md`, all 12 are general-purpose. Two distinct buckets after empirical findings:

**Bucket 1 — straight `git mv` (9 skills):** `mbse-system-modeling`, `oss-issue-scout`, `oss-repo-recon`, `pre-push`, `post-push`, `pr-lifecycle`, `self-reflect`, `session-reflect`, `github-labels`. Mechanical move; the skill body and frontmatter `name:` are untouched.

**Bucket 2 — content edit + rename + cross-file update (3 skills):**

- **`pre-pr-review`** — body contains 2 unqualified `Agent({subagent_type: "..."})` references (`state-machine-verifier`, `failure-mode-analyst`). Rewrite to `kookr-toolkit:state-machine-verifier` etc. **in the same commit** as the `git mv`. Empirical probe round 1 confirms unqualified resolution fails (`Agent type 'X' not found`).
- **`rfc-iterative-review`** — body contains 11 unqualified `Agent({subagent_type: "..."})` references (the full critic-subagent table). Not a mechanical move; rewrite all 11 to `kookr-toolkit:<name>` in the same commit as the `git mv`. Round-2 delivery-pragmatist correctly flagged that v2's "fold into PR2A if review burden is manageable" parenthetical was unsafe — moved unconditionally to Bucket 2.
- **`oss-task-checkpointing` → `task-checkpointing`** — promote and **rename**. Justification: the skill is general (long-running tasks of any kind that benefit from periodic semantic checkpoints; the OSS-bug-fix-with-video-proof workflow is one use case, not the definition). The `oss-` prefix is misleading. Verified blast radius is **2 files**:
  - `<kookr>/src/core/checkpoint-path.ts:161` — `CHECKPOINT_LOAD_INSTRUCTION` cites the skill name.
  - `<kookr>/CLAUDE.md` — references the skill name in checkpoint-protocol guidance.

  No other repo references found. Update both atomically with the rename.

  Env-var: **rename `KOOKR_CHECKPOINT_DIR` → `TASK_CHECKPOINT_DIR`** (round-3 boundary-critic + socratic agreement: a "general" skill body referencing a `KOOKR_*`-prefixed env var is a leaky abstraction; the rename's blast radius is the same files PR2 already edits). Verified blast radius is **6 files**: `src/adapters/agent-launch-context.ts`, `src/adapters/claude-code-adapter.ts` (comment), `src/core/checkpoint-cycler.ts`, `src/core/checkpoint-path.ts`, the skill body itself, and `docs/reference/environment-variables.md`. All edited atomically in PR2.

  v1 of this RFC proposed a fallback chain (`TASK_CHECKPOINT_DIR` → `KOOKR_CHECKPOINT_DIR` → default); v2 dropped it (one var only) but kept `KOOKR_CHECKPOINT_DIR`. v3 picks `TASK_CHECKPOINT_DIR` outright — single var, no fallback chain, name matches the protocol's ownership. The skill body documents: *"this protocol uses `TASK_CHECKPOINT_DIR`. Kookr's `ClaudeCodeAdapter` injects it; any other caller wishing to use the protocol sets the same var."*
  Body wording: replace "Kookr checkpoint protocol" with "Long-task checkpoint protocol"; cite Kookr only as one supported caller.
  Schema names (`semantic-checkpoint.v1`, `memory-write-candidates.v1`) stay — already Kookr-neutral.

**Mandatory pre-move scan for every skill in either bucket** (per round-1 empirical finding):

```bash
grep -lEr 'subagent_type[^a-z]+("|'"'"')(boundary-critic|failure-mode-analyst|design-minimalist|socratic-challenger|ambition-amplifier|assumption-archaeologist|delivery-pragmatist|design-experimenter|module-interface-auditor|operability-reviewer|state-machine-verifier|api-surface-auditor|architecture-drift-detector|architecture-smell-scanner|dependency-graph-analyzer|test-fixer|test-quality-reviewer|oss-issue-scout)' .claude/skills/<name>/
```

Replace every match with the qualified `kookr-toolkit:<name>` form. The `rfc-iterative-review` skill alone has 11 such references — round 1 found these explicitly. Same scan + rewrite applies to `<kookr>/.claude/playbooks/oss-contribute.md` (which calls `oss-issue-scout` as `subagent_type` at line 76).

Bucket 1 + Bucket 2 (`pre-pr-review` and `rfc-iterative-review`) ship in PR1 (the combined moves+hook PR — see Migration sequencing). Bucket 2's `task-checkpointing` rename ships in PR2 because it requires an atomic edit to TypeScript source (`checkpoint-path.ts`), which is a different review surface than skill body rewrites.

### D. Stop using project-scope agents

- Move any unique content from `<kookr>/.claude/agents/oss-issue-scout.md` into the skill body if it adds anything (it likely does not — the agent file appears to be a near-duplicate). **Do not delete the agent file** until **all** unqualified `subagent_type` callers have been rewritten to `kookr-toolkit:oss-issue-scout`. Verified callers (round 1):
  - `<kookr>/.claude/playbooks/oss-contribute.md:76`
  - test fixtures in `<kookr>/src/adapters/file-based-agents.test.ts` (preserve fixture intent — those tests assert agent loading; update to use a synthetic agent name, not `oss-issue-scout`).
- Confirm `<kookr>/.claude/agents/` is empty.
- Document in `CLAUDE.md`: *no project-scope agents — all agents in `plugin/agents/`.* This is the structural invariant — bypass mode can only drop agents that exist; with none in `<kookr>/.claude/agents/`, the regression has no vector.

The bypass-mode regression vanishes (no project-scope agents to drop). v2 added a Vitest acceptance test for this; round-2 found the test would be args-only (matching existing test patterns) and would not catch the runtime regression. Test cut. The structural fix IS the guard.

### E. Lock the convention with a hook

Extend the existing `pr-workflow-gate.sh` (or add `<kookr>/hooks/skill-placement-gate.sh`) to fail on:

- Any directory under `<kookr>/.claude/skills/` whose name doesn't start with `kookr-`.
- Any non-empty `<kookr>/.claude/agents/` directory.
- Any name collision between `<kookr>/.claude/skills/` and `<kookr>/plugin/skills/`.
- Any new directory under `<kookr>/plugin/skills/` whose name starts with `kookr-`.
- Any unqualified `subagent_type` reference (one of the known agent names) inside `.claude/skills/` or `plugin/skills/`. Catches the round-1 empirical breakage class.

Cover with a fixture-based test under `<kookr>/.claude/hooks-tests/skill-placement-gate.test.sh`.

The hook lands in PR1 *together with* the moves it enforces (round-2 fix — a standalone hook PR would fail closed on every commit until all moves landed). v2 also proposed a CI duplicate to counter `--no-verify`; round-2 design-minimalist correctly noted there's no adversarial-`--no-verify` threat at single-tenant scale. Cut.

### F. Keep `--plugin-dir` injection as the single shipping mechanism for Claude Code

No changes to `ClaudeCodeAdapter.resolvePluginDir()`. Other developers continue to install via the marketplace. The maintainer's `pnpm prod:*` deploy already picks the new layout up because it reads from the same git tree.

### G. Resolve Codex CLI's blind spot — single dir-symlink overlay

Codex doesn't accept `--plugin-dir` and reads `<cwd>/.claude/skills/` per launched task. The kookr Codex fork already has compatibility gaps tracked in #210; adding more fork divergence now is undesirable.

**v1 of this RFC** proposed a per-task symlink ledger with crash recovery, atomicity guarantees, concurrency races, and `.git/info/exclude` patching — round-1 design-minimalist correctly identified this as over-engineered for single-tenant ≤1000-task scale, and round-1 failure-mode-analyst found a data-loss path through the cleanup logic when `<cwd>/.claude/skills/` is itself a symlink. v2 replaces it with a **single dir-symlink overlay**.

**Mechanism.** Before launching codex, `CodexCliAdapter.launch()` runs:

```
if not exists <cwd>/.claude/skills:
    ln -s <kookr>/plugin/skills <cwd>/.claude/skills
if not exists <cwd>/.claude/agents:
    ln -s <kookr>/plugin/agents <cwd>/.claude/agents
```

Two filesystem operations per launch (one `lstat` + one `ln -s` per dir). Codex source `core-skills/src/loader.rs:479–487` uses `metadata().is_directory()` (which follows symlinks) to accept the root, and the existing test `loads_skills_via_symlinked_subdir_for_repo_scope` covers symlink traversal — verified empirically in round-1 design-experimenter.

**Collision rule.** If `<cwd>/.claude/skills/` already exists as a real dir, file, or symlink-to-anything-else → **skip the overlay for that path**. Log one line. The user's project-scope artifacts win unchanged. Same for agents. Use `lstat` (not `stat`) — never resolve through a symlink before deciding (counters round-1 failure-mode case #4 where descending into a user-symlinked skills dir could touch unrelated trees).

**Cleanup.** On task end:

```
if <cwd>/.claude/skills is a symlink AND <target>/../.claude-plugin/plugin.json exists
   AND that plugin.json's "name" field == "kookr-toolkit":
    unlink <cwd>/.claude/skills
# same for /.claude/agents
# remove .claude/ if now empty AND we created it
```

Two `lstat` + `readlink` + 1 `readFile` per overlay. No per-task ledger. The match is **sentinel-file-based** — the symlink target's parent must contain a `.claude-plugin/plugin.json` declaring itself as `kookr-toolkit`. Round-3 socratic flagged that v2's `startsWith <kookr-prefix>/plugin` heuristic was too permissive (a sibling `kookr-experiments/plugin/` would match). The sentinel check is unfalsifiable by accident — only a deliberately-named plugin manifest would collide.

The sentinel approach is also resilient to kookr install path mutation (round-2 failure-mode case #1): the cleanup doesn't care WHERE the plugin lives, only that the target IS the kookr-toolkit plugin.

**Bounded startup sweep (round-2 addition).** On Kookr server start, walk `taskStore.getTasks()` and run cleanup against every cwd whose task is no longer running. ~10 lines; closes the orphan-symlink class without reintroducing the v1 ledger. Path-mutation cases (cwd no longer in `taskStore` at all — e.g., the user deleted that repo) fall through to the manual escape hatch:

```bash
# Documented in CLAUDE.md as the escape hatch:
find <some-repo> -maxdepth 3 -lname '*kookr*plugin*' -delete
```

**Concurrency.** Two simultaneous Kookr tasks on the same cwd → both try the same symlinks. The second `ln -s` either succeeds (race winner first) or returns `EEXIST` (race loser); on `EEXIST`, `readlink` and accept if the target matches. Different `pluginDir` between two simultaneous tasks → cannot occur in current Kookr (`pluginDir` is resolved once at adapter construction, shared across all launches in a server lifetime).

**Working-tree pollution.** During a Codex task, `git status` in the user's repo shows `.claude/skills` and `.claude/agents` as untracked. v1 proposed patching `.git/info/exclude` to suppress this. v2 drops the patch — round-1 found two failure modes (exclude file absent in worktree/sparse setups; revert failing to run on crash leaving phantom lines) and design-minimalist judged the cosmetic benefit not worth the new failure modes. **Document in CLAUDE.md instead:** *"Codex tasks add `.claude/skills` and `.claude/agents` symlinks to the cwd for the task duration. Don't `git add -A` while a Codex task is running."*

**Asymmetry with ClaudeCodeAdapter is intentional.** ClaudeCodeAdapter uses `--plugin-dir` (no filesystem mutation in user repos). CodexCliAdapter uses dir-symlinks (filesystem mutation). The two will become symmetric once Codex fork issue #210 lands a `--plugin-dir`-equivalent flag. No `PluginOverlayProvider` interface — round 1's ambition-amplifier proposed one, but at 5 lines per adapter the abstraction would cost more than it saves. The future deletion of the symlink path is a single `git revert`-shaped change, traceable via this RFC.

**Acceptance criterion.** A Vitest case in `<kookr>/src/adapters/codex-cli-adapter.test.ts` asserts:
1. After `launch()` against a tmp cwd, `.claude/skills` is a symlink to the configured plugin tree.
2. After task end, both symlinks are gone.

Round-2 design-minimalist trimmed v2's cases 3 (real-dir-skipped) and 4 (foreign-symlink-skipped) — those are `lstat` guards, not behavior, and testing them costs a mock filesystem. v2 also proposed a `KOOKR_CODEX_BIN`-gated integration test; round-2 cut it because round-1 design-experimenter already verified Codex's symlink behavior via source inspection of `loader.rs:479–487` plus the existing test `loads_skills_via_symlinked_subdir_for_repo_scope`. A test that skips silently in CI is not a test.

Why **(3)** (vendor as `~/.codex/skills/`) is still rejected: requires Codex fork support for that path, pollutes user-scope across all Codex sessions (including non-Kookr ones).

## Files to change

PR1 (combined moves + hook):
- `<kookr>/CLAUDE.md` — rewrite the *Where to put a new skill or agent* section: remove project-scope-agent guidance, remove the unprefixed-allowlist, restate the two-home rule. Add the slash-command backward-compat narrowing (round-1 finding: only natural-language prompts resolve unqualified; slash commands and `subagent_type` calls require the qualified form). Add the §G escape-hatch `find` command. Add the "no project-scope agents" invariant.
- `<kookr>/.claude/skills/kookr-skill-naming-convention/SKILL.md` — extend to cover agents, cite the new pre-push hook, add the unqualified-`subagent_type` rewrite rule.
- `<kookr>/hooks/skill-placement-gate.sh` — new hook (or extension of `pr-workflow-gate.sh`).
- `<kookr>/.claude/hooks-tests/skill-placement-gate.test.sh` — test fixtures.
- 9 `git mv .claude/skills/<name> plugin/skills/<name>` operations (Bucket 1: `mbse-system-modeling`, `oss-issue-scout`, `oss-repo-recon`, `pre-push`, `post-push`, `pr-lifecycle`, `self-reflect`, `session-reflect`, `github-labels`).
- `git mv .claude/skills/pre-pr-review plugin/skills/pre-pr-review` + 2 unqualified `subagent_type` rewrites in the same commit.
- `git mv .claude/skills/rfc-iterative-review plugin/skills/rfc-iterative-review` + 11 unqualified `subagent_type` rewrites in the same commit.
- `<kookr>/plugin/.claude-plugin/plugin.json` — version bump to **0.4.0**.

PR2 (`task-checkpointing` rename + env-var rename — atomic with TS source):
- `git mv .claude/skills/oss-task-checkpointing plugin/skills/task-checkpointing` + body rewrite (Kookr-neutral wording, env var rename).
- `<kookr>/src/adapters/agent-launch-context.ts` — `env.KOOKR_CHECKPOINT_DIR` → `env.TASK_CHECKPOINT_DIR`.
- `<kookr>/src/adapters/claude-code-adapter.ts` — comment update.
- `<kookr>/src/core/checkpoint-cycler.ts` — prompt string `$KOOKR_CHECKPOINT_DIR` → `$TASK_CHECKPOINT_DIR`.
- `<kookr>/src/core/checkpoint-path.ts` — `CHECKPOINT_LOAD_INSTRUCTION` cites new skill name and new env var.
- `<kookr>/CLAUDE.md` — update skill-name and env-var references.
- `<kookr>/docs/reference/environment-variables.md` — rename row.
- `<kookr>/plugin/.claude-plugin/plugin.json` — bump to 0.4.1.

PR3 (project-agent deletion):
- `<kookr>/.claude/playbooks/oss-contribute.md` — rewrite `subagent_type: "oss-issue-scout"` → `"kookr-toolkit:oss-issue-scout"`.
- `<kookr>/src/adapters/file-based-agents.test.ts` — replace `oss-issue-scout` fixture with a synthetic agent name.
- `<kookr>/.claude/agents/oss-issue-scout.md` — delete.

PR4 (Codex overlay):
- `<kookr>/src/adapters/codex-cli-adapter.ts` — single dir-symlink overlay logic on launch + cleanup on task end + bounded startup sweep against `taskStore.getTasks()` cwds. ~40 lines.
- `<kookr>/src/adapters/codex-cli-adapter.test.ts` — new tests for §G cases 1 and 2 (overlay created; cleanup).

Out-of-repo manual step (post-PR1 merge):
- 4 deletions in `~/.claude/skills/` (`oss-task-checkpointing`, `pre-pr-review`, `pr-contribution-excellence`, and any other shadowed names that show up at audit time). Documented in PR1 release notes.

## Edge cases

1. **Backward-compat is narrower than v1 claimed (round-1 empirical).** Plugin skill invocation is backward-compatible only for *natural-language* prompts ("use the `task-checkpointing` skill" → model maps to `kookr-toolkit:task-checkpointing`). Slash commands (`/pre-push`) and Skill-tool calls require the qualified form. CLAUDE.md and any documentation citing `/<skill-name>` invocations must be updated.
2. **Unqualified `subagent_type` does NOT resolve (round-1 empirical, FALSIFIED).** `Agent({subagent_type: "boundary-critic"})` returns `Agent type 'X' not found` against the namespaced plugin agent. All callers must use the qualified `kookr-toolkit:<name>` form. The `rfc-iterative-review` skill alone has 11 such references; `pre-pr-review` has 2; `oss-contribute.md` playbook has 1. Migration includes the rewrite — see §C.
3. **Cleanup must use `lstat`, never `stat`.** Round-1 found a data-loss path: if `<cwd>/.claude/skills/` is itself a symlink, `stat()` resolves through it and operations could touch unrelated trees. §G mandates `lstat` + exact-target-match before any `unlink`.
4. **Frontmatter `name` may not match the directory.** Some SKILL.md files have a `name:` field that may differ from the directory name. The directory drives invocation, not the frontmatter — align them during the move.
5. **`kookr-` prefix on plugin entries.** `<kookr>/plugin/skills/` never contains anything starting with `kookr-`. Audit confirmed (2026-05-10). Hook + CI gate keep it that way.
6. **Personal user-scope skills** (`kb-scout`, `knowledge-base`, etc.) — out of scope. The "no silent shadowing" goal does NOT extend to personal-deps user-scope skills (they're outside Kookr's distribution surface).
7. **`pr-contribution-excellence` body diff before delete.** Run `diff -r ~/.claude/skills/pr-contribution-excellence/ <kookr>/plugin/skills/pr-contribution-excellence/` and reconcile any drift before §B deletion. Round-1 flagged "verify bodies are identical" as ambiguous — make it `diff -r` exactly.

## Alternatives considered

### Alt 1 — Single home: everything in `plugin/`

Every consumer (including Kookr's own dev sessions) sees the same set, kookr-internal or not.

**Why rejected:** kookr-internal skills are useless and noisy in other repos. `kookr-supervise-tasks` describes Kookr supervisor concepts — surfacing it in `~/git/anomalyco` clutters `/skills` output and risks misuse on a non-Kookr codebase. The two-home model preserves cleanliness.

### Alt 2 — Split the toolkit into multiple plugins (`kookr-toolkit-core`, `kookr-toolkit-oss`, `kookr-toolkit-review`)

Each consumer chooses what to install.

**Why rejected:** combinatorial complexity for ~65 artifacts. Today's "one toolkit, install once" UX is cleaner. Revisit if the toolkit grows past ~150 artifacts or if a real consumer asks.

### Alt 3 — Stop using `.claude/skills/` entirely; vendor kookr-internal guidance inline in `CLAUDE.md`

No project-scope skills.

**Why rejected:** skills have keyword-based discovery and frontmatter triggering that `CLAUDE.md` inline instructions don't. Some kookr-internal skills (`kookr-spawn-child-task`, `kookr-supervise-tasks`) carry hundreds of lines of decision logic that would bloat `CLAUDE.md` and lose triggering precision.

### Alt 4 — Symlink `<kookr>/plugin/skills/` into `~/.claude/skills/` at install time

Hijack user-scope as the distribution channel.

**Why rejected:** violates user-scope as user-owned. The "user-scope wins on collision" rule then makes Kookr's plugin invisible if the user already has a same-named skill — silent regression with no diagnostic.

## Open questions

*(none — all questions raised across rounds 1–3 are resolved or rejected with reasons.)*

## Resolved (rounds 1–2)

**Round 2:**
- **CHANGELOG / marketplace migration guidance.** GitHub release-note one-liner suffices; no `plugin/CHANGELOG.md` file. (design-minimalist; resolves former Open Q3.)
- **Atomicity of `task-checkpointing` rename across in-flight tasks.** Not load-bearing: checkpoint files are versioned by `semantic-checkpoint.v1` and resumed tasks read their own checkpoint regardless of skill name. The skill name in `CHECKPOINT_LOAD_INSTRUCTION` is documentation, not a join key. (Resolves former Open Q4.)
- **Versioning cadence.** No-content-change `git mv` counts as a version-bump (installed users gain a new skill). Confirmed; resolves former Open Q1.
- **PR1 self-DoS.** Hook ships with the moves it enforces. v2's standalone-PR1 framing dropped.
- **CI duplicate of placement-gate hook.** Cut. Single-tenant scale has no `--no-verify` adversary.
- **Bypass-mode test.** Cut. Args-only test pattern wouldn't catch the runtime regression; structural fix (no project-scope agents) is the actual guard. Documented as a CLAUDE.md invariant.
- **§G test cases 3 and 4.** Cut. Collision-skip cases are `lstat` guards, not behavior worth a mock-filesystem fixture.
- **§G `KOOKR_CODEX_BIN` integration test.** Cut. Source verification (round-1 design-experimenter on `loader.rs:479–487`) is sufficient evidence.
- **Path-mutation case** (kookr install moves between launch and cleanup). Cleanup uses `startsWith <kookr-prefix>/plugin` rather than exact-target match. Bounded startup sweep against `taskStore.getTasks()` cwds catches the rest. Manual `find` is the documented fallback.

**Round 1 + empirical checkpoint:**

- **Codex skill loading (§G).** Single dir-symlink overlay in `CodexCliAdapter`. Round-1 found v1's per-task ledger over-engineered (design-minimalist) and dangerous (failure-mode-analyst case 4). Empirical probe of Codex source `loader.rs:479–487` + test `loads_skills_via_symlinked_subdir_for_repo_scope` confirms dir-symlinks are followed. Long-term path remains option (1) once #210 unblocks.
- **`oss-task-checkpointing` classification + rename (§C).** General-purpose. Promote AND rename to `task-checkpointing` in the same PR — verified blast radius is 2 files (`CHECKPOINT_LOAD_INSTRUCTION` + CLAUDE.md). v1's deferral was unjustified once the blast radius was empirically measured.
- **Env-var fallback chain.** Dropped. One canonical name (`KOOKR_CHECKPOINT_DIR`) per design-minimalist + failure-mode-analyst. The skill body documents it as the protocol's required input; Kookr happens to be the dominant injector.
- **Subagent unqualified-name compat.** **Falsified empirically.** `Agent({subagent_type: "X"})` requires the qualified `kookr-toolkit:X` form. All callers must be rewritten in the same PR as the move/delete.
- **Slash-command and Skill-tool unqualified compat.** **Partial.** Natural-language model-mapping works; programmatic forms require the qualified name. CLAUDE.md narrows the claim accordingly.
- **`PluginOverlayProvider` interface (ambition-amplifier proposal).** Rejected. With §G simplified to ~30 lines, the abstraction costs more than it saves. Future symmetry restoration via Codex `--plugin-dir` is a single revert-shaped change.
- **`.git/info/exclude` patching.** Dropped. Cosmetic benefit not worth the new failure modes (round-1 failure-mode-analyst case 6/7).

## Migration sequencing

Round-2 collapsed v2's 4-PR plan into **3 PRs**. v2's standalone hook PR caused a self-DoS (every commit between hook-merge and moves-merge would fail closed). v3 ships the hook with the moves.

**PR1 — Combined moves + hook + plugin v0.4.0**
- `hooks/skill-placement-gate.sh` + fixture tests.
- 9 Bucket 1 `git mv`s (mechanical).
- 2 Bucket 2 `git mv`s + body rewrites: `pre-pr-review` (2 unqualified `subagent_type` calls), `rfc-iterative-review` (11 calls).
- `plugin.json#version` 0.3.1 → 0.4.0.
- CLAUDE.md + naming-convention skill updated.

**PR2 — `task-checkpointing` rename (atomic with TS source)**
- `git mv oss-task-checkpointing → task-checkpointing` + body rewrite.
- `src/core/checkpoint-path.ts` `CHECKPOINT_LOAD_INSTRUCTION` updated.
- CLAUDE.md updated.
- `plugin.json#version` → 0.4.1.

**PR3 — Project-agent deletion + playbook rewrite**
- Playbook caller rewritten.
- `file-based-agents.test.ts` fixture renamed.
- `.claude/agents/oss-issue-scout.md` deleted.

**PR4 — Codex overlay** (separate; gated on PR1–PR3 stability, can land in parallel with PR3)
- `codex-cli-adapter.ts` overlay logic + bounded startup sweep.
- `codex-cli-adapter.test.ts` cases 1 and 2.

**Manual post-PR1 step:** delete the 4 user-scope shadow skills from `~/.claude/skills/`. Documented in PR1 release notes:
```bash
# Backup first (round-3 socratic — PR1 is the largest PR in this RFC; revert recovery needs the user-scope copies if they aren't reachable from git history).
mkdir -p /tmp/kookr-rfc-backup-$(date +%s) && cp -r ~/.claude/skills/{oss-task-checkpointing,pre-pr-review,pr-contribution-excellence} /tmp/kookr-rfc-backup-$(date +%s)/
rm -rf ~/.claude/skills/{oss-task-checkpointing,pre-pr-review,pr-contribution-excellence}
# Restart Kookr server; confirm skills resolve via natural-language invocations to kookr-toolkit:*.
```
After PR2 ships, also delete `~/.claude/skills/oss-task-checkpointing/` if any local re-creation happened (defensive).

**Rollback procedure:**
- PR1 revert: `git revert`. Restores project-scope copies. Plugin v0.4.0 republished as v0.4.0.1 (or pin marketplace consumers to 0.3.1 via release-notes guidance until the revert ships). User-scope deletions are irreversible without backup; surface this in release notes.
- PR2 revert: restores `oss-task-checkpointing` everywhere. Same `CHECKPOINT_LOAD_INSTRUCTION` reverts atomically.
- PR3 revert: restores the project-scope agent file; bypass-mode regression returns. Playbook callers already on the qualified form so they keep working either way.
- PR4 revert: pure code revert. Bounded startup sweep no longer runs, so any in-flight overlay symlinks must be manually removed:
  ```bash
  find <some-repo> -maxdepth 3 -lname '*kookr*plugin*' -delete
  ```
  The user knows which repos had Codex tasks because those cwds appear in `taskStore` history (Kookr's own database).

## Acceptance / done

- `<kookr>/.claude/agents/` is empty (PR3).
- Every directory in `<kookr>/.claude/skills/` starts with `kookr-` (PR1).
- No name collision between `<kookr>/.claude/skills/` and `<kookr>/plugin/skills/` (PR1).
- `<kookr>/hooks/skill-placement-gate.sh` enforces placement and unqualified-`subagent_type` rules on push (PR1).
- All previously-unqualified `subagent_type` callers rewritten to `kookr-toolkit:<name>` (verified by `grep` returning empty for the agent-name set inside `.claude/skills/` and `.claude/playbooks/`) (PR1 + PR3).
- 4 user-scope shadow skills removed from `~/.claude/skills/` (manual; documented in PR1 release notes).
- `CLAUDE.md` reflects: two-home rule, no project-scope agents, narrowed slash-command backward-compat, `task-checkpointing` rename, §G escape-hatch `find` command (PR1 + PR2).
- `kookr-skill-naming-convention/SKILL.md` reflects the new layout including the unqualified-`subagent_type` rewrite rule (PR1).
- `src/core/checkpoint-path.ts` `CHECKPOINT_LOAD_INSTRUCTION` cites `task-checkpointing` (PR2).
- `plugin/.claude-plugin/plugin.json#version` is **0.4.1** after PR2 (0.4.0 after PR1).
- Vitest cases in `codex-cli-adapter.test.ts` cover §G cases 1 (overlay created) and 2 (cleanup) (PR4).

## Critic feedback incorporated

### Round 1 (2026-05-10) — 5 critics + design-experimenter

**failure-mode-analyst** — incorporated:
- §G data-loss path through symlinked `<cwd>/.claude/skills/` (case #4) → §G mandates `lstat` and exact-target-match.
- TASK_CHECKPOINT_DIR vs KOOKR_CHECKPOINT_DIR silent-precedence (#11) → fallback chain dropped (one var only).
- Hook bypass via `--no-verify` (#15) → CI duplicate added.
- Unqualified `subagent_type` resolution (#17) elevated from edge case to load-bearing → confirmed by empirical probe; migration plan rewrites all callers.
- §G acceptance criterion missing → new acceptance test for Codex actually loading skills.

**design-minimalist** — incorporated:
- §G ledger / crash-recovery / atomicity / `.git/info/exclude` over-engineered → §G fully rewritten as single dir-symlink overlay (~30 lines).
- §C three-level env-var fallback chain → dropped. One canonical var.
- Disagreed on §E hook fixture tests: design-minimalist would skip them; failure-mode-analyst's `--no-verify` and CI-duplicate concerns require them. Tests stay.

**socratic-challenger** — incorporated:
- Q4: single dir-symlink simpler than 65 per-file symlinks → adopted.
- Q9: rename `oss-task-checkpointing` now since blast radius is small → adopted (verified 2 files).
- Q10: has the `oss-issue-scout` grep been done? → done; 1 playbook + 1 test fixture; rewrites included in PR3.
- Q11: silent-shadowing rule for personal user-scope skills → out of scope (Edge case 6 clarifies).
- Rejected Q12 ("just unblock #210"): the dir-symlink overlay is now small enough that #210 is a clean future migration, not a blocker.

**ambition-amplifier 2026-05-10: novel finding** —
- `oss-task-checkpointing` rename adopted (sidesteps-the-hard-part finding was correct).
- `PluginOverlayProvider` interface rejected: with §G now ~30 lines, the abstraction costs more than it saves. Future deletion is one revert-shaped change.
- pre-push/post-push/pr-lifecycle/pre-pr-review consolidation rejected: out of scope for distribution RFC; distinct triggers warrant distinct skills.
- Personal-deps promotion rejected: out of scope per Non-goals.

**delivery-pragmatist** — incorporated:
- `CHECKPOINT_LOAD_INSTRUCTION` in `src/core/checkpoint-path.ts:161` must update atomically with skill rename → made explicit in PR2C and Files to change.
- "Single migration PR" framing wrong → 4-PR plan in Migration sequencing.
- Codex overlay must not ship in same wave → PR4 separate.
- User-scope deletions are irreversible without backup → documented in PR2 release notes.
- Plugin version semantics unspecified → CHANGELOG added as Open Q3.
- Bypass-mode parity untested → new Vitest case in §D.

**design-experimenter (empirical checkpoint, 2026-05-10)** — three claims probed:
- Claim 1 (skill backward-compat): **PARTIAL** — natural-language works, slash-commands and Skill-tool calls require qualified name. CLAUDE.md narrowed accordingly.
- Claim 2 (subagent backward-compat): **FALSIFIED** — `Agent type 'X' not found` for unqualified plugin agents. Migration plan rewrites all callers in the same PR.
- Claim 3 (Codex follows dir-symlinks): **HOLDS** — verified via Codex source `loader.rs:479–487` + existing test `loads_skills_via_symlinked_subdir_for_repo_scope`. §G simplification is safe.

### Adversarial-pair resolution (rfc-iterative-review skill requirement)

`design-minimalist` vs `ambition-amplifier` on §G: design-minimalist won. The single-dir-symlink mechanism is small enough (~30 lines) that an abstraction layer (`PluginOverlayProvider`) would add more code than it saves, and the future symmetry restoration via Codex `--plugin-dir` is a single revert-shaped change traceable via this RFC. The cap (option 2 over option 1) is correct because Codex fork issue #210 is a real blocker; the simplification of option 2 (dir-symlink vs ledger) was the actual hard part being dodged in v1.

### Round 2 (2026-05-10) — 3 critics

**failure-mode-analyst (round 2)** — incorporated:
- PR2A self-DoS with PR1 hook (#9): hook now ships with the moves it enforces (single PR1 instead of separate hook PR).
- Path-mutation case (#1): cleanup uses `startsWith <kookr-prefix>/plugin` instead of exact-target match.
- Orphan symlink discoverability (#2, #6): bounded startup sweep added against `taskStore.getTasks()` cwds.
- Bypass-mode test is paper-only (#7): test cut; documented as CLAUDE.md invariant instead.
- `.github/workflows/checks.yml` doesn't exist (#8): moot — CI duplicate cut entirely.
- Cleanup TOCTOU (#5): documented as accepted assumption (single-tenant; no concurrent process replacing symlinks). Not load-bearing.
- "rfc-iterative-review rewrite ambiguity" / Bucket 1 zero-diff claim contradiction: resolved by moving rfc-iterative-review to Bucket 2 unconditionally.

**design-minimalist (round 2)** — incorporated:
- §G test cases 3 + 4 cut (collision-skip is `lstat` guard, not testable behavior).
- KOOKR_CODEX_BIN integration test cut.
- CI duplicate of placement-gate hook cut.
- Bypass-mode parity Vitest test cut.
- `plugin/CHANGELOG.md` cut (Open Q3 resolved).
- 4-PR plan collapsed to 3 PRs (PR1+PR2A+PR2B combined).
- Hook fixture tests kept (the hook has enough conditional logic to justify them — disagrees with design-minimalist; deliberate keep).

**delivery-pragmatist (round 2)** — incorporated:
- PR1 self-DoS (#1): hook now ships with the moves.
- rfc-iterative-review rewrite ambiguity (#2): moved to Bucket 2 unconditionally.
- PR2B cannot pass CI in isolation (#3): addressed by combining PR2A+PR2B into PR1, which lands all moves atomically.
- External consumer rename breakage (#5): release-note one-liner in v0.4.1; no alias (single-tenant scale; blast radius outside kookr is empirically zero).
- PR4 orphan-discovery (#4): `taskStore` is the inventory; documented in rollback procedure.

### Round 2 adversarial-pair resolution

design-minimalist vs failure-mode-analyst on bypass-mode test: **design-minimalist won.** The structural fix (no project-scope agents) eliminates the failure vector at its source; an args-only test guards against zero scenarios; a real runtime test would require spawning `claude` as a subprocess, which is heavyweight integration-test territory not justified at single-tenant scale. CLAUDE.md invariant note is the right level of investment.

### Round 3 (2026-05-10) — 2 critics

**boundary-critic (round 3)** — incorporated:
- `KOOKR_CHECKPOINT_DIR` naming is a leaky abstraction in a "general" skill body. Renamed to `TASK_CHECKPOINT_DIR` in PR2.
- `taskStore` reading from `CodexCliAdapter` startup sweep: continuation of existing coupling, not new. Acknowledged.
- Hook placement `<kookr>/hooks/`: correct. No defect.
- Two-home model: clean. No emerging third category.

**socratic-challenger (round 3)** — incorporated:
- Q3 `KOOKR_CHECKPOINT_DIR` rename in PR2 (independently agreed with boundary-critic). Done.
- Q5 §G cleanup match too permissive (`startsWith` heuristic). Tightened to sentinel-file check (`.claude-plugin/plugin.json#name == "kookr-toolkit"`).
- Q6 user-scope backup before deletion. Added one-line `mkdir + cp -r` to PR1 manual step.

**socratic-challenger (round 3)** — rejected with reasons:
- Q1 (pre-commit hook in addition to pre-push): pre-push is the kookr convention; the contributor-flow risk is bounded at single-tenant scale; CLAUDE.md invariant note is sufficient.
- Q2 (bounded sweep is ceremony): partly fair. The sweep does close failure-mode-analyst round-2 case #2 cheaply (~10 lines), but its actual coverage depends on `taskStore` retention. Kept; documented limitation: it cannot recover orphans whose task isn't in `taskStore`.
- Q4 (split PR1 hook from moves into two PRs): defensible alternative. The combined PR1 is large but atomic; the split would be more reviewable but adds a merge round-trip. Author's choice. Deferring to author at implementation time; both shapes are safe.

### Round 3 convergence note

No new substantive findings beyond the 3 fixes above. Most of round-3 socratic-challenger's questions tested whether earlier cuts would be regretted; the maintainer's answers are documented above (rejected with explicit reasons). Stopping after round 3 per the rfc-iterative-review skill: no round-4 critics will produce non-incremental findings against a structure that has been through 3 review rounds and 1 empirical checkpoint.
