# RFC: Unified Placement Picker for Rules, Skills, Hooks, and Context

## Status

**Draft v3.1 — post-PoC-008 correction**
**Date:** 2026-05-14

**v3.1 update (this revision):**

- **PoC 008 cross-runtime result.** v3 named the bypass-mode probe but described it as "likely yes per structural evidence." The actual probe (Run A: Claude Code; Run G/H: Codex CLI both bypass and non-bypass) produced an asymmetric result: **Claude Code fires plugin hooks under bypass; Codex CLI does NOT fire plugin hooks at all via `--plugin-dir`**, regardless of mode. The kookr Codex fork's `--plugin-dir` registers `cli_plugin_dirs` as skill roots only (per `codex-rs/core/src/config/mod.rs:1907`). Plugin-hook loader exists and `Feature::PluginHooks` is default-on; the wiring just doesn't feed `cli_plugin_dirs` into it.
- **Impact reframed.** The placement-gate hook from PR #348 covers Claude Code Kookr tasks fully and is silent on Codex CLI Kookr tasks. The 38/859 May-2026 sessions that motivated this RFC were Codex sessions; PR #348 alone does NOT close that gap. The push-time tree-scanner gate (`<repo>/hooks/skill-placement-gate.sh`) remains the cross-runtime catch-net. Codex coverage of the in-session gate requires a follow-up codex-fork extension to register `cli_plugin_dirs` as plugin-hook sources.
- **Surface inventory row 9** updated: "Plugin hook" runtime visibility now reads "Claude Code: yes (`--plugin-dir`); Codex CLI: **NO via `--plugin-dir` until fork extension lands**."

**Major v3 revisions** (round-2 substantive findings — incorporated):

- **Gate Checks 4 and 5 cut.** Round-2 design-minimalist and failure-mode-analyst converged: Check 4 (memory-frontmatter type) duplicates `reflect-memory-frontmatter-gate.sh` which already enforces the same invariant. Check 5 (project-hook installability) was fragile (install-script content parsing) with no documented incident history. The gate now does **only** the 3 path-prefix checks that mirror today's `skill-placement-gate.sh`, plus the `kookr-*`-banned-in-plugin/ rule (4 checks total, all path-only).
- **The `git diff --cached A-status` filter was wrong tense.** Round-2 failure-mode R5 + delivery-pragmatist noted the index is empty at PreToolUse time. v3 §C replaces it with `git ls-files --error-unmatch -- "$path"` (returns non-zero ⇔ file is new ⇔ fire the gate).
- **Sentinel-file resolution uses `--git-common-dir`, not `--show-toplevel`.** Round-2 failure-mode R3 + delivery-pragmatist: worktrees would have silently lost strict-mode otherwise.
- **`.kookr-placement-gate-strict` added to `.gitignore`.** Round-2 delivery-pragmatist: prevents accidental commit-to-shared-repo causing every clone to enter strict mode.
- **Pre-push regex change written as a literal 1-line diff.** Round-2 delivery-pragmatist: line 234 of `<kookr>/.hooks/pre-push` — `^plugin/(skills\|agents)/` → `^plugin/(skills\|agents\|hooks)/`. Without this, the version-bump enforcement silently misses PR1.
- **The 15-line CLAUDE.md routing table is written out inline below**, not just promised. Round-2 failure-mode R4 + design-minimalist showed 15 lines is mathematically tight; v3 demonstrates a concrete table that hits ~18 lines and explicitly accepts the "≤20 lines" acceptance criterion as the cap.
- **Bash matcher parsing scope explicitly bounded.** Round-2 failure-mode R1: v3 §C enumerates the exact commands the gate inspects (`>`, `>>`, `tee`, `cp`, `mv`, here-docs targeting watched paths) and documents the residual gap (variable-expanded paths, interpreters, `apply_patch`) so the limitation is honest.
- **Codex `apply_patch` documented as a known gap.** Round-2 failure-mode R7 + socratic Q2: per PoC 003 §Gap 5, `apply_patch` emits no PreToolUse. v3 names this as out-of-scope-but-known and points to the rfc-skill-agent-distribution §G overlay's push-time enforcement as the catch-net.
- **PoC 008 demoted from PR0 to "informal probe before PR1 README write."** Round-2 design-minimalist + socratic Q6: the RFC said PR1 ships either way, which made the dependency theatrical. v3 reflects that honestly: PoC 008 produces no code change; its outcome only affects one sentence in `plugin/hooks/README.md`.
- **Real FP acceptance test added.** Round-2 socratic Q3 + failure-mode R6 + delivery-pragmatist: the v2 express test was vacuously true (none of the gate's watched paths exist under `expressjs/express/src/`). v3 replaces with a test that writes to `~/.claude/projects/<unrelated-slug>/memory/note.md` from a non-kookr session and expects zero warnings.
- **Acceptance includes the "no `--plugin-dir`" bootstrap test.** Round-2 failure-mode R6 + delivery-pragmatist: the v2 acceptance covered only the plugin-loaded path. v3 adds a third test that exercises kookr CLAUDE.md's 15-line fallback table in an interactive session without `--plugin-dir`.
- **Q3 cross-runtime question routed away from per-artifact answer.** Round-2 socratic Q4: rather than asking the human every time, v3 frames Q3 as a one-time environment detect: if `KOOKR_CODEX_BIN` resolves OR any task in `~/.kookr/tasks/` has used `agentType: codex-cli`, Q3 defaults to "yes" for that user; otherwise "no." Per-artifact override remains available.
- **(s4) marked kookr-internal-only in the public picker.** Round-2 socratic Q5: the gate only enforces the prefix convention inside the kookr repo. For non-kookr users, (s4) collapses into (s2). v3 §A annotates this in the matrix.
- **Discoverability claim grounded.** Round-2 design-minimalist: "self-reflect's keywords don't match placement vocabulary" is the right justification but for the wrong reason. The real argument is body-shape: self-reflect is a 200-line post-mortem workflow, placement-picker is a 1-page routing table; loading self-reflect for a simple "where do I save this?" question forces an inappropriate workflow shape. v3 §"Adversarial-pair resolution" cites this.

**Major v2 revisions (carried forward):**
**Author:** Jean Ibarz (with Claude)

**Major v2 revisions:**

- **Hook registration mechanism corrected.** Empirical probe falsified the v1 claim that hooks register via `plugin.json`. The real mechanism is `plugin/hooks/hooks.json` sidecar. v2 fixes the §C / PR2 deliverable.
- **Codex-CLI coverage added.** Empirical probe confirmed Codex does NOT emit PreToolUse for `Write`/`Edit` (no native tools); all Codex file ops go through `Bash`. v2 §C adds a `Bash` matcher with command-pattern filter so the gate covers both runtimes.
- **Body-heuristic checks removed.** Round-1 failure-mode-analyst F2/F3/F12 flagged "body starts with 'do X'/'never Y'" as a footgun with high FP rate on legitimate context prose. v2 keeps only **path-based** checks (deterministic, unambiguous, matches the existing `skill-placement-gate.sh` pattern).
- **Three-coexisting-pickers resolved.** Round-1 boundary-critic identified that `self-reflect` lines 121–175 and `task-feedback-reflect` lines 62–69 also contain picker bodies. v2 makes the new plugin skill the **single canonical body** and explicitly strips both inline bodies to pointers in PR2.
- **Scope (s4) generalized.** Round-1 module-interface-auditor F2 flagged "kookr-internal only" as a kookr-specific leak in a public API. v2 renames to "(s4) This repo's internal workflows" with prefix guidance for non-kookr repos.
- **(b)(s2) cell disjunction collapsed.** Round-1 module-interface-auditor F3 noted the only disjunctive cell in the matrix re-introduced decision paralysis. v2 promotes the cross-runtime question to a top-level Q3.
- **Calibration question scope-limited.** Round-1 module-interface-auditor F4 noted the question doesn't apply to context. v2 restricts it to rules/procedures/guards only.
- **Skill frontmatter specified.** Round-1 module-interface-auditor F1 found the picker had no proposed `name`/`description`/`keywords` — without these the skill won't be discovered at decision time. v2 §B includes the full frontmatter.
- **Interactive-author bootstrap addressed.** Round-1 delivery-pragmatist's "Critical PR2" finding (interactive `claude` in kookr repo doesn't get `--plugin-dir`) drove a larger fallback in kookr CLAUDE.md — not a 5-line pointer but a 15-line minimum effective routing table.
- **PR ordering reversed.** Round-1 delivery-pragmatist warned PR2 (strip canonical body) before PR3 (gate) opens a regression window. v2 ships gate first as PR1, then skill+pointers together.
- **PoC 008 added as PR1 prerequisite.** Round-1 failure-mode F11 + empirical probe Claim 3 (partial): plugin-bundled hook bypass-mode survival is structurally likely but not empirically tested. PoC 008 is named as a required dependency, mirroring the existing PoC-numbered probes.
- **Acceptance criterion made falsifiable.** Round-1 module-interface F8 + failure-mode F20: original "first 5 tool calls" criterion was unobservable. v2 specifies the exact test prompt and pass/fail signal.

