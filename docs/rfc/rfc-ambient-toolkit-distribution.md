# RFC: Ambient Kookr-Managed Toolkit Distribution

## Status

**WITHDRAWN (2026-05-30) — superseded by Alt 1 (`/plugin install`).**
**Draft v2 — post-round-1 critic review + empirical checkpoint**
**Date:** 2026-05-30
**Author:** Jean Ibarz (with Claude)

### Decision

After round-1 review + the empirical checkpoint, the author chose **Alt 1**: keep the
existing marketplace mechanism (`/plugin install kookr-toolkit@kookr` once per machine,
accept GitHub-sourced drift) and **not** build the ambient symlink/install machinery. The
review established that the real gap this RFC closed is narrow (§0): Kookr-spawned agents
already get the toolkit via `--plugin-dir`, and any session gets it after one
`/plugin install`. The mechanism's maintenance tax (generalized linking, collision/orphan
detection, a disable cutover that rewrites invocation notes + the placement-gate hook, two
unresolved agent-discovery probes) was judged not worth that narrow benefit.

This document is retained — not deleted — as the record of *why*, so the question isn't
re-litigated. The empirically-verified facts below remain useful (drift mechanics,
`--plugin-dir` atomicity, the small real cutover blast radius, the unnecessary copy layer).

### Concrete follow-through for the chosen path
- The plugin is already installed + enabled (`enabledPlugins["kookr-toolkit@kookr"]: true`)
  but **drifted**: cache `0.4.1`/commit `0f0600f` vs source `0.7.4`. Run
  **`/plugin marketplace update kookr`** to refresh it — effective only once `0.7.4` is on
  `origin/main` (the marketplace pulls from GitHub, not the local tree).
- **Residual Codex gap (accepted, not addressed):** the forked Codex CLI does not read the
  Claude Code plugin registry, so `/plugin install` does nothing for it. Kookr-*spawned*
  Codex sessions still get the toolkit via `--plugin-dir` injection (where the fork advertises
  the flag). The only uncovered slice is **hand-started forked-Codex sessions outside Kookr** —
  judged rare enough to accept. If it ever matters, the cheapest fix is the skills-only
  symlink slice (PR-1 below), not the full RFC.

---

**Major revisions in v2 (round-1 incorporation + empirical checkpoint):**
- **Dropped the `~/.kookr/plugin/` copy layer.** Symlinks point directly at the existing
  `kookr-prod/plugin/` tree — the same target the stale-toolkit RFC already designated
  canonical and the same mechanism the 3 live symlinks use today. Removes `.installed.json`,
  boot-time sync, and the version-drift detection axis (§D.1). (design-minimalist +
  socratic-challenger + boundary-critic converged; empirically confirmed — see Critic
  feedback.)
- **Struck the "retain `--plugin-dir` for agents only" escape hatch** — empirically CONFIRMED
  impossible: `--plugin-dir` is one atomic flag serving both `plugin/skills/` and
  `plugin/agents/` (`claude-code-adapter.ts:289`, `plugin-paths.ts`).
- **Demoted Goal 4 and the collision-diagnostic claim.** The diagnostic *surfaces* a
  collision; it does not *resolve* it, and it is silent in the headline "Kookr not running"
  case. The RFC no longer claims this "answers" the prior rejection — instead it explicitly
  **supersedes the prior RFC's Design Principle 4** (see §0).
- **Cutover blast radius measured (was "Open Q1").** Empirically: **zero** executable
  `subagent_type:"kookr-toolkit:…"` calls; **4 invocation-note lines** plus the placement
  hook to reconcile. Sequenced *before* the plugin is disabled. (See §E, Migration.)
- **Agents split from skills into a separate, probe-gated phase.** Native Claude Code
  user-scope agent resolution (filename vs frontmatter) and forked-Codex `~/.claude/agents/`
  reading are both UNDETERMINED; skills are well-understood (3 ship this way today). Agents
  ship only after two cheap external probes (Open Q1/Q2).

