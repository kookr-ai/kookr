# RFC: Ambient Kookr-Managed Toolkit Distribution

## Status

**Draft v1 — pre-review (ready for `rfc-iterative-review`)**
**Date:** 2026-05-30
**Author:** Jean Ibarz (with Claude)

**Relationship to prior art:** This RFC *amends the delivery layer* of
[`rfc-skill-agent-distribution.md`](./rfc-skill-agent-distribution.md) (v3.1, landed via
PRs #239/#240/#241/#263) and the symlink-health work in
[`rfc-stale-toolkit-symlink-refresh.md`](./rfc-stale-toolkit-symlink-refresh.md) (#263+).
It does **not** touch the two-home authoring model (kookr-internal skills in
`<kookr>/.claude/skills/`, general-purpose skills + all agents in `<kookr>/plugin/`) —
that stays exactly as shipped. It revisits one alternative the prior RFC **rejected**
("Alt 4 — symlink `plugin/` into `~/.claude/`") under a requirement the prior RFC never
had, and supersedes the prior RFC's §F (`--plugin-dir` as the single Claude Code ship
mechanism) and §G (per-task Codex overlay) on maintainer machines.

---

## Problem

The landed two-home model makes the curated toolkit (57 skills + 17 review agents in
`<kookr>/plugin/`) reachable through exactly two paths:

1. **Kookr-spawned agents** — `ClaudeCodeAdapter`/`CodexCliAdapter` inject
   `--plugin-dir <kookr>/plugin` (codex only when the fork advertises the flag, probed via
   `--help`). Requires Kookr to spawn the session.
2. **Opt-in marketplace install** — `/plugin marketplace add kookr-ai/kookr` +
   `/plugin install kookr-toolkit@kookr`. Requires an explicit per-machine opt-in.

Neither path covers the case the maintainer actually hits daily: **a Claude Code or forked
Codex session started by hand, in some other repo, with Kookr not spawning it (and possibly
not running at all).** In that session the toolkit is invisible.

The marketplace path also has two concrete defects observed on this machine:

- **It clones the entire Kookr repo.** `~/.claude/plugins/marketplaces/kookr/` is a full
  280 KB+ working tree (`src/`, `docs/`, `e2e/`, `.git`) cloned just to read `plugin/`.
- **It drifts, sourced from GitHub not the local tree.** `installed_plugins.json` pins
  `kookr-toolkit@kookr` to `installPath …/cache/kookr/kookr-toolkit/0.4.1`
  (commit `0f0600f`) while the local `plugin/.claude-plugin/plugin.json` is already at
  **0.7.4**. Claude Code's updater pulls from the GitHub remote on
  `/plugin marketplace update`, so it will never reflect un-pushed local edits and *fights*
  any locally-managed copy.

The prior RFC's Codex answer (§G) was a **per-task** `<cwd>/.claude/skills` symlink overlay
created at launch and cleaned up at task end — by design it only exists while a Kookr task
runs. It explicitly did **not** attempt ambient availability, and it explicitly rejected
"vendor into user-scope" to avoid polluting non-Kookr Codex sessions.

**Net gap:** there is no Kookr-*managed* way to make the toolkit ambiently present in every
local agent session (Claude Code and the forked Codex), independent of Kookr spawning or
running, with drift owned by Kookr rather than Claude Code's marketplace updater.

## Goals

1. **Ambient availability.** Every Claude Code session *and* every forked-Codex session on a
   Kookr maintainer machine sees the toolkit skills + agents, with no per-session Kookr
   involvement and no marketplace opt-in.
2. **Works without Kookr running.** Availability is a static filesystem fact (symlinks),
   durable across Kookr being down.
3. **Kookr owns drift.** Kookr — not Claude Code's marketplace updater — detects when the
   installed toolkit is behind source and repairs it. No GitHub round-trip; no whole-repo
   clone.
4. **No silent shadowing — with a diagnostic.** When a user-owned same-named skill/agent
   blocks a toolkit link, that collision is *surfaced* (the precise failure the prior RFC's
   Alt 4 rejection was about), not silent.
5. **Single source of truth per tool.** A given skill resolves under exactly one name in a
   given session — no double-load as both `kookr-toolkit:foo` (plugin) and `foo` (symlink).

## Non-goals

- Changing the **two-home authoring model** or how skills/agents are written. Unchanged.
- Distributing the maintainer's **personal-deps** user-scope skills/agents (`kb-scout`,
  `knowledge-base`, `graphify`, `local-research-agent`, `ui-visual-verification`,
  `playwright-video-verification`) — they stay user-scope, outside this RFC (per
  `feedback_user_scope_when_deps_personal` and the prior RFC's Non-goals).
- Removing the **public marketplace listing**. `marketplace.json` stays for *external*
  GitHub discovery. This RFC only changes how the toolkit is delivered **on Kookr-managed
  machines** (which stop relying on the marketplace self-install).
- Splitting the toolkit into multiple plugins (prior RFC Alt 2 — still rejected).

## Design

### A. Canonical install at `~/.kookr/plugin/`

Kookr maintains a canonical copy of the plugin tree at **`~/.kookr/plugin/`**, synced from
the deploy tree (the `kookr-prod` worktree already used as the symlink target in
`rfc-stale-toolkit-symlink-refresh.md`). This fits the established `~/.kookr/` convention —
`~/.kookr/{hooks,settings,playbooks,sessions,...}` already live there, and
`CodexCliAdapter` already defaults `~/.kookr/hooks` + `~/.kookr/settings`. In particular
`~/.kookr/playbooks/` is *already* the precedent for a user-scope dir "visible in every
project."

`~/.kookr/plugin/` is a **copy**, not a symlink to the checkout, for three reasons:

- It decouples ambient availability from the checkout path — directly fixing the
  `mismatch`/`target-missing` fragility today, where links point into a `kookr-prod/…`
  worktree that rotates on deploy.
- It gives a stable "installed version" (`~/.kookr/plugin/.installed.json`: version +
  source commit) to compare against source for drift.
- Maintainer live-editing is unaffected: the `claude --plugin-dir ~/git/kookr/plugin` +
  `/reload-plugins` dev loop still reads source directly.

### B. Per-item symlinks into `~/.claude/{skills,agents}/`

For each skill and agent under `~/.kookr/plugin/`, Kookr creates:

```
~/.claude/skills/<skill>  ->  ~/.kookr/plugin/skills/<skill>
~/.claude/agents/<agent>  ->  ~/.kookr/plugin/agents/<agent>
```

**Per-item, not a whole-dir symlink** — `~/.claude/skills/` also holds the user's own and
personal-deps skills, so the directory itself can't be replaced. This is read by **both**
Claude Code (user-scope skill/agent discovery) and the forked Codex CLI (same convention),
needs no running server, and needs no Claude Code plugin registry. The plugin contains only
`skills/`, `agents/`, `playbooks/`, `reviewer-specialists/`, and a `hooks/` dir — **no slash
commands, no MCP servers** — so per-item symlinks lose no plugin-container feature. Hooks
keep their existing `install-hooks.sh` path; playbooks keep `~/.kookr/playbooks`;
`reviewer-specialists` keeps its existing asset symlink.

`scripts/install-hooks.sh` already provides every primitive: `install_skill_symlink`,
`install_plugin_asset_symlink`, `uninstall_*`, the **non-symlink clobber guard** ("Refusing
to overwrite non-symlink…"), and `--print-global-assets`. The change is to (1) source from
`~/.kookr/plugin/` instead of the checkout, and (2) iterate **all** skills + agents instead
of the current hardcoded three.

### C. Why per-item symlinks, not "symlink the plugin"

Claude Code does not load a plugin from a directory's mere presence. It is a four-part
private registry that must agree: `settings.json#enabledPlugins`,
`plugins/known_marketplaces.json`, `plugins/installed_plugins.json` (schema `version: 2`,
with `gitCommitSha`), and a versioned `plugins/cache/<mkt>/<plugin>/<ver>/` `installPath`.
Symlinking a plugin would mean forging/maintaining that undocumented registry — and it is
**Claude-Code-only**: the forked Codex CLI does not implement this registry (it reads the
plain `~/.claude/skills` + `~/.claude/agents` convention). Per-item symlinks are the only
substrate that serves **both** tools and is robust against Claude Code registry changes.

### D. Drift + collision detection (Kookr-owned)

Extend `src/server/toolkit-symlink-status.ts` from "is each symlink valid?" to two added
axes, surfaced through the existing `/api/deploy/status` → TopBar affordance:

1. **Version drift.** Compare `~/.kookr/plugin/.installed.json#version` against the source
   tree's `plugin/.claude-plugin/plugin.json#version`. Source newer ⇒ stale ⇒ offer
   re-sync.
2. **Collisions (Goal 4 — the answer to Alt 4's rejection).** For every skill/agent in
   `~/.kookr/plugin/` whose `~/.claude/...` target is a **non-symlink** (user owns a
   real same-named dir) or a symlink to a non-Kookr target, report it as
   `shadowed`. The TopBar shows e.g. *"2 toolkit skills shadowed by user-scope files:
   `error-handling-patterns`, `tdd-workflow`."* This converts Alt 4's *silent* regression
   into a visible, actionable diagnostic.
3. **Orphans.** A `~/.claude/...` symlink that points into `~/.kookr/plugin/` but whose
   target no longer exists (skill deleted from source) ⇒ prune on refresh.

`POST /api/deploy/toolkit-refresh` is generalized: re-sync `~/.kookr/plugin/` from the
deploy tree, then re-run the (generalized) `install-hooks.sh` to add new links, repair
broken ones, and prune orphans — never clobbering non-symlinks (collisions stay reported,
never overwritten). Kookr also runs this sync once on server boot, so "auto-update on drift"
needs no manual step on a running instance.

### E. Single-source-of-truth cutover (kill double-load + name divergence)

With every skill symlinked into `~/.claude/skills/`, a Claude Code session that *also* has
the plugin enabled would load each skill twice — once as `kookr-toolkit:foo` (plugin) and
once as `foo` (symlink). To keep one name per session:

- Set `settings.json#enabledPlugins["kookr-toolkit@kookr"] = false` on Kookr-managed
  machines (the marketplace listing stays for external users; it's just not co-enabled
  locally).
- Drop the `--plugin-dir` **skill** injection for Kookr-spawned Claude Code agents; they
  pick the toolkit up from the same `~/.claude` symlinks every other session uses. (Keep
  `--plugin-dir` only if a plugin-scoped *agent* behavior is found to depend on it — see
  Open Questions.)

Result: bare skill names (`async-flow-control`) resolve identically in every session —
Kookr-spawned or not, Claude Code or Codex.

### F. Codex: retire the per-task overlay

The prior RFC's §G per-task `<cwd>/.claude/skills` overlay becomes unnecessary on maintainer
machines: ambient `~/.claude/skills` + `~/.claude/agents` symlinks make the toolkit visible
to *every* Codex session, Kookr-spawned or not. (Empirically the §G overlay does not appear
to have landed — `codex-cli-adapter.ts` carries no overlay logic — so this is mostly
formalizing the actual state. The fork's native `--plugin-dir` support, probed at #241,
remains the in-Kookr path and is harmless alongside ambient symlinks since it points at the
same content; but per §E we prefer the symlinks as the single source.)

## Separate repository for the plugin? — Recommendation: **No (not now)**

You asked whether the plugin should live in its own repo so the marketplace doesn't clone
all of Kookr. Findings and recommendation:

- **The clone cost is real but now mostly irrelevant.** `/plugin marketplace add` does clone
  the whole repo (confirmed, 280 KB+). But under this RFC, **Kookr-managed machines stop
  using the marketplace path** — they sync `~/.kookr/plugin/` from the local deploy tree.
  The whole-repo clone only affects *external* opt-in users.
- **Splitting fights the model we committed to.** The plugin is shipped *and managed by
  Kookr*: its agents are consumed by Kookr's own `rfc-iterative-review`/`pre-pr-review`
  workflows, its `plugin.json#version` bump is enforced by Kookr's pre-push hook, and its
  skills co-evolve with Kookr features. A separate repo means cross-repo sync, two PRs for
  any coupled change, and submodule/subtree tooling — pure overhead for a single
  maintainer.
- **If external clone size ever matters**, the additive, reversible fix is a CI-published
  **git-subtree mirror** to a thin read-only `kookr-toolkit` repo, with the monorepo
  remaining the source of truth. Defer until a real external consumer complains.

Recommendation: **keep `plugin/` in the monorepo.** Revisit the subtree mirror only on
external demand.

## Files to change (sketch)

**PR-A — install + symlink-all (`~/.kookr/plugin/` + generalized linking)**
- `scripts/install-hooks.sh` — add a sync step (copy deploy `plugin/` → `~/.kookr/plugin/`,
  write `.installed.json`) and iterate **all** `skills/*` + `agents/*` for symlinking;
  generalize `--print-global-assets` to enumerate the full set.
- `src/server/…` (boot path) — invoke the sync on server start.
- `docs/reference/cli.md` / `docs/hooks-setup.md` — document `~/.kookr/plugin/` install +
  the ambient-availability behavior.

**PR-B — drift + collision detection**
- `src/server/toolkit-symlink-status.ts` — add version-drift, collision (`shadowed`), and
  orphan axes.
- `src/server/routes/deploy-routes.ts` — extend `/api/deploy/status` and generalize
  `/api/deploy/toolkit-refresh` (re-sync + relink + prune).
- `src/frontend/components/TopBar.tsx` (+ styles) — surface shadowed/orphan counts and the
  generalized refresh.

**PR-C — single-source-of-truth cutover** (gated on A+B stable)
- `settings.json#enabledPlugins["kookr-toolkit@kookr"] = false` (documented manual/host
  step).
- Adapter: drop `--plugin-dir` **skill** injection for spawned Claude Code agents (retain
  for agents only if Open Q1 finds a dependency).
- `CLAUDE.md` — document the ambient-symlink delivery model and the single-name invariant.

## Edge cases

1. **Collision (user owns a same-named skill).** Never overwritten (clobber guard). Reported
   as `shadowed` (§D.2). The user's skill wins, *with a diagnostic* — Goal 4.
2. **Auto-update needs Kookr to run once after a source change.** Availability is durable
   offline; *refresh* is not. A running instance syncs on boot + on refresh; a never-started
   instance serves the last-synced snapshot. Acceptable and stated.
3. **Forked-Codex agent discovery.** Confirm the fork reads `~/.claude/agents/` (not just
   `~/.claude/skills/`) before relying on agent symlinks. **(Verification required —
   Open Q2.)**
4. **Name divergence during migration.** Until PR-C lands, a Kookr-spawned Claude Code
   session may see both `kookr-toolkit:foo` and `foo`. PR-C removes the duplication; until
   then, prefer natural-language invocation (resolves either).
5. **`~/.kookr/plugin/` vs deploy tree skew.** `.installed.json` records source commit; drift
   detection (§D.1) makes skew visible rather than silent.
6. **Personal-deps user-scope skills** are out of scope and must not be touched by the
   symlink sweep (they have no counterpart in `~/.kookr/plugin/`, so the sweep never
   considers them).

## Alternatives considered

### Alt 1 — Keep the status quo (marketplace opt-in + `--plugin-dir` injection)
Rejected: does not meet Goal 1/2 (no ambient availability; nothing for non-Kookr sessions),
and inherits the whole-repo clone + GitHub-sourced drift.

### Alt 2 — Symlink/forge the Claude Code *plugin* into the registry
Rejected (§C): Claude-Code-only (misses the Codex fork) and requires maintaining an
undocumented private registry format.

### Alt 3 — Resurrect the prior RFC's per-task Codex overlay and add a Claude Code equivalent
Rejected: per-task overlays require Kookr to spawn the session — fails Goal 1/2 by
construction. Ambient symlinks subsume both.

### Alt 4 — Separate plugin repository
Rejected for now (see "Separate repository" section): cross-repo sync overhead fights the
Kookr-manages-it model; CI subtree mirror is the deferred escape hatch.

### Note on prior-RFC Alt 4 ("symlink plugin into user-scope")
The prior RFC rejected this for "silent regression with no diagnostic." This RFC adopts the
mechanism **with** the missing diagnostic (§D.2 collision reporting via the existing TopBar
surface) and under a new requirement (ambient, cross-tool, Kookr-managed) the prior RFC did
not weigh. The rejection's premise (no diagnostic) no longer holds.

## Open questions

1. **Does any plugin *agent* behavior depend on `--plugin-dir` namespacing
   (`kookr-toolkit:<agent>`) rather than bare `~/.claude/agents/<agent>` discovery?** If
   `Agent({subagent_type: "kookr-toolkit:boundary-critic"})` callers exist (the prior RFC
   rewrote 14 such callers to the qualified form), bare-name symlinks would break them — they
   expect the `kookr-toolkit:` prefix. **This is load-bearing** and must be probed before
   PR-C: either (a) keep `--plugin-dir` for agents only, or (b) rewrite qualified
   `subagent_type` callers back to bare names. Mirrors the prior RFC's round-1 empirical
   finding (unqualified `subagent_type` did *not* resolve against the namespaced plugin
   agent) — so option (b) is the likely correct path, and its blast radius must be
   re-measured.
2. **Codex fork agent-dir support** (Edge case 3) — verify before relying on agent symlinks.
3. **Should `~/.kookr/plugin/` sync from `kookr-prod` (deploy tree) or from `main`?** The
   stale-toolkit RFC chose `kookr-prod` as canonical; reuse it for consistency unless
   maintainer wants `main`.

## Acceptance / done

- A fresh `claude` (or forked `codex`) started by hand in an unrelated repo, **with Kookr
  not running**, lists the toolkit skills and resolves a toolkit agent.
- `~/.kookr/plugin/` exists with `.installed.json`; `~/.claude/skills/<skill>` and
  `~/.claude/agents/<agent>` are symlinks into it for every plugin item (minus reported
  collisions).
- TopBar reports version drift, shadowed (collision) items, and orphans; refresh re-syncs +
  relinks + prunes without clobbering non-symlinks.
- No skill loads under two names in any session (PR-C): `kookr-toolkit@kookr` disabled in
  `enabledPlugins`; `--plugin-dir` skill injection removed.
- Open Q1 resolved with a measured `subagent_type` blast radius before PR-C.
- `plugin/` remains in the monorepo; no separate repo created.