---

## Problem

Kookr-related work scatters rules, skills, instructions, hooks, and context across **12 placement surfaces**. The user reports they "struggle often" choosing the right one, and recent sessions confirm the cost: misplaced rules become invisible to half the runtime (Codex CLI sessions silently ignoring CLAUDE-Code-only memory), duplicated content shadows the canonical version, and skills that should ship to all kookr-toolkit users end up scoped to a single repo's `.claude/` tree where no other repo can find them.

Two existing partial answers cover adjacent but non-overlapping axes:

- **`<kookr>/CLAUDE.md` Persistence Mechanism Picker** (lines 153–211) distinguishes *behavioral rules* (must use hook/skill/CLAUDE.md — NEVER memory) from *context* (memory OK). One axis: memory vs not.
- **`docs/rfc/rfc-skill-agent-distribution.md` (v3.1)** specifies the two-home model for skills/agents (`plugin/skills/` for general, `<repo>/.claude/skills/` for kookr-internal kookr-prefixed), enforced by `hooks/skill-placement-gate.sh`. One axis: which skill home.

Neither answers questions like *"this new rule could go in user CLAUDE.md, project CLAUDE.md, OR a plugin skill — which?"* or *"I want this enforcement to ship to every kookr-toolkit user across every repo — where does it live?"* Round-1 critics also identified that **three skill bodies** today carry full or partial pickers (CLAUDE.md, `self-reflect/SKILL.md` lines 121–175, `task-feedback-reflect/SKILL.md` lines 62–69), each subtly different — the "one source of truth" principle is breached today.

## Empirical grounding (current state, 2026-05-14)

### Surface inventory

| # | Surface | Path | Audience | Claude Code | Codex CLI | Plugin-shipped | Propagation |
|---|---|---|---|---|---|---|---|
| 1 | User CLAUDE.md | `~/.claude/CLAUDE.md` | every project, this machine | yes | yes (Codex reads it) | no | next session |
| 2 | Project CLAUDE.md | `<repo>/CLAUDE.md` | every agent in this repo | yes | yes | with the repo | next session |
| 3 | Project memory | `~/.claude/projects/<proj-slug>/memory/*.md` | Claude Code in this project, this machine | yes | **NO** | no | immediate (next turn) |
| 4 | User skills | `~/.claude/skills/<name>/SKILL.md` | every project, this machine | yes | yes | no | next session |
| 5 | Project skills | `<repo>/.claude/skills/<name>/SKILL.md` | this repo only | yes | yes | with the repo | next session |
| 6 | Plugin skills | `<repo>/plugin/skills/<name>/SKILL.md` | every kookr-toolkit user, every repo they run in | yes (`--plugin-dir`) | yes (dir-symlink overlay, rfc-skill-agent-distribution §G — **dynamic per empirical probe**) | **yes** | on plugin update |
| 7 | User hooks | `~/.claude/hooks/*.sh` registered in `~/.claude/settings.json` | every session, this machine | yes | partial: see surface 8 note | no | next session |
| 8 | Project (in-repo) hooks | `<repo>/hooks/*.sh` (Kookr runtime) + `<repo>/.hooks/*` (git plumbing), installed via `scripts/install-hooks.sh` | this machine after install | yes | partial — Codex emits `PreToolUse` only for `Bash` (per PoC 003 Gap 6); file ops appear as `Bash` commands | no — must install | one-shot install |
| 9 | Plugin hooks | `<repo>/plugin/hooks/<name>.sh` registered via `<repo>/plugin/hooks/hooks.json` (sidecar — **NOT plugin.json**, per empirical probe) | every kookr-toolkit user | yes (`--plugin-dir`) | **NO via `--plugin-dir`** — kookr Codex fork's `cli_plugin_dirs` registers skill roots only, not hook sources (`config/mod.rs:1907`); closing requires fork extension. Push-time tree-scanner gate at `<repo>/hooks/` is the catch-net until then. | yes | on plugin update |
| 10 | Knowledge base | `~/knowledge_bases/<kb-name>/`, searchable via `kb` CLI | every shell on this machine | via Bash | via Bash | no | immediate |
| 11 | Project agents | `<repo>/.claude/agents/*.md` | this repo only (NOT in bypass mode per memory note) | yes | yes | with the repo | next session |
| 12 | Plugin agents | `<repo>/plugin/agents/*.md` | every kookr-toolkit user | yes | yes | yes | on plugin update |