**Relationship to prior art:** Amends the *delivery layer* of
[`rfc-skill-agent-distribution.md`](./rfc-skill-agent-distribution.md) (v3.1, landed via
#239/#240/#241/#263) and the symlink-health work in
[`rfc-stale-toolkit-symlink-refresh.md`](./rfc-stale-toolkit-symlink-refresh.md). It does
**not** touch the two-home authoring model. It explicitly supersedes that RFC's **Design
Principle 4** (§0 below) and its **Alt 4** rejection, and overrides its §F (`--plugin-dir` as
the sole Claude Code ship mechanism) and §G (per-task Codex overlay) on maintainer machines.

---

## 0. Premise check (decide this first — author/user only)

The entire RFC rests on one requirement that a critic round cannot settle:

> *"The toolkit must be available in a Claude Code or forked-Codex session I start by hand,
> in some other repo, with Kookr not necessarily running."*

Two facts bound how much this is worth:

- **Kookr-spawned agents already have the toolkit** via `--plugin-dir` injection. This RFC
  changes nothing for them except *how* they get it.
- **Any session already gets the toolkit after one `/plugin install kookr-toolkit@kookr`** —
  it loads in every Claude Code session for that user, no Kookr involvement. The only gap is
  (a) hand-started sessions on a machine where that one-time install was never done, and
  (b) the forked Codex, which can't read the Claude Code plugin registry.

**So the honest scope is narrow:** this RFC buys ambient availability for hand-started
sessions *without* the one-time marketplace install, plus Codex parity. If the maintainer is
willing to run `/plugin install` once per machine and accept the marketplace's
GitHub-sourced drift, **most of this RFC is unnecessary** and the residual Codex gap is
smaller. The author must decide the requirement is real and frequent enough to justify the
mechanism below **before** implementation. This is recorded as the top open decision, not
assumed away. (Raised by socratic-challenger Q5/Q6; see Critic feedback.)

If the requirement holds, the design below is the minimal mechanism that satisfies it.

### Superseding prior Design Principle 4

The prior RFC's Design Principle 4 was: *"User-scope is for personal deps Kookr does not
own. Stay out of `~/.claude/skills/*` and `~/.claude/agents/*`…"* — and its Alt 4 rejection
had **two** clauses: (1) "violates user-scope as user-owned," and (2) "silent regression with
no diagnostic." A diagnostic addresses only clause (2). This RFC does **not** pretend clause
(1) is dissolved by a TopBar badge. It instead **formally revises Principle 4**:

> *Revised Principle 4: Kookr may own a defined, namespaced set of symlinks under
> `~/.claude/{skills,agents}/` — exactly the toolkit it ships — provided (a) it never
> clobbers a user-owned non-symlink, and (b) collisions are surfaced. Everything else in
> user-scope remains user-owned and untouched.*

This is a deliberate ownership change, justified by the §0 requirement, not a reinterpretation
of the old principle. The prior RFC already carved out 3 such symlinks
(`pre-pr-review`, `pr-contribution-excellence`, `reviewer-specialists`) — this RFC
generalizes that existing, shipped exception and names it as policy.

## Problem

The landed two-home model reaches the toolkit (57 skills + 17 agents in `<kookr>/plugin/`)
through two paths only: `--plugin-dir` injection (Kookr-spawned sessions) and an opt-in
marketplace install. Neither covers a hand-started session, outside Kookr, in another repo,
without the one-time install — and the marketplace path additionally (a) clones the whole
Kookr repo and (b) is GitHub-sourced, so it drifts from local source (observed: cache
`0.4.1`/commit `0f0600f` vs source `0.7.4`). The forked Codex can't read the Claude Code
plugin registry at all, so for Codex the marketplace path doesn't even exist.

## Goals

1. **Ambient availability.** Toolkit skills (and, gated, agents) present in every Claude
   Code session and every forked-Codex session on a Kookr maintainer machine, with no
   per-session Kookr involvement and no marketplace opt-in.
2. **Works without Kookr running.** Availability is a static filesystem fact (symlinks).
3. **No new drift surface.** Reuse the existing `kookr-prod`-as-canonical model and its
   existing deploy-status freshness machinery; introduce no second mutable copy.
4. **No silent *clobber*.** Never overwrite a user-owned non-symlink; surface collisions
   while Kookr is running. (Note: this does **not** claim collisions are *resolved* — see §0
   and Edge case 1.)
5. **Single source of truth per tool.** A skill resolves under one name per session.

## Non-goals

- The two-home authoring model; how skills/agents are written. Unchanged.
- Personal-deps user-scope skills/agents (`kb-scout`, `knowledge-base`, `graphify`,
  `local-research-agent`, `ui-visual-verification`, `playwright-video-verification`).
- Removing the public marketplace listing (kept for external GitHub discovery).
- Splitting the toolkit into multiple plugins (prior Alt 2 — still rejected).
- A unified refresh surface spanning hooks + playbooks + skills + agents (ambition-amplifier
  proposed it; deferred — see Critic feedback). Hooks keep `install-hooks.sh`; playbooks keep
  `~/.kookr/playbooks/`.

## Design

### A. Symlink directly into the existing canonical tree — no copy

For each skill (and, gated, agent), Kookr creates a per-item symlink:

```
~/.claude/skills/<skill>  ->  <kookr-prod>/plugin/skills/<skill>
~/.claude/agents/<agent>  ->  <kookr-prod>/plugin/agents/<agent>   (gated — §C)
```

`kookr-prod` is already the canonical, deploy-managed tree (`pnpm prod:update` advances it
in place; it does **not** rotate paths), already the symlink target the 3 live toolkit
symlinks use, and already the tree whose freshness the deploy-status popover tracks. So:

- **No `~/.kookr/plugin/` copy, no `.installed.json`, no boot-time sync, no version-drift
  axis.** Content is live; "is the toolkit current?" reduces to the *existing* question "is
  `kookr-prod` behind `origin/main`?", which the deploy-status machinery already answers.
- **Per-item, not whole-dir** — `~/.claude/skills/` also holds the user's own and
  personal-deps skills, so the directory itself can't be replaced.

`scripts/install-hooks.sh` already provides every primitive: `install_skill_symlink`,
`install_plugin_asset_symlink`, the non-symlink **clobber guard**, `uninstall_*`, and
`--print-global-assets`. The change is to **enumerate all `plugin/skills/*`** (and, gated,
`plugin/agents/*`) instead of the hardcoded three, and to add **orphan pruning** on refresh
(remove a `~/.claude/...` symlink that points into `kookr-prod/plugin/` but whose target no
longer exists — `lstat` + `readlink` + target-prefix check; never touch a symlink pointing
elsewhere). Enumeration must stay a single source of truth: the script enumerates the
filesystem and emits the list via `--print-global-assets`; `toolkit-symlink-status.ts`
consumes that list (no second hardcoded list in TS). (boundary-critic finding.)

### B. Why per-item symlinks, not "install/forge the plugin"

Claude Code loads a plugin only via a four-part private registry
(`enabledPlugins` + `known_marketplaces.json` + `installed_plugins.json` v2 with
`gitCommitSha` + a versioned `cache/.../installPath`). Forging that is brittle and
**Claude-Code-only** — the forked Codex doesn't implement it. Per-item symlinks into
`~/.claude/{skills,agents}/` are the only substrate both tools read.

### C. Agents ship in a separate, probe-gated phase

Skills via user-scope symlinks are well-understood — 3 already ship this way. **Agents are
not**: two facts are UNDETERMINED and must be probed before agent symlinks ship (see Open
Questions):

- **Q1:** Does Claude Code's *native* user-scope agent discovery resolve
  `subagent_type:"boundary-critic"` from `~/.claude/agents/boundary-critic.md`, and does it
  key on filename or frontmatter `name:`? (Kookr's *bypass-mode* re-injection keys on
  frontmatter `name:` — `file-based-agents.ts` — but that's a different path. All 17 plugin
  agents have filename == frontmatter name, so the two agree today regardless.)
- **Q2:** Does the forked Codex read `~/.claude/agents/` at all? (It reads `~/.claude/skills/`
  per the prior RFC's `loader.rs:479–487` check; the agents path is unverified and the Codex
  source is external to this repo.)

If either probe fails, agents stay on `--plugin-dir`/the existing path and only **skills** go
ambient. Skills-only still delivers the bulk of the §0 value.

### D. Detection — generalize the existing collision check; add nothing else

The existing detector (`toolkit-symlink-status.ts`) **already** classifies a user-owned
same-named directory as `not-symlink` — i.e. collision detection already exists, for the 3
tracked assets. The only change is to **enumerate all toolkit items** (via §A's generalized
`--print-global-assets`) so the existing TopBar surface reports drift/broken/collision across
the full set, and to prune orphans on refresh. **No version-drift axis** (eliminated with the
copy), **no boot-time mutation**. `POST /api/deploy/toolkit-refresh` keeps its current shape
(re-run `install-hooks.sh`), now over the full set, and must report **partial success**
(N of M linked; K collisions skipped) rather than a single ok/fail. (failure-mode +
boundary-critic findings.)

### E. Single-source cutover (kill double-load), correctly sequenced

With `--plugin-dir` atomic (CONFIRMED), there is no "skills-only" disable. The cutover is:

1. **Reconcile the 4 invocation-note lines first** (own PR, before anything is disabled):
   `rfc-iterative-review/SKILL.md:60`, `pre-pr-review/SKILL.md:155,181`,
   `kookr-skill-naming-convention/SKILL.md:90`. These tell the model to prepend
   `kookr-toolkit:`. After the plugin is disabled, the qualified name won't resolve, so the
   notes must change to the form that *will* resolve (bare name, once Open Q1 confirms
   bare-name agent resolution). **Also reconcile `skill-placement-gate.sh`**, which the
   round-1 critic reports *enforces* the qualified form — the gate must be updated in the
   same PR or it will reject the rewritten notes. (This is the real, now-measured "Open Q1"
   blast radius: small and knowable, but it includes the hook.)
2. **Only then** set `settings.json#enabledPlugins["kookr-toolkit@kookr"] = false` and drop
   `--plugin-dir` injection from the adapters — atomically with re-confirming the symlinks
   are complete. Because this also drops agents from `--plugin-dir`, it is gated on §C's
   probes passing; if they don't, keep `--plugin-dir` (which keeps the plugin, which means
   *don't* disable it) and accept that skills are double-named until the probes are resolved
   — i.e. ship skills ambient but defer the disable.

Note the coupling the cutover must respect: `git revert` of the disable PR restores
`--plugin-dir` in code but **not** the manual `settings.json` edit — rollback is two-part and
must be documented. (delivery-pragmatist finding.)

### F. Codex

Ambient `~/.claude/skills/` symlinks already make skills visible to every Codex session
(skills-dir reading is verified). Agents depend on Open Q2. The prior RFC's per-task overlay
(never landed) is moot. Where the fork advertises `--plugin-dir`, that path remains harmless
alongside the symlinks (same content) but the symlinks are preferred per §E.

## Separate repository for the plugin? — Recommendation: **No (not now)**

The `/plugin marketplace add` whole-repo clone is real (confirmed 280 KB+, full `src/`/`.git`)
but becomes irrelevant once Kookr machines stop using the marketplace path. Splitting fights
the "Kookr ships & manages it" model (the plugin's agents drive Kookr's own RFC-review;
`plugin.json` version bump is pre-push-enforced; skills co-evolve with Kookr). If external
clone size ever bites, the additive/reversible fix is a **CI git-subtree mirror** to a thin
read-only `kookr-toolkit` repo, monorepo staying source of truth. Defer until external demand.

## Files to change (sketch)

**PR-1 — generalize linking + collision/orphan over the full set (skills first)**
- `scripts/install-hooks.sh` — enumerate all `plugin/skills/*` (and, when §C unblocks,
  `plugin/agents/*`); add orphan prune; keep clobber guard; `--print-global-assets` emits the
  full list. Define per-item continue-on-collision (no `set -e` abort mid-sweep).
- `src/server/toolkit-symlink-status.ts` — consume the full list; report collisions/orphans;
  partial-success shape. **Keep deploy-health and collision concerns separable** so a
  collision-report failure can't suppress the existing TopBar `stale` signal. (boundary-critic.)
- `src/server/routes/deploy-routes.ts` / `TopBar.tsx` — surface counts; partial-success.
- **Pre-step (one-time, documented):** delete the stale real-dir shadow
  `~/.claude/skills/oss-task-checkpointing/` (the prior RFC's manual step was never run on
  this machine — confirmed). Otherwise the clobber guard silently skips it forever.

**PR-2 — invocation-note + placement-gate reconciliation** (only if pursuing the disable)
- Rewrite the 4 notes (§E.1) + `skill-placement-gate.sh` + its fixtures.

**PR-3 — disable cutover** (gated on §C probes + PR-2)
- `enabledPlugins[...]=false` (documented host step, two-part rollback noted); drop
  `--plugin-dir` injection. If §C probes fail, this PR is skills-ambient-only and the disable
  is deferred.

## Edge cases

1. **Collision (user owns a same-named skill).** Never clobbered; reported while Kookr runs.
   The user's skill wins and the toolkit version stays invisible — this is **not resolved**,
   only surfaced, and in the "Kookr not running" case not even surfaced. Accepted limitation
   (§0). The escape is the user deleting their shadow; Kookr will not.
2. **Existing 3 symlinks already point at `kookr-prod`.** PR-1's generalized run re-asserts
   them at the same target — a no-op, not a repoint. (No `~/.kookr/plugin/` indirection means
   no "target doesn't exist yet" window.)
3. **`oss-task-checkpointing` stale real-dir shadow** — handled by PR-1's documented
   pre-step.
4. **Skill vs agent name resolution differ.** Skills key on directory name; Kookr's
   bypass-mode agent re-injection keys on frontmatter `name:`; native CC agent resolution is
   Open Q1. Align filename == frontmatter `name:` for all agents (already true for all 17).
5. **`kookr-oss-issue-scout`** — the prior RFC's §C/§D text about an `oss-issue-scout` agent
   is stale; the real project agent is `.claude/agents/kookr-oss-issue-scout.md` and the
   playbook already calls `kookr-oss-issue-scout`. Not in this RFC's path, but noted so the
   prior RFC's residual cleanup isn't mis-scoped.

## Alternatives considered

### Alt 1 — Just `/plugin install` once per machine, accept marketplace drift
The cheapest option and the real baseline (§0). Rejected **only if** the §0 requirement holds
(hand-started sessions without the install, + Codex parity). If the author judges the
requirement marginal, **this is the recommendation** and the rest of the RFC is dropped.

### Alt 2 — `~/.kookr/plugin/` copy + drift detection (this RFC's v1)
Rejected: the copy creates the very drift it then needs machinery to detect; `kookr-prod` is
already canonical and stable. (design-minimalist; empirically confirmed.)

### Alt 3 — Forge/symlink the Claude Code plugin into the registry
Rejected (§B): Claude-Code-only; brittle private format.

### Alt 4 — Separate plugin repo
Rejected for now (see above); CI subtree mirror is the deferred escape hatch.

### Alt 5 — Unified `~/.kookr/plugin/` → `~/.claude/` sweep over hooks+playbooks+skills+agents
Deferred (ambition-amplifier). The artifact types have different install semantics and
different drift characteristics; folding them into one refresh surface is a larger change
than the §0 requirement needs. Revisit if a second artifact type starts drifting.

## Open questions

1. **(Load-bearing, cheap, gates agent symlinks.)** Does native Claude Code resolve a
   bare-name user-scope agent (`~/.claude/agents/boundary-critic.md` →
   `subagent_type:"boundary-critic"`), and filename vs frontmatter? Runtime probe required.
2. **(Gates Codex agent parity.)** Does the forked Codex read `~/.claude/agents/`? Probe via
   `strings $(which codex) | grep '.claude/agents'` or the `jeanibarz/codex` fork loader.
3. **§0 — is the ambient requirement real and frequent enough to justify this over Alt 1?**
   Author/user decision; everything else is gated on "yes."

## Acceptance / done

- A hand-started `claude` (and, if Open Q1/Q2 pass, forked `codex`) in an unrelated repo,
  **with Kookr not running**, lists the toolkit skills (and resolves a toolkit agent).
- `~/.claude/skills/<skill>` are symlinks into `kookr-prod/plugin/skills/` for every plugin
  skill (minus reported collisions); **no `~/.kookr/plugin/` copy exists**.
- TopBar reports collisions + orphans over the full set; refresh re-links + prunes without
  clobbering non-symlinks; partial success reported.
- If the disable cutover is pursued: 4 notes + placement gate reconciled *before* the disable;
  no skill loads under two names; two-part rollback documented.
- `plugin/` stays in the monorepo.

## Critic feedback incorporated

### Round 1 (2026-05-30) — 6 critics + empirical checkpoint

**failure-mode-analyst** — incorporated: partial-success reporting for refresh; orphan-prune
predicate must be `lstat`+target-prefix (never delete a user symlink); collision is
"surfaced not prevented" and silent when Kookr is down (drove Goal-4 demotion + §0).
*Rejected:* the "two-root mismatch" (Finding 10) — empirically REFUTED (`install-hooks.sh`
runs with `cwd=prodDir`, roots identical). Several copy-layer failure modes (sync race,
half-applied copy, `.installed.json` absent) became moot when the copy was dropped.

**design-minimalist** — incorporated, decisively: dropped the `~/.kookr/plugin/` copy,
`.installed.json`, boot-sync, and the version-drift axis; collapsed PR-A/B/C toward the
minimal set; kept only the collision axis (already exists). This is the single largest v2
change.

**ambition-amplifier** — incorporated: resolve the `subagent_type` blast radius *now* (done —
empirical checkpoint measured it: 4 notes + the placement gate); automate/assert the
`enabledPlugins` state rather than leave it a silent manual step (noted as the two-part
rollback coupling). *Deferred:* the unified hooks+playbooks+skills+agents refresh surface
(Alt 5) — larger than the §0 requirement warrants. *ambition-amplifier 2026-05-30: novel
finding* — the agent-discovery (Q1/Q2) gap was under-specified; drove §C's probe-gated split.

**Adversarial-pair resolution (design-minimalist vs ambition-amplifier):** on the central
axis — copy layer + scope — **design-minimalist won.** The empirical check confirmed the live
symlinks already point at `kookr-prod` and work, so the copy and its drift machinery were
solving a self-inflicted problem; ambition's bigger unified-refresh surface (Alt 5) is
deferred because no second artifact type is drifting today. ambition's *one* adopted push —
measure the cutover blast radius now rather than defer it — was correct and is done.

**boundary-critic** — incorporated: keep deploy-health and collision concerns separable in
the detector; enumeration stays single-source (script enumerates, TS consumes); explicitly
**supersede Design Principle 4** rather than silently override it (§0); resolve the
`enabledPlugins` ownership question (it's a host step Kookr already partially owns via
`install-hooks.sh` jq edits — acknowledged, two-part rollback documented).

**socratic-challenger** — incorporated: stop strawmanning the prior Alt-4 rejection (it had
two clauses; the diagnostic addresses only one) → §0 supersedes Principle 4 honestly; the
collision diagnostic "relabels, not resolves" → Goal 4 demoted; **the §0 premise check** (is
the requirement real vs just `/plugin install` once?) is now the top open decision; "why copy
at all" → copy dropped.

**design-experimenter (empirical checkpoint, 2026-05-30)** — verdicts:
- `--plugin-dir` atomicity: **CONFIRMED** — no agents-only injection. Escape hatch struck.
- Cutover blast radius: **measured** — 0 executable qualified callers; 4 invocation notes
  (+ placement gate). "Open Q1" reframed from unknown to known-small.
- `~/.kookr/plugin/` copy unnecessary: **CONFIRMED** — live symlinks point at `kookr-prod`
  and work; no copy exists today.
- Two-root mismatch: **REFUTED**.
- Native CC bare-name agent resolution + Codex `~/.claude/agents/` reading: **UNDETERMINED**
  → §C probe-gated agent phase (Open Q1/Q2).
- Stale `oss-task-checkpointing` real-dir + `kookr-oss-issue-scout` naming: **CONFIRMED** →
  Edge cases 3/5.

### Convergence note
Round 1 + the empirical checkpoint reshaped the premise (copy dropped, blast radius measured,
atomicity confirmed) and surfaced one decision only the author can make (§0). Per
`rfc-iterative-review`, the correct next step is author input on §0, not another speculative
critic round against a design whose central simplification is already settled. Round 2 should
run only after §0 is answered "yes" and Open Q1/Q2 are probed.
