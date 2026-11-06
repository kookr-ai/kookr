# RFC: Plugin & Skill Manager — a Claude-Desktop-style "+" surface in Kookr

**Status:** Draft (v4 — post-review: rounds 1–2 + empirical checkpoint + consensus-attack re-rank)
**Date:** 2026-11-07
**Author:** Jean Ibarz (with Claude)
**Implementation branch:** `rfc/plugin-skill-manager`
**Evidence pack:** `docs/rfc/rfc-plugin-skill-manager-evidence.md` (incl. empirical probe results)

---

## Problem

Claude Desktop has a "+" menu that lets a user browse, install, enable, and
disable plugins and skills on demand. Kookr has nothing equivalent. What Kookr
has today is a **single-plugin nudge**: it detects whether the one
`kookr-toolkit@kookr` marketplace plugin is installed / stale and offers a guided
install or update (`TopBar` badge popover + `PluginInstallBanner`, backed by
`GET /api/deploy/status` and `POST /api/deploy/plugin-{install,update}`).

The operator who requested this feature (the RFC author) already runs **five**
plugins across five marketplaces (`kookr-toolkit`, `stripe`, `rust-analyzer-lsp`,
`ralph-wiggum` (disabled), `claude-notifications-go` — verified in
`~/.claude/plugins/installed_plugins.json`), managed today only through Claude
Code's own `/plugin` UI. That is the ask, in their words: *add a "+" menu so I can
install multiple plugins (not only Kookr's), detect and apply updates
automatically, and enable/disable individual skills of individual plugins — to
customize my experience.* (Evidence of *widespread* need is n=1; the requirement
here is the operator's explicit request, not an extrapolated market.)

Two realities — **both established empirically in the checkpoint**, not assumed —
reshape what that feature can be. Getting them wrong is how this RFC would ship a
surface that looks right and does nothing:

1. **Kookr orchestrates agents; those agents mostly don't read the global config.**
   Kookr's own spawned agents run (in bypass mode) with `--setting-sources ''`
   (`claude-code-adapter.ts:301`), which **drops** global user *and* project
   `enabledPlugins` and `permissions.deny`. Editing `~/.claude/settings.json` from
   Kookr therefore does **not** reach the agents Kookr cares most about. The one
   lever that does is the **per-session `--settings` file the adapter already
   writes on every spawn** (lines 349/351), plus `--plugin-dir` (line 311). So the
   Kookr-specific feature is per-session configuration of spawned agents, not
   global-file mutation.

2. **"Disable a skill" and "save context budget" are different operations.** A
   `permissions.deny: ["Skill(…)"]` rule is an *invocation gate* — it stops a skill
   from running but leaves it loaded and still paying its tokens (measured: a
   namespace deny saves 11 tokens; disabling the whole `kookr-toolkit` plugin saves
   ~55.6k). Budget relief is **plugin-level only**. Finer-grained budget control
   would require splitting the monolith into separately-disableable plugins — a
   different, deferred project (below).

Three concrete gaps remain, now stated against those realities:

- **G1 — No per-Kookr-agent configuration.** There is no way to say "this project's
  agents run without `stripe`" (a real **budget** lever — disabling a plugin for a
  project's spawned agents saves its always-on cost, ~55.6k for kookr-toolkit) or, if
  a concrete need arises, "this playbook's agents may not run skill X." Native Claude
  Code has **no** per-spawned-agent scoping; this is net-new and only Kookr can do it.
  *Demand note (consensus attack):* the **plugin-level** form is demand-supported (a
  budget win + a real "don't load this plugin here" workflow); the **per-skill
  behavior-gating** form has no current demand or harm model (the empirical checkpoint
  removed its budget rationale — see Layer 3), so it is exposed minimally and
  demand-gated, not treated as the near-term core.
- **G2 — No fleet view.** Kookr computes staleness for its own plugin only. There
  is no single place showing "3 of your 5 plugins are behind," no Kookr-owned
  update flow across non-Kookr plugins, and no fleet-aware (idle-gated) auto-update.
- **G3 — Install/enable parity.** The operator asked for a Kookr "+" to install and
  toggle plugins without leaving the dashboard. Native `/plugin` already does this;
  Kookr wrapping it is **convenience/parity**, explicitly labeled as wrapping native
  — not a capability gap. It is in scope because the operator asked, but it is the
  least load-bearing part and must not grow its own config-format ownership.

## Non-Goals

- **Authoring or publishing plugins/skills.** Consumer/manager surface only.
- **A Kookr-hosted plugin registry or marketplace.**
- **Editing third-party plugins' internals** (their SKILL.md, hooks, frontmatter).
- **Skill content quality** — owned by `rfc-plugin-skill-improvements.md` +
  `scripts/validate-skills.ts`.
- **Silent/forced auto-update.** Any auto-apply is per-plugin, consented, and
  idle-gated (R6), with an audit trail and rollback — never a background surprise.
- **Reaching into live running sessions** to hot-reload. No supported programmatic
  `/reload-plugins`; Kookr surfaces the instruction and relies on new-session pickup.
- **Claiming per-skill disable saves tokens.** It does not (empirically); the UI
  must say so.

## Requirements

- **R1 (fleet inventory):** Kookr SHALL present every installed plugin and known
  marketplace — not only `kookr-toolkit` — with id, marketplace, installed version,
  **tri-state** enablement (enabled / disabled / unset→native-default), stale
  status, and the per-plugin always-on token cost where `claude plugin details`
  provides it.
- **R2 (Kookr loadouts):** A user SHALL be able to define a *loadout* that Kookr
  injects into the **per-session `--settings` file of the agents it spawns**, scopable
  per project / per playbook / per task-type, working in bypass mode (where global
  config is dropped) and recorded in the task record for answerability. The
  **plugin-level** form (enable/disable a whole plugin for a scope — a budget lever)
  is the demand-supported near-term deliverable. The **per-skill** form (deny
  `Skill(<plugin>:<skill>)`) uses the same mechanism but SHALL ship only once a
  concrete need is recorded (R3a), not by default.
- **R3 (behavior gating vs budget, stated honestly):** Per-skill control SHALL be
  expressed as `permissions.deny: ["Skill(<plugin>:<skill>)"]` and SHALL be
  presented as a *behavior gate* ("blocked from running; still loaded, still costs
  tokens"). Budget reduction SHALL be offered only at plugin granularity
  (`enabledPlugins:false`), with the measured saving shown.
- **R3a (per-skill demand gate):** Per-skill behavior toggles (Layer 3) SHALL NOT
  ship on the strength of "we can build it." They SHALL ship only once at least one
  concrete case is recorded in which an operator wants a specific spawned agent to
  **not run** a specific skill, with the reason (the *harm model* the gate prevents).
  Absent that, the capability stays latent in the mechanism and is not surfaced.
- **R4 (own-session assist):** For the operator's *own* interactive sessions, a user
  SHALL be able to install / add-marketplace / enable-disable / update a plugin from
  Kookr, wrapping the native CLI, with blast radius ("affects all your Claude Code
  sessions; new sessions pick it up, run `/reload-plugins` in running ones") shown
  before apply.
- **R5 (update detection):** Kookr SHALL detect, for *all* installed plugins,
  whether each is behind its marketplace catalog, acknowledging that available-version
  sourcing is **new code** for non-Kookr plugins (catalog refresh + parse), not a
  generalization of the git-based toolkit path.
- **R6 (auto-update, fleet-aware & safe):** Auto-update SHALL be per-plugin and
  one of `off | notify | apply-when-idle`. `apply-when-idle` SHALL run only when no
  task depends on the plugin, through the shared mutation lock + backup, write an
  audit entry, and offer rollback. Kookr SHALL set the native per-marketplace
  `autoUpdate:false` for plugins it owns the update decision for, to avoid a
  dual-writer race.
- **R7 (one settings-file owner, with a named carve-out):** All reads/writes of
  Claude Code's *scoped* settings files (user/project/local) SHALL go through a
  single pure `ClaudeSettingsStore` (scope precedence, tri-state resolution, atomic
  single-key merge-write, backup) — the plugin manager, the ralph check, and the
  read model all use it. The **one carve-out**: the per-session `--settings` file the
  adapter writes for a spawned agent is a *Kookr-authored* file, not a Claude scope;
  the adapter builds it from a typed `ResolvedLoadout` and owns its shape. Kookr owns
  Claude's settings-file format in exactly one place; it owns its own session file in
  the adapter. No other module parses either format.
- **R8 (safety, reversibility, ordering):** Every config-class mutation SHALL be
  backed up before the write and reversible on failure. A settings mutation SHALL be
  undone by an **inverse single-key edit** (never a whole-file restore, which would
  discard unrelated writes such as an "always allow" the user added in the interval).
  A combined plugins-dir + settings mutation SHALL order as: snapshot settings →
  mutate plugins → mutate settings; undo in reverse (revert the key, then restore the
  plugins dir); on undo failure, surface the backup path (as today's install route
  already does). All mutations SHALL serialize through one module-owned lock injected
  into every mutation path (routes and the Layer-4 runner alike), and the lock's 409
  SHALL name the holder, operation, and start time.

## Background — what Claude Code natively supports (verified)

Verified against docs, the installed `claude plugin` binary, the operator's live
config, and an isolated runtime probe (full detail + transcripts in the evidence
pack). The design builds **only** on these.

| Capability | Native? | Lever / finding |
|---|---|---|
| List installed plugins | yes | `claude plugin list --json`; `installed_plugins.json` v2 |
| Enable/disable a **plugin** | yes | `enabledPlugins` map (`{id@mkt: bool}`); **absent key = native default (tri-state)** |
| Reduce context budget | **plugin-level only** | `enabledPlugins:false` saves ~55.6k for kookr-toolkit; per-skill deny saves ~0 |
| Disable a single skill from **running** | yes (gate, not budget) | `permissions.deny:["Skill(<plugin>:<skill>)"]`; bare name over-matches |
| Per-spawned-agent config | **not native** | Kookr-only, via the per-session `--settings` file + `--plugin-dir` |
| Global config reaches bypass-mode agents | **no** | `--setting-sources ''` drops user+project settings; `--settings`/`--plugin-dir` survive |
| Add/list/remove marketplace; install/update/remove plugin | yes | `claude plugin marketplace …`, `claude plugin install\|update … -y --json` |
| Per-plugin token cost | yes | `claude plugin details <name>` ("Always-on ~N tok") |
| Auto-update | yes, per-marketplace | `autoUpdate` on the marketplace entry — **absent on live entries; read defaults** |
| Check-for-update without applying / update-all | **no** | compose: catalog refresh + registry compare; per-plugin loop |
| Live-session config pickup | **no** | new sessions pick up edits; running ones need `/reload-plugins` |

## Design

Two audiences, served by two levers, with one shared access layer underneath.

```
  src/server/plugin-manager/                     src/core/claude-settings/
  ├ ClaudePluginCli  (port over `claude plugin`) ClaudeSettingsStore (pure; scoped
  ├ PluginMutationService (lock + backup + ops)  read / inverse-key write / backup;
  ├ PluginReadModel ─────────────────────────▶   no lock — caller passes withLock)
  └ LoadoutResolver (pure)                              ▲                 ▲
        │ (launcher resolves → ResolvedLoadout)         │ own-session     │ reads
        ▼                                               │ edits (R4)      │ enabledPlugins
  claude-code-adapter (renders loadout into        /api/plugins/*     ralph-plugin-
  per-session --settings; Kookr agents, R2)        (operator UI)      coexistence
```

### Layer 0 — The shared seams (fixes round-1 + round-2 boundary findings)

Four small, single-purpose pieces — not one god module (round-2 F2):

- **`ClaudePluginCli`** (`src/server/plugin-manager/cli.ts`) — the one port over the
  `claude plugin` binary (`install|update|enable|disable|list --json|details`),
  resolving it via the existing `KOOKR_AGENT_BIN ?? 'claude'`. All CLI-output parsing
  (incl. the `details` token figure) lives behind it, tested with a fake. **The
  registry source of truth is `claude plugin list --json`;** reading
  `installed_plugins.json` / `known_marketplaces.json` directly is only a documented
  fallback, owned here (round-2 F6).
- **`ClaudeSettingsStore`** (`src/core/claude-settings/`) — placed in `core`, not
  `server`, so `core` and `adapters` can import it without an upward dependency
  (round-2 F1). **Pure:** scope precedence, tri-state resolution (absent ≠ false),
  inverse single-key merge-write, and settings-file backup — but it takes **no
  lock**; the caller passes a `withLock(fn)`. It owns `enabledPlugins`,
  `permissions.deny`, *and* the `extraKnownMarketplaces[*].autoUpdate` flag (round-2
  F6). `ralph-plugin-coexistence.ts` and the read model migrate onto it (migration
  caveats in Shipping plan).
- **`PluginMutationService`** (`src/server/plugin-manager/`) — owns the one mutation
  lock (moved out of the `deploy-routes.ts` closure where `pluginMutating` is an
  unshareable `let`), the backup/restore wrapper, and the `ClaudePluginCli` write
  ops. Injected into every mutation path — routes *and* the Layer-4 runner. The
  Layer-4 auto-update policy is a **consumer** of this service, not part of it.
- **`PluginReadModel`** + **`LoadoutResolver`** (pure function) are separate from the
  mutation service: a skill-parsing or loadout bug can't share a module with the
  install-and-rollback path.

### Layer 1 — Fleet inventory + update view (G2) — *ship first*

- **`GET /api/plugins`** → a read model assembled from `installed_plugins.json`
  (installed + versions + scope + `gitCommitSha`), `known_marketplaces.json`
  (marketplaces — **may be absent for a given plugin**; degrade, don't assume),
  and the resolved `enabledPlugins` tri-state. Minimal wire type (trimmed per the
  minimalist):

  ```ts
  interface ManagedPlugin {
    id: string;                          // "stripe@anthropic-plugin-directory"
    installedVersion: string | null;
    availableVersion: string | null;
    enablement: 'enabled' | 'disabled' | 'default';  // tri-state, not boolean
    // Staleness carries its provenance so the UI never shows a bare "current"
    // that actually means "couldn't check" (round-2 operability):
    staleness: { state: 'current' | 'behind' | 'unknown'; reason?: string;
                 source: 'git' | 'catalog'; observedAt: string };
    loadSource: 'marketplace' | 'plugin-dir';  // where AGENTS load it from (see Layer 2)
    alwaysOnTokens: number | null;        // from `claude plugin details`, best-effort
    uninstallGuard: boolean;              // server-set; e.g. kookr-toolkit (round-2 F7)
  }
  ```
  `name`/`marketplace` derive from `id` client-side. `uninstallGuard` (not a generic
  `protected`) names exactly the plugin-level invariant; skill-level exemption is a
  separate `toggleExempt` flag in Layer 3. The view also shows "last catalog refresh:
  Nm ago / failed" with a manual-refresh control, so a stale/failed check is legible
  rather than silent.

- **Available-version sourcing — honest risk (not "pure generalization").** The
  existing toolkit path reads `git show origin/main:plugin/.claude-plugin/plugin.json`,
  which works *only because kookr-toolkit is the kookr repo*. Other plugins have no
  local git tree; their available version needs `claude plugin marketplace update`
  (catalog refresh, which does not mutate installs) + catalog parse — **new code,
  new failure modes**. Expressed as a per-plugin *version-source strategy* (git for
  the toolkit, catalog for the rest), not an identity branch. `compareVersions`
  generalizes; the sourcing does not.

- **Per-plugin update** via `claude plugin update <id> -y --json`. *Update-all* is a
  client loop that reports per-plugin results; it is **not atomic** (no native
  update-all) and is deferred until an operator actually has several stale plugins —
  a half-updated fleet is a footgun, so v1 ships per-plugin buttons only.

- **`GET /api/deploy/status.plugin`** becomes a projection of this read model; the
  old `/api/deploy/plugin-{install,update}` endpoints become **deprecated aliases**
  (removal once `PluginInstallBanner`/`TopBar` move to `/api/plugins/*`), documented
  as such — no two live answers to "is it stale."

### Layer 2 — Kookr loadouts for spawned agents (G1) — *the net-new mechanism*

This is the lever that reaches Kookr's own agents, and it is **already plumbed**:
the adapter writes a per-session `--settings` file on every spawn and
`generateSettings()` already emits `permissions:{allow,deny}`. The change is to feed
it a resolved loadout.

**What ships on this mechanism, in demand order (consensus-attack re-rank):** the
near-term use is **plugin-level** — "this project's / this playbook's agents don't
load plugin P" — which is both a budget win (~55.6k/plugin) and a real workflow (e.g.
agents on a non-payments project don't need `stripe`). Per-skill denies ride the same
resolver but are gated behind R3a (a recorded harm model), so this layer's *default*
deliverable is plugin-granularity enable/disable, not skill curation.

- **A `ResolvedLoadout`** = `{ enabledSet?: string[], enabledOverrides: {id: bool},
  deniedSkills: ["<plugin>:<skill>"] }`, resolved from Kookr-owned desired-state
  attachable at three levels (most specific wins): **task-type → playbook →
  project**. Near-term examples are plugin-level (`enabledOverrides['stripe@…']=false`
  for a project's agents). `deniedSkills` stays empty until an R3a case exists.
- **Semantics differ by spawn mode — stated explicitly (round-2 F3).** Because
  bypass mode passes `--setting-sources ''`, there is no base layer to override, so
  the fields mean different things and the resolver records which applies:
  - *Normal mode:* `enabledOverrides` is a true override of the user scope; absent
    plugins keep their resolved state.
  - *Bypass mode:* `--settings` is the whole truth, so `enabledSet` is an **allowlist**
    — a plugin not listed is simply not enabled. The resolver must emit the full set,
    not a diff.
- **The `--plugin-dir` interaction — an open, must-probe gap (round-2, flagged by all
  three critics).** The adapter force-loads `kookr-toolkit` via `--plugin-dir`
  (`claude-code-adapter.ts:311`), and `--plugin-dir` is **not** governed by
  `enabledPlugins`. So `enabledOverrides['kookr-toolkit@kookr']=false` may **not**
  remove the toolkit for Kookr agents, and the one budget lever may not work for the
  very plugin we ship. This was *not* covered by the P2/P3 probes. **Phase 2 is gated
  on a probe of `--plugin-dir` × `enabledPlugins:false`**; until it passes, the UI
  must show `loadSource` and must not promise a budget saving for a `plugin-dir`-loaded
  plugin. If the probe shows dir-loaded plugins can't be disabled by settings, the
  toolkit's budget lever becomes "point `--plugin-dir` elsewhere / don't pass it,"
  recorded as the real mechanism.
- **Injection & dependency direction (round-2 F5).** The **launcher**
  (`use-cases/*launch*`, which already has project/playbook/task-type context)
  resolves the loadout and passes a plain typed `ResolvedLoadout` through
  `AdapterLaunchOptions`; the **adapter only renders** it into the session settings
  (`enabledPlugins` keys + `permissions.deny` `Skill(<plugin>:<skill>)`, canonical
  form per P1/P5). The field is **gated to the claude adapter** (the adapter is shared
  with codex/grok — no Claude-specific field in generic options). No adapter→server
  dependency.
- **Resume replays, never re-resolves (round-2, correctness).** The `--settings` path
  is shared by fresh launch and `--resume --fork-session`. A resumed agent MUST get
  the loadout **recorded at its original spawn**, not a freshly-resolved one, or
  resuming would silently change its capabilities. The recorded loadout + the written
  session-settings file are retained and linked from the task record.
- **Kill switch / fail-safe (round-2, delivery).** Phase 2 ships behind a default-off
  flag. Flag off, an empty loadout, or any resolution error leaves `permissions` and
  `enabledPlugins` **unset** — byte-identical to today's `generateSettings` (which
  already has that `undefined` branch for #1562). A byte-identity test is required.
- **Answerability (operability).** The task record stores the resolved loadout,
  **which level won**, a hash of the written settings file, and a link to that file.
  On first init, Kookr captures the agent's actual `init.plugins` + skill list and
  **diffs it against the intended loadout**, surfacing a warning on the task when they
  disagree (the record is intent; the diff is truth). A "dry-run resolve" lets the
  operator preview a loadout before spawning.
- **Budget vs behavior, explicit in the data.** `deniedSkills` gates behavior only
  (no token saving); `enabledOverrides:false` is the only budget lever — and only for
  `marketplace`-loaded plugins (see the `--plugin-dir` gap).

### Layer 3 — Per-skill / per-group behavior toggles in the UI (G1 cont.) — *demand-gated (R3a)*

The mechanism works (the spike ran — see Empirical validation), so this layer is
*technically* ready. It is **held behind R3a**: the empirical checkpoint removed its
budget rationale (a deny saves ~0 tokens), leaving only behavior gating, for which no
operator need is yet recorded. Layer 3 ships when a concrete "this agent must not run
skill X, because Y" case exists — not before. The design below is what ships *then*;
until then the plugin rows expand to show skills read-only (no toggle).

When enabled, the manager's expanded plugin row lists its skills with a toggle each;
toggling writes/removes a `Skill(<plugin>:<skill>)` deny into the chosen target (a
Kookr loadout, or — for the operator's own sessions — the global/project scope via
`ClaudeSettingsStore`).

- **Honest copy (R3).** The skills panel header states: *"Disabling a skill stops it
  from running. It stays loaded and still costs context tokens. To cut token cost,
  disable the whole plugin."* The per-plugin `alwaysOnTokens` figure sits on the
  plugin row; no per-skill token number (there is no per-skill saving to show).
- **Group bundles** (for `kookr-toolkit`, which Kookr authors). Add an optional
  `group` field to each `SKILL.md` frontmatter and a `groups` list to `plugin.json`;
  the UI shows ~8–10 toggleable bundles (RFC-review, OSS-PR, reviewer-distillation,
  …) that expand to their skills. A bundle toggle is sugar over a set of
  `Skill(<plugin>:<skill>)` denies — **behavior only, no budget change** — and needs
  no install-id change or state migration. (Budget-scoped groups would require
  separate plugins; see Deferred.)
- **Protected skills (P5 collision).** `pre-pr-review` and `pr-contribution-excellence`
  exist as *both* a plugin skill and a `~/.claude/skills` symlink (hook companions).
  A bare-name deny would hit both and break the hook; the namespaced deny can't target
  the user copy alone. These are marked **`toggleExempt`** and excluded from the toggle
  list, with a tooltip explaining why. The loadout resolver also respects
  `toggleExempt`, so a loadout cannot deny them either.

### Layer 4 — Fleet-aware auto-update (G2 cont.)

Delivers the operator's literal "apply updates automatically," safely.

- Per-plugin policy `off | notify | apply-when-idle`. `notify` surfaces staleness
  in the fleet view. `apply-when-idle` runs `claude plugin update <id> -y` through
  the shared `PluginMutationService` lock + backup.
- **Idle predicate (concrete, race-closed; round-2 operability).** "Idle for plugin
  P" = *no non-terminal task whose recorded loadout includes P*; a task with an
  unknown/unrecorded loadout counts as depending on everything. The updater acquires
  the same lock a spawn must take, and spawn re-checks under the lock, so a task
  can't slip in between the idle check and the update completing.
- **Audit state machine (round-2 operability).** Every evaluation writes a decision
  record — including skips — with a reason (`busy[task-ids]` / `no-update` /
  `policy-off` / `check-failed`) and, when it runs, an outcome
  (`applied` / `failed` / `verify-failed` / `rolled-back`). After applying, a
  verification step confirms the new version loads; on failure it restores, drops the
  plugin to `notify`, and raises a persistent banner.
- **Scoped, retained rollback (round-2 delivery + operability).** Today's install
  route `rm`s its backup on success (`deploy-routes.ts:676-679`) — incompatible with
  "keep it for rollback." Layer 4 instead retains the pre-update snapshot for a stated
  window and scopes a rollback to *what the update changed* (not a whole-dir restore,
  which would discard a native edit made afterward). A rollback after new sessions
  have already started on the new version is called out as a known limitation with a
  restart prompt.
- Kookr writes the native per-marketplace `autoUpdate:false` for any plugin it holds
  in `apply-when-idle`, so Claude Code's own updater and Kookr never both move it —
  and **reverts that flag** when the policy returns to `off` (round-2 delivery). The
  native `autoUpdate` field is **absent by default** on third-party marketplaces
  (verified), so the manager reads the documented defaults (ON official/claude.ai, OFF
  others) rather than assuming the key exists.
- **External-change detection (round-2 operability).** Plugins on auto-updating
  marketplaces can change version with no Kookr action. Kookr snapshots what it last
  observed and logs an `external_change` event (before/after) when a read differs, so
  "installed version changed outside Kookr" is visible rather than a silent fleet-view
  flicker.

### Own-session assist (G3) — wrapping native, deliberately thin

Install / add-marketplace / enable-disable / update for the operator's *own*
sessions reuse `ClaudePluginCli` (which writes the files correctly) behind the same
lock + backup. Enable/disable writes `enabledPlugins` via `ClaudeSettingsStore` at
the chosen scope (default: user). Every such action shows the blast-radius +
`/reload-plugins` disclosure. This is parity with `/plugin`; it owns no new
config-format knowledge of its own (all of it lives in the Layer-0 seams).

**Surfacing reload drift (round-2 operability).** A disclosure shown once at apply
time is forgotten by the next session. Kookr maintains a **config epoch** — a counter
bumped on any Kookr plugin/settings change — and stamps each Kookr-managed session
with the epoch it started under. The dashboard shows "N sessions started before your
last change" with a restart action for Kookr-managed sessions. The operator's own
external TUIs are invisible to Kookr; the UI says so rather than implying coverage.

### The "+" surface

A single **"+" button** in `TopBar.tsx` opens the **Plugin Manager** dialog directly
(same `dialog-overlay`/`useDialogFocus`/`useEscapeToClose` pattern as
`PluginInstallConfirmDialog`). A "Manage plugins & skills" **command-palette** entry
is the second, discoverable path. No intermediate dropdown whose items all open the
same dialog (round-1 boundary + minimalist agreed it was a thin alias). The existing
version badge and install banner keep working (now reading `/api/plugins`).

## Files to change

- **New:** `src/core/claude-settings/` (`ClaudeSettingsStore`, pure, lock-agnostic);
  `src/server/plugin-manager/` (`cli.ts` = `ClaudePluginCli`, `mutation-service.ts`
  = lock + backup + write ops, `read-model.ts`, `loadout.ts` = pure `LoadoutResolver`);
  `src/server/routes/plugin-routes.ts`; `src/shared/contracts/plugins.ts`
  (incl. the `ResolvedLoadout` type); `src/frontend/components/PluginManagerDialog.tsx`;
  `src/frontend/api/plugins.ts`.
- **Changed:** `src/server/use-cases/*launch*` — resolve the loadout and pass a typed
  `ResolvedLoadout` through `AdapterLaunchOptions`. `src/adapters/claude-code-adapter.ts`
  — render the loadout into the session settings (`enabledPlugins` + skill denies),
  gated to this adapter; resume replays the recorded loadout. `src/server/routes/deploy-routes.ts`
  — consume the extracted lock (PR 1a); `plugin-*` become deprecated delegates.
  `src/server/plugin-version-status.ts` / `src/shared/contracts/plugin-version.ts`
  — fold into the read model / settings store (parity-tested cutover).
  `src/core/ralph-plugin-coexistence.ts` — migrate onto the store **only once it can
  express the existing "any scope true" + malformed-tolerant semantics** (see Shipping
  plan). `src/frontend/components/TopBar.tsx` — "+" button + palette command.
  `plugin/.claude-plugin/plugin.json` + `plugin/skills/*/SKILL.md` — `groups` /
  `group` metadata (Layer 3).
- **Tests:** read-model from fixture registry/settings (incl. tri-state + absent
  marketplace); loadout resolution + adapter merge (incl. bypass-mode shape);
  settings-store merge/backup/precedence; route lock/backup mirroring
  `deploy-routes.test.ts`; `PluginManagerDialog.test.ts`.

## Shipping plan

Re-sliced per round-2 delivery review so each slice is independently revertible and no
slice leaves two writers racing one directory.

- **1a — Extract the lock + backup** into `PluginMutationService`; `deploy-routes.ts`
  consumes it. **No behavior change, no new routes.** This closes the dual-lock window
  (the old closure lock and a new module lock must never both mutate `~/.claude/plugins`).
- **1b — `ClaudeSettingsStore`, read-only first.** Cut `plugin-version-status`'s reader
  over behind a **parity test on the live 5-plugin fixture**, then delete the old
  reader. Migrate `ralph-plugin-coexistence` **separately**, with its current semantics
  (any-scope-true, malformed-tolerant) pinned by tests — or leave it on its own reader
  until the store expresses "any scope." (Round-2: this is a semantic change that can
  flip Ralph from "detected/refuses" to "double-firing.")
- **1c — Read model + `GET /api/plugins` + the read-only dialog + Layer-4 `notify`.**
  The "+" opens a working inventory with per-plugin update and staleness; non-toolkit
  catalog staleness is isolated as the new code it is. (G2.)
- **1d — Move the frontend to `/api/plugins/*`, then delete the deploy aliases.** No
  `/api/plugins/*` *mutation* route exists before 1a.
- **2a — Loadout storage + task-record field + a minimal authoring route.** Adapter
  untouched; nothing on the spawn path yet.
- **2b — Adapter injection of *plugin-level* loadouts** (the demand-supported form):
  default-off flag, **byte-identical-when-empty test**, resume replays the recorded
  loadout. **Run the `--plugin-dir` × `enabledPlugins:false` probe before building**
  (Layer 2 gap) — it decides whether the toolkit's own per-project disable works. (G1.)
- **3 — Own-session assist (G3)** + the `group`-metadata/`validate-skills` change
  (independent; see Open question 4). Settings undo defined as an inverse single-key
  edit. **Per-skill toggles (Layer 3) are NOT in this slice** — they ship separately
  only when an R3a demand case is recorded.
- **4 — Layer 4 `apply-when-idle`.** Build only after the idle predicate, audit state
  machine, retention window, scoped rollback, and `autoUpdate:false`-revert are pinned.

Slices are independently shippable and revertible. (Note the inversion from v1: the
per-session mechanism is phase 2, not a deferred tail, because the checkpoint showed it
is the only lever that reaches Kookr's bypass-mode agents.)

## Edge cases

- **Concurrent writers (Kookr lock can't bind `/plugin`).** The module lock serializes
  only Kookr's writes; a terminal `/plugin` or `claude plugin enable` does not take it.
  So `ClaudeSettingsStore` additionally **asserts the file's hash/mtime under the lock
  immediately before writing**, merges only the single key, and on mismatch retries
  once then fails loudly with a 409 naming the cause. At startup, a backup with no
  completed audit entry is flagged as an **interrupted mutation** and offered for
  restore.
- **Tri-state enablement.** `default` renders distinctly from `disabled`; a toggle
  from `default` writes an explicit boolean so intent is recorded.
- **Marketplace absent from `known_marketplaces.json`** (real for `stripe`): the row
  still renders from the install record; marketplace-scoped actions degrade to "open
  in `/plugin`" rather than erroring.
- **`autoUpdate` field absent** (real on all live marketplaces): read defaults; only
  *write* the flag when Kookr takes over the update decision.
- **`toggleExempt` / hook-companion skills.** Excluded from per-skill toggles and from
  loadout denies (P5); disabling the whole `kookr-toolkit` plugin does not remove the
  independent `install-hooks.sh` symlinks, so a hook still finds its companion —
  called out in UI.
- **`uninstall kookr-toolkit`.** `uninstallGuard:true` → extra confirm, never
  one-click; it removes the review subagents Kookr relies on.
- **Update-all partial failure.** Deferred; per-plugin only in v1 (footgun avoided).
- **Live sessions.** Any own-session edit shows the `/reload-plugins` caveat; Kookr
  does not reach into running TUIs.
- **Registry/marketplace file missing or malformed.** Readers return a safe
  empty/partial model; the manager renders "nothing installed / add a marketplace,"
  never 500s.

## Alternatives considered

- **Mirror `/plugin` by mutating global `~/.claude/settings.json` (v1's framing).**
  Rejected as the *primary* mechanism: the checkpoint proved global edits don't reach
  bypass-mode Kookr agents, and they carry the operator's whole-environment blast
  radius. Kept only as the thin own-session assist (G3/R4).
- **Deny-rule groups as the budget lever.** Rejected: measured, a deny saves ~0
  tokens. Group bundles are a *behavior* convenience; budget needs plugin-level
  disable.
- **Physically split `kookr-toolkit` into themed plugins now.** Deferred, but with a
  **sharp, measured trigger** (not "telemetry someday"): `claude plugin details`
  reports ~8,994 always-on tokens for kookr-toolkit, and per-skill deny cannot
  reclaim any of it. If operators need to drop *part* of that cost, the only
  mechanism is separately-disableable plugins — a physical split, or a thin
  `kookr-toolkit` meta-plugin depending on themed sub-plugins (preserves the install
  id, enables a dependency view). That is a self-contained future RFC; its cost
  (id/state migration, cross-plugin `related:` references) is real and unrelated to
  the behavior-control the operator asked for here.
- **Read-only "+" that only deep-links to `/plugin`.** Considered (it is the minimal
  honest surface for G3). Rejected as the *whole* feature because it delivers neither
  G1 (per-agent loadouts — not native at all) nor G2's fleet/idle-update; adopted as
  the fallback for any own-session action Kookr shouldn't own.
- **A Kookr background auto-updater without idle gating.** Rejected — surprise
  mutations. The `apply-when-idle` policy is the consented, fleet-aware form.
- **Build per-session injection last ("cleanest long-term").** Rejected — that phrase
  was the tell. The checkpoint showed it is not a luxury but the only lever for the
  target agents; promoted to Phase 2.

## Open questions

- **Loadout scope precedence UX.** task-type → playbook → project is proposed; is
  per-project the right *default* for own agents, given global's blast radius?
  Decide with usage once Phase 2 lands.
- **`--plugin-dir` × `enabledPlugins:false` (must-probe before Phase 2b).** Does
  disabling a `--plugin-dir`-loaded plugin via settings actually remove it, or does the
  dir force-load win? Decides whether the toolkit's budget lever is `enabledPlugins` or
  "stop passing `--plugin-dir`." Not covered by the round-1 probes.
- **`alwaysOnTokens` trust.** Is `claude plugin details`' figure stable enough to
  drive a "disable this plugin to save ~N tokens" promise, or informational only?
- **Group metadata governance.** Who assigns `group` to each of the 65 skills, and
  does `validate-skills.ts` enforce that every skill has exactly one?
- **Loadout storage shape.** Where Kookr-owned loadouts live (per-project file vs a
  store table) and how they version — to be settled in slice 2a.
- **Does anyone want per-skill behavior gating? (the question the review avoided.)**
  Once the budget rationale died (P2), no one re-asked whether denying a *specific*
  skill to a *specific* spawned agent is wanted for any reason. Until an R3a case is
  recorded, Layer 3 stays latent. If none ever appears, per-skill toggles should be
  dropped, not shipped as parity with Claude Desktop's "+".

## Critic feedback incorporated

### Round 1 (2026-11-07) — five critics in parallel; shared evidence pack.

- `boundary-critic`: novel findings — `pluginMutating` is a closure `let`, unshareable
  across routers (lock must be module-owned + injected); **no single owner** of the
  settings files (ralph reader + adapter writer already exist) so R7's "stay off the
  format" is false → introduce `ClaudeSettingsStore` + `ClaudePluginCli`; Phase-4
  control-plane overlap with the adapter's existing `--settings` deny injection needs
  one policy producer/consumer; `isKookrToolkit` leaks a single plugin's identity into
  a generic type (→ `protected` flag + version-source strategy); overlapping
  `/api/deploy/plugin-*` vs `/api/plugins/*` need a deprecation end-state. **All
  incorporated** (Layer 0; read-model; deprecated aliases; adapter owns argv, manager
  owns the resolved object).
- `design-minimalist`: novel findings — Phase 4 YAGNI *as framed*; 8 endpoints → 2–3;
  trim `ManagedPlugin` (drop `isKookrToolkit`/`enabledScope`, delay `tokenCost`); one
  entry point not three; spike-first; single scope v1; one fallback not a ladder.
  **Incorporated** (contract trimmed; endpoints cut; single "+" button; per-plugin
  update only). **Partially rejected:** "defer install/enable to `/plugin`, Kookr
  read-only" — the operator explicitly asked to install/toggle from Kookr, so G3 stays
  as thin native-wrapping assist (intent-preservation check, below), not cut.
- `ambition-amplifier`: novel findings (verified against `claude-code-adapter.ts`) —
  Phase 4's "requires touching the spawn path" premise is **false**, the `--settings`/
  `--plugin-dir`/deny plumbing already exists → promote per-session injection; the
  bypass-mode `--setting-sources ''` may mean global edits never reach Kookr agents
  (→ became the #1 empirical probe, confirmed); **group bundles** via frontmatter give
  skill-group UX without the split's migration cost; **idle-gated auto-apply** delivers
  the "automatically" ask; a Kookr-owned desired-state manifest improves answerability.
  **Incorporated** (Phase 2 promotion; Layer 3 groups; Layer 4 apply-when-idle; loadouts
  recorded in task records).
- `socratic-challenger`: novel findings — the "5 plugins" need is n=1 (→ reframed as
  the operator's explicit request, not market evidence); global mutation is a surprising
  blast radius for a Kookr button (→ own-session assist made explicitly secondary);
  `permissions.deny` is an invocation gate so per-skill disable may save no budget
  (→ probed, **confirmed**, R3 rewritten); staleness sourcing is new code not
  generalization (→ R5 risk reframed); "what can't they do today?" (→ G1/G2/G3 split,
  with G3 labeled parity). **Incorporated.**
- `failure-mode-analyst`: novel findings (verified on live config) — enablement is
  **tri-state** (`claude-notifications-go` has no entry); a plugin's marketplace can be
  absent from `known_marketplaces.json` (`stripe`); `autoUpdate` is absent on all live
  entries; the `pre-pr-review`/`pr-contribution-excellence` **name collision** breaks
  name-based deny; the reused backup covers `~/.claude/plugins/` only, **not**
  `settings.json` (R8 gap). **All incorporated** (tri-state `enablement`; degrade on
  absent marketplace; read `autoUpdate` defaults; protected-skill exclusion; backup
  spans settings files).

**Adversarial pair resolution (`ambition-amplifier` vs `design-minimalist`).** They
split three ways and the empirical checkpoint arbitrated: on **Phase 4 / per-session
injection** I side with the amplifier — it *verified* the plumbing exists and the
checkpoint proved global edits don't reach bypass-mode agents, so the minimalist's
"YAGNI, no plumbing" premise was factually wrong; promoted to Phase 2. On **endpoint/
contract/entry-point trimming** I side with the minimalist — those were scope with no
user behind them; cut. On the **split**, both are honored by the synthesis: no
physical split now (minimalist), but group bundles give real structure (amplifier),
and the split gets a sharp measured trigger rather than deletion.

**Intent-preservation check.** The operator's load-bearing asks: (a) a "+" menu to
install multiple plugins, (b) auto-apply updates, (c) toggle individual skills. The
restructure honors all three — (a) survives as the "+" button + G3 assist (kept
against the minimalist's "read-only" pivot, flagged as an explicit choice), (b) as
Layer 4 `apply-when-idle`, (c) as Layer 3 behavior toggles — while correcting the
*mechanism* the user didn't specify (per-session for agents; honest budget framing).
No load-bearing motivation was silently dropped.

### Empirical validation checkpoint (post round 1) — `design-experimenter`, `claude` 2.1.319.

`design-experimenter 2026-11-07`: probed five load-bearing claims in isolation (full
transcripts in the evidence pack). Results — **P1** deny name form is
`Skill(<plugin>:<skill>)` (bare over-matches); **P2 (falsifier)** per-skill deny is an
invocation gate and saves ~0 tokens, only `enabledPlugins:false` saves budget (~55.6k
for kookr-toolkit) → the RFC's "per-skill disable saves context" framing was wrong and
is rewritten (R3); **P3 (confirms the inversion)** `--setting-sources ''` drops global
user+project `enabledPlugins`/`deny` but `--settings`/`--plugin-dir` survive → global
edits don't reach bypass-mode Kookr agents, per-session injection promoted to Phase 2;
**P4** new sessions pick up settings edits; **P5** namespaced deny can't target a
same-named user skill alone → protected-skill exclusion. Two load-bearing premises
falsified/clarified; the RFC was restructured around reality rather than iterated
further on the broken premise (v1 → v2).

### Round 2 (2026-11-07) — focused verification panel (3 critics) on the v2 restructure.

Panel: `boundary-critic` (re-verify), `delivery-pragmatist`, `operability-reviewer`.
All three independently flagged the **same top issue** (the `--plugin-dir` ×
`enabledPlugins` interaction), which is incorporated as a Phase-2b probe gate and a
`loadSource` field. None falsified the design; all hardened it.

- `boundary-critic`: confirmed v2 resolved the round-1 findings, with new refinements —
  `ClaudeSettingsStore` must live in `core` (not `server`) and be pure/lock-agnostic
  (F1); split the `PluginManager` god module into mutation-service / read-model /
  resolver (F2); the loadout field is ambiguous across spawn modes and `--plugin-dir`
  is ungoverned (F3); name the registry source (CLI `list --json`) and add an R7
  carve-out for the adapter-owned session file (F6); loadout flows launcher→
  `ResolvedLoadout`→adapter, gated to the claude adapter (F5); split `protected` into
  `uninstallGuard` / `toggleExempt` (F7); specify the alias removal milestone. **All
  incorporated.**
- `delivery-pragmatist` (Shippable With Revisions): re-slice Phase 1 into 1a (lock
  extraction, no behavior change) → 1b (store read-only + parity cutover; ralph
  migrated separately with pinned semantics) → 1c (read model + read-only dialog) → 1d
  (frontend cutover + delete aliases), to avoid a dual-lock window and bundled revert;
  Phase 2 needs storage/schema/authoring (2a) before adapter injection (2b);
  **resume must replay the recorded loadout, not re-resolve**; kill switch = empty
  loadout → byte-identical to today (tested); settings rollback = inverse single-key
  edit with combined-op ordering; Phase 4 must retain the backup its success path today
  `rm`s, and revert `autoUpdate:false`. **All incorporated** (R8, Shipping plan, Layer
  2, Layer 4).
- `operability-reviewer` (debuggable only if you already know the answer): concrete
  idle predicate with the spawn-lock race closed; an auto-update **audit state
  machine** (decision records incl. skips, outcomes, post-apply verify); **scoped**
  rollback not whole-dir; loadout **provenance** (which level won, settings hash, keep+
  link the session file, diff `init.plugins` vs intent, dry-run preview); a **config
  epoch** to surface `/reload-plugins` drift; fleet staleness as
  `current|behind|unknown(reason)` with per-field source + `observedAt` + an
  `external_change` event; concurrent-write hash/mtime assertion + 409 naming the
  holder + interrupted-mutation startup check. **All incorporated** (Layers 1/2/4,
  Edge cases, R8).

No new adversarial pair ran this round (ambition-amplifier/design-minimalist resolved
in round 1); the round-2 panel was verification-focused and the restructure added no
new deferred items beyond the already-sharpened split trigger.

**Intent-preservation check (round 2):** re-read the operator's ask against the v3
design. (a) "+" menu to install multiple plugins — preserved (the "+" button + G3
assist); (b) auto-apply updates — preserved (Layer 4 `apply-when-idle`); (c) toggle
individual skills — preserved (Layer 3), now with the honest caveat that it gates
behavior, not budget. No load-bearing motivation dropped; the only pivots (per-session
mechanism for agents; honest budget framing) are mechanism corrections forced by the
empirical checkpoint, surfaced as explicit choices.

### Consensus attack (2026-11-07) — one `general-purpose` agent against the panel's agreement.

`general-purpose 2026-11-07`: consensus-attack — **shared blind spot found** (and
incorporated). The whole panel debated *how* to build per-agent per-skill loadouts;
none demand-tested *whether* behavior-gating individual skills is wanted once the
empirical checkpoint (P2) removed its budget rationale. The tell: the checkpoint's two
findings are both *feasibility* facts ("per-session is the only lever that reaches
Kookr agents"), and the RFC promoted that HOW into a WHY — overruling the
design-minimalist's demand objection with a buildability fact (a category error). With
empty loadouts (the R8 kill-switch default), the labeled "core" renders byte-identical
to today — zero behavioral delta for the riskiest slice — while the genuinely demanded
piece is small: **plugin-level** per-project disable (a real ~55.6k budget lever).
**Incorporated as a re-rank, not a deletion:** the per-session mechanism stays (plugin-
level loadouts need it and *are* demanded); per-skill behavior gating is demoted behind
a demand gate (new R3a), G1/R2/Layer 2 are re-ranked to lead with plugin-granularity,
Layer 3 is explicitly held until a recorded harm model exists, and the avoided question
is added to Open questions. This was triaged as the single permitted post-consensus
revision; it did not reopen the review.