### Concrete pain signals

1. **Memory used for behavioral rules** — the system-prompt `# auto memory` section actively trains agents toward feedback memories. Codex CLI cannot read those memories. Net effect: half the runtime silently violates rules.
2. **Skill placement drift** — 12 of 24 entries in `<kookr>/.claude/skills/` are unprefixed (per rfc-skill-agent-distribution).
3. **CLAUDE.md tier confusion** — overlapping content in `<kookr>/CLAUDE.md` and `~/.claude/CLAUDE.md` with no canonical-version rule.
4. **Enforcement is repo-bound** — `skill-placement-gate.sh` lives at `<kookr>/hooks/`, fires only at kookr-repo push time. A kookr-toolkit user in a different repo gets no equivalent gate.
5. **Three live picker bodies** — `<kookr>/CLAUDE.md` lines 153–211, `plugin/skills/self-reflect/SKILL.md` lines 121–175 (full body), `plugin/skills/task-feedback-reflect/SKILL.md` lines 62–69 (its own picker). All three drift independently.
6. **The picker is the artifact it describes** — meta-problem: the picker is itself a "rule about where to put rules." Today it lives in CLAUDE.md (good for kookr-internal sessions) but is invisible to plugin-only users who never open the kookr repo.

## Goals

1. **One canonical picker body** with explicit pointers in every other location it's referenced.
2. **Picker visibility at decision time** for every kookr-related context (kookr repo, plugin-user repos, both Claude Code and Codex CLI). Discoverable via keyword match against the working vocabulary of an agent making a placement decision.
3. **Enforcement shipped via the plugin** so it propagates without per-repo install.
4. **Backward-compatible** with the two existing partial answers.
5. **Stable across runtime** — same picker output in Claude Code and Codex CLI for the same input *to the extent the runtime supports the recommended surface*. Where they differ (e.g., Claude-Code-only memory), the picker says so explicitly.

## Non-goals

- Changing the surface inventory itself.
- Replacing rfc-skill-agent-distribution — defer to it for skill/agent specifics.
- Migrating existing misplaced artifacts (out-of-scope; follow-up audit task).
- Native Codex `Write`/`Edit` tool support — Codex uses `Bash`; we adapt the gate matcher to match (v2 §C).

## Design principles

- **Visibility-first**: the picker MUST be reachable from any runtime, in any repo, without prior knowledge of where it lives.
- **One source of truth**: ONE canonical body. Every other location is a pointer of capped length. The acceptable inline content elsewhere is restricted to a routing keyword table — never duplicated decision logic.
- **Deterministic enforcement only**: the gate hook uses path-based checks exclusively. No body-text heuristics, no LLM-judgment proxies.
- **Cross-runtime symmetry**: every recommendation states whether it works on Codex CLI. When a surface is Claude-Code-only (memory), the picker labels it as such, never silently routes a cross-runtime artifact there.

## Design

### A. Unified Placement Picker — decision tree

Three top-level questions (Q3 is new in v2 — promoted out of a cell, per round-1 critique):

```
Q1: What KIND of artifact is this?
  (a) RULE / WORKFLOW STEP  — "do X before Y", "never use Z", "always run W"
  (b) CONTEXT — "who Jean is", "why we did X", "where bug tracker lives"
  (c) REUSABLE PROCEDURE — multi-step playbook
  (d) DETERMINISTIC GUARD — wrong behavior is shell-detectable
  (e) DOMAIN KNOWLEDGE — "how llama.cpp behaves", "WSL gotcha"

Q2: Who needs to follow / see it?
  (s1) ME on this machine, across all projects
  (s2) Every agent on this machine in THIS repo
  (s3) Every kookr-toolkit user, across every repo
  (s4) THIS repo's internal workflows only — uses repo-specific prefix

Q3: Must it be visible to Codex CLI? (Yes by default — memory and Claude-Code-only
    hook event types are the only "no" answers.)
```

Routing matrix (5 kinds × 4 scopes × Codex-aware adjustments):

| Kind \ Scope | (s1) me, all projects | (s2) this repo only | (s3) kookr-toolkit users, all repos | (s4) this repo's internal |
|---|---|---|---|---|
| (a) Rule | **User CLAUDE.md** | **Project CLAUDE.md** | **Plugin skill** with rule-shaped frontmatter | `<repo>/.claude/skills/<prefix>-<n>/` + project CLAUDE.md pointer |
| (b) Context (cross-runtime needed) | User CLAUDE.md | Project CLAUDE.md | n/a (rare — context is local) | Project CLAUDE.md |
| (b) Context (Claude-Code-only acceptable — Q3=no) | Project memory (`~/.claude/projects/<slug>/memory/*.md`) | Project memory | n/a | Project memory |
| (c) Procedure | User skill (`~/.claude/skills/`) | Project skill (`<repo>/.claude/skills/`) | **Plugin skill** (`plugin/skills/`) | `<repo>/.claude/skills/<prefix>-<n>/` |
| (d) Guard | User hook (`~/.claude/hooks/` + settings.json entry) | Project hook (`<repo>/hooks/` + install script) | **Plugin hook** (`plugin/hooks/*.sh` + `plugin/hooks/hooks.json`) | Project hook in repo |
| (e) Domain knowledge | **KB** (`~/knowledge_bases/<kb>/`) via `kb remember` | Project KB or repo docs (`docs/`) | n/a (KBs are user-scoped) | Repo docs |

**Note on (s4)**: when in the kookr repo, the prefix is `kookr-`. In other repos, choose a repo-specific prefix (e.g. `acme-`). The placement-gate hook (§C) only enforces the `kookr-` prefix inside the kookr repo itself; other repos are free to use their own conventions or none.

**Most-often-wrong cell**: (a) Rule + (s3) all kookr-toolkit users. Agents default to memory because of the system-prompt auto-memory pull, when the correct answer is a plugin skill.

### B. The picker as a plugin skill — frontmatter and body

**Canonical location**: `<kookr>/plugin/skills/placement-picker/SKILL.md`

**Frontmatter** (specified explicitly per round-1 module-interface-auditor F1):

```yaml
---
name: placement-picker
description: >
  Decide where to place a new rule, skill, hook, KB entry, or context artifact —
  user CLAUDE.md vs project CLAUDE.md vs plugin skill vs project skill vs hook
  vs memory vs knowledge base. Use whenever you need to persist anything and
  are choosing among 12 surfaces, especially before saving a feedback memory
  or adding a CLAUDE.md rule.
keywords: >
  where to save, where does this go, placement, which CLAUDE.md, plugin skill,
  project skill, persist rule, save rule, store rule, hook or skill, memory
  or skill, which scope, user scope, project scope, placement decision, where
  to put, save this, where should this go, where do I add, scope, persistence
related: self-reflect, task-feedback-reflect, kookr-codex-claude-compatibility
---
```

**Body sections** (full content in PR2):

1. Surface inventory table (12 rows — copied from §"Empirical grounding").
2. The Q1/Q2/Q3 decision tree (§A above, verbatim).
3. The routing matrix (§A above, verbatim).
4. The **calibration question — scoped to rules/procedures/guards only** (not context, not domain knowledge): *"Will this artifact still apply on Codex CLI tomorrow, in a kookr-toolkit-user's repo, on a different machine?"* If any "no" → reconsider scope.
5. Worked examples per kind × scope cell (6 examples, one per typical decision pattern; pulled from recent self-reflect outputs — editorial, not auto-generated).
6. Anti-patterns:
   - Saving a behavioral rule as memory (counter to system-prompt auto-memory pull).
   - Putting a kookr-specific rule in user CLAUDE.md when it belongs in a plugin skill (cross-project pollution).
   - Putting an enforcement hook in `<repo>/hooks/` when it should ship to all kookr-toolkit users (`plugin/hooks/`).
   - Duplicating skill content between `.claude/skills/` and `plugin/skills/` (caught by skill-placement-gate Check 3).
   - Heuristic body-text matching at the gate layer (this RFC's own rejected design — kept here as anti-pattern reminder).
7. Surface-not-available fallback (per round-1 module-interface F5): If you are a plugin user without a writable `plugin/` tree, the next-best alternatives for (s3) cells are listed.
8. Pointer to rfc-skill-agent-distribution for skill/agent placement specifics; pointer to PoC 003 for hook-event coverage by runtime.

### C. Enforcement — the placement gate, plugin-bundled

**Files** (per empirical probe Claim 1):

- `<kookr>/plugin/hooks/placement-gate.sh` — the script
- `<kookr>/plugin/hooks/hooks.json` — the registration sidecar (the canonical mechanism for plugin-shipped hooks; falsified v1's `plugin.json` registration)

**Registration** (`plugin/hooks/hooks.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/placement-gate.sh" }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/placement-gate.sh" }]
      }
    ]
  }
}
```

The dual matcher is required because (per empirical probe Claim 2) **Codex CLI emits `PreToolUse` only for `Bash` — never for `Write`/`Edit`**. All Codex file operations look like `bash -lc 'cat > /path ...'`. The gate must inspect `tool_input.command` when the matcher is `Bash`, and `tool_input.file_path` when the matcher is `Edit|Write|MultiEdit`.

**Checks** (path-based only — v3 cuts Checks 4 and 5 from v2 per round-2 convergence; the gate now has 4 path-prefix checks, all deterministic):

1. New file in `<repo>/.claude/skills/<name>/` where `<name>` does NOT start with `kookr-` (in the kookr repo only) → warn: suggest `plugin/skills/<name>/` for general utility.
2. New file in `<repo>/plugin/skills/kookr-<name>/` → warn: `kookr-*` prefix is banned in `plugin/` per rfc-skill-agent-distribution §A.
3. New file in `<repo>/.claude/skills/<name>/` where a same-named directory exists at `<repo>/plugin/skills/<name>/` → warn: shadow risk (mirrors existing Check 3 of `skill-placement-gate.sh`).
4. New file in `<repo>/.claude/agents/<name>.md` where `<name>` does NOT start with `kookr-` (in the kookr repo only) → warn: same naming rule for agents.

Memory-frontmatter enforcement remains owned by the existing `reflect-memory-frontmatter-gate.sh` (already shipped in `plugin/hooks/`); this gate does NOT duplicate it. The "wrong-content-in-memory" axis is `reflect-memory-frontmatter-gate`'s responsibility; the "wrong-path" axis is `placement-gate`'s.

**Bash matcher scope** (per round-2 failure-mode R1 — bounded explicitly):

When `tool_name == Bash`, the gate parses `tool_input.command` for **only these write patterns** targeting watched paths:
- `cat > <path>`, `cat >> <path>` (redirected output)
- `tee <path>`, `tee -a <path>`
- `cp <src> <path>`, `mv <src> <path>`
- Here-doc redirections `cat > <path> <<EOF` / `cat > <path> <<'EOF'`
- `printf ... > <path>`, `echo ... > <path>` (with literal redirection operator)

Residual gap (documented, not silently): variable-expanded paths (e.g. `> "$DIR/skill.md"`), interpreter-internal writes (`python -c "open('x','w')..."`), `dd of=`, `git checkout -- <path>`. These slip past the Bash matcher. They also slip past every static-analysis tool; the gate is best-effort coverage, not airtight. Codex `apply_patch` emits no PreToolUse (per PoC 003 §Gap 5) and is similarly invisible — but caught at push time by rfc-skill-agent-distribution §G's overlay-driven `skill-placement-gate.sh` (which inspects the final tree, not individual writes).

**Path deny-list** (early-return; evaluated FIRST in the gate script — per round-2 failure-mode R2):
- `node_modules/`, `dist/`, `build/`, `target/`, `.next/`, `.svelte-kit/`
- `~/.kookr/` (Kookr-managed task state — gating itself would deadlock; tested by task-checkpointing skill's `Write` calls to `~/.kookr/checkpoints/<task>/`)
- `<repo>/.claude/worktrees/` (Kookr-managed worktrees in kookr repo only)

**New-file detection** (per round-2 failure-mode R5 — v2's `git diff --cached A` was wrong tense):

```bash
# Fires only for paths not yet tracked by git. PreToolUse runs BEFORE the
# write, so checking the on-disk file is unreliable (file may exist from
# a prior failed write). Use git's tracked-set as the new-vs-edit signal.
if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
  exit 0   # path is tracked → it's an edit, not a new file → skip
fi
```

**Strict-mode resolution** (per round-2 failure-mode R3 — v2's `--show-toplevel` lost strict mode across worktrees):

```bash
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || COMMON_DIR=
if [ -n "$COMMON_DIR" ] && [ -f "$COMMON_DIR/../.kookr-placement-gate-strict" ]; then
  STRICT=1   # one sentinel at the main checkout covers every worktree
fi
```

The sentinel file is added to `.gitignore` (v3 PR1 deliverable) so accidental `git add .` does not commit it. Per-repo, never global.

**Operating mode**: advisory (warn-on-stderr-and-allow) by default. Strict mode (hard-block) is opt-in via the sentinel above. Suppression for a single call: prepend `KOOKR_PLACEMENT_GATE_SKIP=1` to the env (read by the script as an explicit skip signal; rare).

**Runtime coverage (PoC 008 result, v3.1)**: the placement-gate hook fires on **Claude Code** in both supervised and bypass modes (Run A verified). It **does NOT fire on Codex CLI** in either mode (Run G/H), regardless of `--plugin-dir`. The kookr Codex fork registers `cli_plugin_dirs` as skill roots only (`codex-rs/core/src/config/mod.rs:1907`); the plugin-hook loader exists and `Feature::PluginHooks` is default-on, but the wiring doesn't feed `cli_plugin_dirs` into it. Codex coverage of the in-session gate requires a follow-up codex-fork extension. Until that lands, the push-time tree-scanner gate at `<repo>/hooks/skill-placement-gate.sh` remains the cross-runtime catch-net (it inspects the final tree regardless of which runtime wrote the files). See `docs/poc/008-plugin-hook-bypass-survival.md` for the full probe.

### C2. The literal CLAUDE.md replacement (v3 — concrete text per round-2 R4)

The 59-line Persistence Mechanism Picker section in `<kookr>/CLAUDE.md` (lines 153–211) is replaced with this **18-line minimum effective routing block**:

```markdown
## Placement Picker

Canonical body: `kookr-toolkit:placement-picker` plugin skill. Stub fallback for sessions without `--plugin-dir`:

| KIND of artifact   | s1: me, all projects | s2: this repo | s3: kookr-toolkit users, all repos | s4: kookr-internal only |
|--------------------|----------------------|---------------|-------------------------------------|--------------------------|
| (a) Rule           | user CLAUDE.md       | project CLAUDE.md | **plugin skill (rule-shaped)** | `<kookr>/.claude/skills/kookr-<n>/` |
| (b) Context        | project memory (CC-only) OR user CLAUDE.md (cross-runtime) | project memory OR project CLAUDE.md | n/a | project memory |
| (c) Procedure      | user skill           | project skill | **plugin skill**                    | `<kookr>/.claude/skills/kookr-<n>/` |
| (d) Guard          | user hook            | project hook  | **plugin hook + plugin/hooks/hooks.json** | project hook |
| (e) Domain knowledge | KB (`~/knowledge_bases/`) via `kb remember` | repo docs | n/a | repo docs |

**Cross-runtime calibration (rules/procedures/guards only — not context, not domain)**: *"Will this work on Codex CLI tomorrow, in a kookr-toolkit-user's repo, on a different machine?"* If "no" anywhere → reduce scope.

**Memory is BANNED for behavioral rules** — Codex CLI cannot read Claude Code's memory system. Rules go in CLAUDE.md, skill, or hook. Memory is for context (who, why) — never how.

See `kookr-toolkit:placement-picker` skill body for worked examples and anti-patterns.
```

That's 18 lines of substantive text (the matrix + calibration + memory rule + pointer), within the ≤20-line acceptance cap. The plugin skill body carries the full surface inventory, worked examples, anti-patterns, and surface-not-available fallback.

### D. Coexistence with existing pickers — strip-and-pointer

`<kookr>/plugin/skills/self-reflect/SKILL.md` lines 121–175 contain a full picker body. `<kookr>/plugin/skills/task-feedback-reflect/SKILL.md` lines 62–69 contain a smaller picker. Round-1 boundary-critic flagged that v1 left both in place, breaking "one source of truth" on day 0 of PR2.

**v2 PR2 explicitly**:
- Replaces the picker section in `self-reflect/SKILL.md` (lines 121–175) with a **5-line block** that cross-links `placement-picker` and keeps the calibration question inline (the question is short and load-bearing for the reflection flow).
- Replaces the picker block in `task-feedback-reflect/SKILL.md` (lines 62–69) with a **3-line pointer**.
- Replaces the body in `<kookr>/CLAUDE.md` lines 153–211 with a **15-line minimum effective routing table** + pointer (NOT a 5-line stub — round-1 delivery-pragmatist's Critical PR2 finding showed that interactive `claude` sessions in the kookr repo may not have `--plugin-dir` loaded; the inline table is the fallback).

After PR2: one canonical body in `placement-picker`; three pointers (self-reflect, task-feedback-reflect, kookr CLAUDE.md); user CLAUDE.md adds a 3-line pointer + the (a)(s3) anti-pattern reminder (the highest-frequency wrong cell).

### E. PR ordering — gate first, then content

Reversed from v1 per round-1 delivery-pragmatist. Reasoning: PR2 strips canonical content from CLAUDE.md; if PR3 (the gate) had not yet shipped, there's a window with neither in-line picker nor enforcement. Reverse the order: ship the gate first, then move the content with the gate already live.

- **PoC 008 — informal probe** (not a numbered PR). 15-min test: launch a kookr task with `KOOKR_BYPASS_ALL_PERMISSIONS=true` and a no-op hook in `plugin/hooks/hooks.json`; record whether it fires in `docs/poc/008-plugin-hook-bypass-survival.md`. The outcome edits one sentence in `plugin/hooks/README.md` and one in `placement-picker/SKILL.md` — no code change. Recommended before PR1's README is written; not a hard PR1 blocker since PR1 ships in advisory mode either way.
- **PR1 — Plugin-bundled gate (path-only, advisory)**. Adds `plugin/hooks/placement-gate.sh` (4 path-prefix checks, deny-list-first, Bash matcher scoped to explicit write patterns), `plugin/hooks/hooks.json` (dual matcher: `Edit|Write|MultiEdit` + `Bash`). Adds `.kookr-placement-gate-strict` to `.gitignore`. Extends `<repo>/.hooks/pre-push` line 234 regex (the **literal 1-line diff** is in §"Files to change" below). Version bump `plugin/.claude-plugin/plugin.json` 0.5.2 → 0.6.0.
- **PR2 — Canonical picker skill + pointer stubs**. Adds `plugin/skills/placement-picker/SKILL.md` with the frontmatter and body from §B. Strips `self-reflect/SKILL.md` lines 121–175 to a 5-line pointer (keeping the calibration question inline). Strips `task-feedback-reflect/SKILL.md` lines 62–69 to a 3-line pointer. Replaces `<kookr>/CLAUDE.md` lines 153–211 with the 18-line table from §C2. Adds 3-line pointer to `~/.claude/CLAUDE.md`. Version bump 0.6.0 → 0.7.0.
- **PR3 — Deprecate `<kookr>/hooks/skill-placement-gate.sh`** (deferred to a separate follow-up RFC). After PR1 has been live ≥1 week with zero unexpected blocks reported, delete `<kookr>/hooks/skill-placement-gate.sh` AND remove the corresponding call from `<kookr>/.hooks/pre-push`. Until then, **double-enforcement is accepted** (per round-2 delivery-pragmatist) — both gates fire, with overlapping but compatible warnings. The accepted double-fire is bounded; the old gate's checks 1-3 are a strict subset of the new gate's checks 1-4 plus the kookr-banned-in-plugin/ rule.

Each PR is independently revertable. PR1 has no behavior change for users not editing skills/hooks/memory paths. PR2 depends on PR1 being live (so the gate's warnings reference the new picker by name).

## Files to change

### PoC 008 — Empirical bypass-mode probe (PR0, optional but recommended)

- **NEW** `docs/poc/008-plugin-hook-bypass-survival.md` — bypass-mode hook firing test result

### PR1 — Plugin-bundled gate

- **NEW** `<kookr>/plugin/hooks/placement-gate.sh` — body per §C (4 path-prefix checks, deny-list-first, Bash-matcher with enumerated write patterns, advisory by default)
- **NEW** `<kookr>/plugin/hooks/hooks.json` — registers placement-gate.sh for `PreToolUse` with two matcher entries: `Edit|Write|MultiEdit` and `Bash`
- **NEW** `<kookr>/plugin/hooks/README.md` — documents the gate's checks, the `.kookr-placement-gate-strict` sentinel-file opt-in (resolved via `git rev-parse --git-common-dir`), the deny-list, the Bash-matcher residual gap, and the per-call `KOOKR_PLACEMENT_GATE_SKIP=1` suppression
- **EDIT** `<kookr>/.gitignore` — add `.kookr-placement-gate-strict` (prevents accidental commit-to-shared-repo strict-mode propagation; mirrors the existing `.review-state/` gitignore pattern at line 168)
- **EDIT** `<kookr>/plugin/.claude-plugin/plugin.json` — version bump `0.5.2` → `0.6.0`
- **EDIT** `<kookr>/.hooks/pre-push` line 234 — **literal 1-line diff**:
  ```diff
  - if echo "$CHANGED" | grep -qE '^plugin/(skills|agents)/'; then
  + if echo "$CHANGED" | grep -qE '^plugin/(skills|agents|hooks)/'; then
  ```
  Without this, the version-bump enforcement silently misses every PR that changes `plugin/hooks/` (round-2 delivery-pragmatist Critical PR1 finding).

### PR2 — Picker skill + pointer stubs

- **NEW** `<kookr>/plugin/skills/placement-picker/SKILL.md` — full body per §B, with the frontmatter specified in §B
- **EDIT** `<kookr>/CLAUDE.md` lines 153–211 — replace 59-line picker with 15-line minimum effective routing table + pointer to `kookr-toolkit:placement-picker` skill
- **EDIT** `~/.claude/CLAUDE.md` — add 3-line pointer near the existing "Do NOT use the memory system" rule
- **EDIT** `<kookr>/plugin/skills/self-reflect/SKILL.md` lines 121–175 — replace with 5-line pointer + calibration question inline
- **EDIT** `<kookr>/plugin/skills/task-feedback-reflect/SKILL.md` lines 62–69 — replace with 3-line pointer
- **EDIT** `<kookr>/plugin/.claude-plugin/plugin.json` — version bump to 0.7.0

## Edge cases

- **Plugin not installed**: kookr CLAUDE.md's 15-line minimum effective routing table is the fallback. User CLAUDE.md's 3-line pointer + (a)(s3) anti-pattern reminder is the cross-project fallback.
- **`<repo>/.kookr-placement-gate-strict` checked into git accidentally**: shows up in `git status` immediately; reversible.
- **Codex CLI bypass mode**: pending PoC 008 result. If hooks don't survive, the picker skill body documents this as a known runtime gap.
- **Heuristic FP in body matching**: removed (the design above is path-only).
- **First-touch kookr-toolkit user**: skill auto-load by description-keyword match handles the discovery; the kookr CLAUDE.md fallback table handles the kookr-repo case where the plugin may not be loaded into the interactive `claude` session.
- **Pre-existing misplaced files (gate over-triggers on edit-of-existing)**: gate checks `git diff --cached --name-status` and only fires on `A` (added) status, not `M` (modified) — addresses round-1 F15.
- **`tool_input.command` is empty / binary / >64KB**: gate exits non-zero with an explicit "input-too-large, skipping" stderr message, defaulting to allow. Never blocks on parse failure.
- **Detached HEAD or non-git directory**: gate exits 0 with no message. Never blocks outside a git context.

## Alternatives considered

### Alt 1 — Extend `self-reflect` skill, no new skill (design-minimalist position)

Round-1 design-minimalist argued: self-reflect already contains the picker body; extend it instead of creating a new skill.

**Why rejected**: the discoverability test fails. Self-reflect's keywords match "reflect", "mistake", "correction", "thumbs-down" — not "where to save" or "which scope". An agent mid-task asking "where should I put this rule?" will not load self-reflect. A separate skill with placement-decision vocabulary is required to fire at decision time.

**What v2 takes from this position**: the resolution of the three-coexisting-pickers issue (§D) — strip self-reflect's inline body to a pointer. The canonical body lives in ONE place (placement-picker); self-reflect and task-feedback-reflect become consumers.

### Alt 2 — Picker is a hook only, no skill (socratic Q6)

Round-1 socratic-challenger asked: if the matrix is shell-detectable enough for a hook, why does the LLM need an upfront skill?

**Why rejected**: the matrix isn't fully shell-detectable. Routing requires understanding artifact KIND (a/b/c/d/e), which requires semantic interpretation. The hook does deterministic *post-checks* on path violations; the skill does *upfront guidance* on the routing decision. Both are needed. v2 limits the hook's job to path-only checks consistent with this division of labor.

### Alt 3 — Single PR (design-minimalist position)

Round-1 design-minimalist argued: one PR, two file edits, no new skill.

**Why rejected**: collapsing to a single PR violates the principle "ship the gate first, then move the canonical content." Three PRs (PoC 008 → PR1 gate → PR2 content) ensure no window where canonical content is absent and enforcement is absent simultaneously.

### Alt 4 — `examples.md` as a separate file (v1)

Round-1 design-minimalist + module-interface-auditor: separate file is invisible to skill loaders. v2 inlines examples into SKILL.md.

### Alt 5 — Global env var for strict mode (v1)

Round-1 boundary-critic flagged ownership confusion; round-1 module-interface-auditor F6 + failure-mode F17 noted env-var leakage. v2 switches to per-repo sentinel file `<repo>/.kookr-placement-gate-strict`.

### Alt 6 — Defer entirely to rfc-skill-agent-distribution (Alt 5 in v1)

That RFC covers skills/agents only — not CLAUDE.md tier choice, hook placement, memory vs rule, or KB usage. Insufficient.

### Adversarial-pair resolution (`design-minimalist` vs implicit `ambition-amplifier`)

**Design-minimalist position**: extend self-reflect, no new skill, no new hook, 1 PR.
**Implicit-ambition position** (v1 draft): new skill + new hook + pointer stubs + 3 PRs.

**Resolution**: split the difference. Take the design-minimalist's correct insight (no duplicate picker bodies; existing artifacts must become pointers) — but reject the "extend self-reflect" specific proposal because self-reflect's keywords don't match placement-decision vocabulary. The new skill IS needed; it must be small and narrow; the existing skills become consumers via pointer.

**Rationale**: discoverability at decision time is the binding constraint. Without a skill whose frontmatter matches "where to save", agents will not load anything when they're about to make a placement decision — the picker becomes invisible exactly when it's most needed. The cost of one small skill is justified by closing that discovery gap.

## Open questions

1. **PoC 008 outcome**: do plugin hooks fire under `KOOKR_BYPASS_ALL_PERMISSIONS=true`? PR1 ships either way (advisory mode), but the answer determines whether the picker skill documents bypass as a known coverage gap.
2. **First-week FP telemetry**: should PR1 emit anonymized FP signals to `~/.kookr/hooks/*.jsonl` so a follow-up RFC can decide whether to flip strict mode default? Bias against telemetry by default; revisit if FP reports come in.
3. **Migration of existing decisions** (Open Q4 in v1): keep deferred to a follow-up audit task; not blocking this RFC.
4. **`<kookr>/hooks/skill-placement-gate.sh` final fate**: PR3 in §E names this as optional. Specifically decide after PR1 has run for ≥1 week.

## Acceptance

The RFC is "done" when all five tests below pass:

1. **Discoverability test (plugin loaded)**: start `claude` in `/tmp/empty-repo` with `--plugin-dir <kookr>/plugin`. Prompt: *"I want to add a rule that says agents should always run pnpm typecheck before pushing. Where should I save this?"* **Pass** = `placement-picker` appears in the loaded skills catalog within the first 3 tool calls OR the agent's response cites the picker by name.
2. **Bootstrap fallback test (NO `--plugin-dir`)** — *added in v3 per round-2 R6*: start `claude` directly in `/home/jean/git/kookr` WITHOUT `--plugin-dir`. Same prompt. **Pass** = the agent cites the 18-line routing table from `<kookr>/CLAUDE.md` and gives a non-empty placement recommendation (test verifies the interactive-author bootstrap PR2 is designed to handle).
3. **Codex-runtime parity test**: `codex exec --skip-git-repo-check -C /tmp/empty-repo "<prompt>"` after the kookr Codex fork's overlay is mounted. **Pass** = `placement-picker` is listed in Codex's discovered skills.
4. **Gate path-check test**: with PR1 live, in any repo with `--plugin-dir <kookr>/plugin`, write `<repo>/.claude/skills/myskill/SKILL.md`. **Pass** = stderr warning about prefix convention; no block (advisory).
5. **Real FP test (replaces v2 vacuous test)** — *fixed in v3 per round-2 R6 + socratic Q3*: with `--plugin-dir <kookr>/plugin` loaded, write `~/.claude/projects/<unrelated-slug>/memory/note.md` containing a context paragraph (no behavioral rule), then write `<some-other-repo>/.claude/skills/their-skill/SKILL.md` in a non-kookr repo. **Pass** = zero gate warnings on either (the kookr-prefix rule only fires inside the kookr repo per §C Check 1; the memory frontmatter check is owned by `reflect-memory-frontmatter-gate.sh`, not this gate).
6. **CLAUDE.md size cap**: kookr `CLAUDE.md` lines 153–211 reduced to ≤20 lines in final state. The 18-line table in §C2 is the proposed text.

## Critic feedback incorporated

### Round 2 (2026-05-14) — 4 critics

- **design-minimalist** (round 2): cut Checks 4 and 5 (redundant with `reflect-memory-frontmatter-gate.sh`; install-script-parse fragile, no incident history). Demote PoC 008 from PR0 to informal probe. **All accepted** — v3 §C now has 4 path-prefix checks total; PoC 008 reframed in §E. Confirmed the new skill is still justified on body-shape grounds (1-page routing table vs self-reflect's 200-line post-mortem).
- **failure-mode-analyst** (round 2): R1 (Bash matcher parser unspecified — accepted, v3 §C now enumerates write patterns + documents residual gap). R2 (deny-list ordering — accepted, v3 §C makes deny-list early-return-first). R3 (sentinel under worktrees — accepted, v3 §C uses `--git-common-dir`). R4 (15-line table mathematically tight — accepted, v3 §C2 writes out the literal 18-line table). R5 (`git diff --cached A` wrong tense — accepted, v3 §C uses `git ls-files --error-unmatch`). R6 (acceptance test misses bootstrap fallback — accepted, v3 §"Acceptance" test 2 added). R7 (Codex `apply_patch` invisible — accepted, v3 §C documents as known gap covered by overlay push-time enforcement). R8-R20 (lower-severity items) addressed in §"Files to change" specifics or accepted as residual gap.
- **delivery-pragmatist** (round 2): pre-push regex on line 234 doesn't match `plugin/hooks/` — **Critical, accepted**, v3 §"Files to change" shows the literal 1-line diff. `.kookr-placement-gate-strict` not in `.gitignore` — **Critical, accepted**, v3 §"Files to change" PR1 includes the gitignore entry. Double-enforcement state PR1-vs-old-gate — **accepted as bounded**, v3 §E notes the old gate's checks are a strict subset of the new gate's so overlap is compatible. 15-line table claim — **accepted**, v3 §C2 writes it out literally. PR2 stripped pointers between version bumps — **accepted as pin-version risk**, mitigation: PR2 atomically bumps to 0.7.0 (both pointer creation + canonical body added in same version).
- **socratic-challenger** (round 2): Q1 (binding-constraint discoverability claim) — confirmed as empirical observation grounded in 38 May 2026 sessions, but reframed in v3 as body-shape argument. Q2 (Bash content visibility) — addressed by §C residual-gap documentation; gate is best-effort. Q3 (express FP test is vacuous) — **accepted**, v3 §"Acceptance" test 5 is now a real FP test. Q4 (Q3 per-artifact answer) — accepted, v3 reframes Q3 as one-time env-detect + per-artifact override. Q5 ((s4) for non-kookr users) — accepted, v3 §A marks (s4) as kookr-internal-only. Q6 (PoC 008 ship-either-way contradiction) — accepted, v3 §E demotes PoC 008 from PR0 to informal probe. Q7 (4-bodies vs fix-the-bootstrap) — **deferred**: fixing the bootstrap (e.g. shipping a `.envrc` that injects `--plugin-dir`) is a follow-up RFC; the 18-line table is the safe stopgap.

### Round 1 (2026-05-14) — 6 critics + empirical checkpoint

- **boundary-critic**: Identified the three-coexisting-pickers issue (self-reflect, task-feedback-reflect, CLAUDE.md), ownership ambiguity for plugin gate vs rfc-skill-agent-distribution, semantic-classification category error in §C check 4. **All addressed in v2 §D, §"Files to change" PR3 follow-up note, and §C path-only checks.**
- **failure-mode-analyst**: 20 numbered failure modes. Top blockers F2/F3/F12 (body heuristics), F4 (Codex PreToolUse), F11 (bypass survival), F15 (gate over-fires on edit-of-existing), F17 (env-var leak), F18 (plugin manifest schema). **F2/F3/F12 addressed by path-only checks; F4 addressed by dual matcher in v2 §C; F11 named as PoC 008 prerequisite; F15 addressed by `git diff --cached` A-status filter; F17 addressed by sentinel file; F18 addressed by empirical probe (Claim 1 falsified — fixed mechanism).**
- **design-minimalist**: argued for extend-self-reflect, cut PR3 entirely, advisory mode is theater. **Partial accept**: kept the new skill (discoverability argument prevails) but stripped redundant content from self-reflect / task-feedback-reflect (the "no duplicate picker bodies" point is correct). Cut body-heuristic checks from gate (advisory-mode-is-theater concern addressed by switching to deterministic path-only checks). Recorded in adversarial-pair resolution §"Alternatives considered".
- **socratic-challenger**: 8 probing questions. Q1 (visibility vs trigger gap) and Q2 (bootstrap trigger) addressed by §B frontmatter specifying placement-decision vocabulary. Q3 (overlay dynamism) verified by empirical probe Claim 4. Q4 (self-reflect picker fate) addressed by §D. Q5 (kookr-specific in user CLAUDE.md anti-pattern is a retcon) — accepted partially; v2 keeps the anti-pattern but acknowledges Migration of existing rules is out-of-scope. Q6 (one hook, zero skill) addressed in §"Alternatives considered" Alt 2. Q7 (advisory signal strength) addressed by path-only enforcement. Q8 (acceptance criterion unfalsifiable) addressed by §"Acceptance" rewrite.
- **delivery-pragmatist**: 7 findings, 3 Critical. Plugin manifest hook registration **falsified by empirical probe — fixed in v2 §C with `hooks/hooks.json` sidecar**. PR1/PR2 version bumps **added** to "Files to change". Interactive-author bootstrap **addressed by 15-line minimum effective routing table in kookr CLAUDE.md** (not 5-line stub). PR ordering **reversed** (gate first). `skill-placement-gate.sh` deletion **moved to optional follow-up PR3 in §E**. `plugin/hooks/` pre-push version-bump coverage **added** in §"Files to change" PR1.
- **module-interface-auditor**: 6 findings. F1 (skill frontmatter unspecified) addressed in §B with full frontmatter. F2 (s4 leaks kookr-specific) addressed by renaming s4 to "this repo's internal workflows" with repo-prefix guidance. F3 ((b)(s2) disjunction) addressed by promoting cross-runtime to Q3 in §A. F4 (calibration question scope) addressed by limiting it to rules/procedures/guards only. F5 (plugin-skill-recommended-but-no-plugin-tree fallback) addressed in §B body section 7. F6 (env var belongs to hook interface) addressed by moving strict-mode to sentinel file + documenting in `plugin/hooks/README.md`.

### Empirical checkpoint (2026-05-14) — design-experimenter probed 4 load-bearing claims

- **Claim 1 (hooks register in plugin.json)**: **FALSIFIED**. Real mechanism is `plugin/hooks/hooks.json` sidecar. v2 §C updated.
- **Claim 2 (Codex PreToolUse fires for Write/Edit)**: **PARTIAL**. Codex emits PreToolUse only for `Bash` per PoC 003 Gap 6. v2 §C adds `Bash` matcher with command-pattern filter.
- **Claim 3 (plugin hooks survive bypass mode)**: **PARTIAL — medium confidence**. Structural evidence suggests yes but no empirical proof. PoC 008 named as PR1 dependency.
- **Claim 4 (dir-symlink overlay is dynamic)**: **VERIFIED**. New plugin skills are visible to Codex immediately on next task launch.

### Adversarial-pair resolution

See §"Alternatives considered" — `design-minimalist` vs implicit ambition resolved with hybrid: new skill (discoverability) + strip-existing-bodies (no duplication) + path-only gate (no heuristic theater).

### Invocation log

- `failure-mode-analyst` 2026-05-14 round-1: novel finding (F4 cross-runtime, F18 plugin manifest, F2/3/12 heuristic FP) — incorporated.
- `design-experimenter` 2026-05-14 empirical: novel finding (Claim 1 falsified, Claim 2 partial) — incorporated.
