# RFC: Plugins for the Kookr fleet — fleet set, catalog versions, gated offers

**Status:** Draft (v4 — one critic round, empirical checkpoint, consensus attack, independent merge review)
**Date:** 2026-11-14
**Author:** Jean Ibarz (with Claude)
**Implementation branch:** `rfc/external-plugin-fleet`
**Evidence pack:** `docs/rfc/rfc-external-plugin-fleet-evidence.md`
**Builds on:** `docs/rfc/rfc-plugin-skill-manager.md` (shipped, PRs #3500–#3503)

---

## Problem

Kookr can install and update Claude Code plugins from its dashboard, but the
agents Kookr spawns cannot use them. A plugin the operator installs is visible in
the operator's own terminal sessions and invisible to every Kookr task.

The reason is how agents are launched. Production runs in bypass mode, which
starts each agent with `--setting-sources ''`. That drops the user's settings,
including the list of enabled plugins. The only plugin a spawned agent loads is
the one bundled with Kookr, passed as a single `--plugin-dir`. So today every
skill a Kookr agent should have must live inside the Kookr repository and ship
with the server.

The Plugin Manager RFC built the mechanism that fixes this (a "loadout": a
per-task list of plugins written into the agent's session settings file) and
proved it works. It left four gaps that keep the mechanism from being usable:

- **G1 — No fleet-wide default.** A loadout attaches to a project, a playbook or
  an agent type. There is no level that means "every agent". Making one plugin
  available everywhere means one entry per project, and a new project starts
  without it. The feature is also behind a flag that is off by default, and has
  no screen.
- **G2 — New versions are detected for one plugin only.** The bundled toolkit's
  latest version is read from Kookr's own git history. Every other plugin is
  reported as "unknown", so it is never shown as behind.
- **G3 — The manager cannot browse or remove.** It lists installed plugins and
  installs one if you already know its id. It cannot show what a registered
  marketplace offers, and it cannot uninstall.
- **G4 — Kookr cannot suggest a plugin conditionally.** Some marketplaces are
  private. Kookr has no way to offer plugins from one only to users who can
  actually read it.

Closing these gaps is what allows skills and subagents to be distributed and
versioned outside the bundled toolkit. The earlier RFC named that as future work
("Physically split `kookr-toolkit` into themed plugins", deferred) and observed
that plugin-level enablement is the only real context-budget lever. This RFC
covers the Kookr capability only. Which content moves where is tracked separately
and is not decided here.

## Non-Goals

- **Deciding what leaves the bundled toolkit.** This RFC makes external plugins
  usable; it moves nothing.
- **Changing how the bundled toolkit is delivered.** It stays a `--plugin-dir`
  load, version-locked to the server, because its hooks and playbooks must match
  the server build.
- **Native plugin dependencies from the bundled toolkit.** Measured: a
  directory-loaded plugin whose declared dependency is not enabled in the session
  does not load at all (evidence D1, D2). One missing install would remove the
  toolkit from every agent. The toolkit must never declare `dependencies`.
- **Per-skill toggles.** Still gated by R3a of the earlier RFC.
- **A Kookr-hosted registry, or authoring and publishing plugins.**
- **Delivery to non-Claude agents, playbook plugin requirements, and a local
  source override.** Deferred with explicit triggers; see "Deferred".

## Requirements

- **R1 (fleet set):** An operator SHALL be able to name the installed plugins that
  every Kookr-spawned Claude agent loads, in one place, without per-project
  entries. Project, playbook and task-type loadouts SHALL still override it per
  plugin.
- **R2 (untouched when unused):** With no fleet set and no loadouts, a spawn SHALL
  take exactly today's path: no extra file read beyond the store check, no
  additional lock, and a byte-identical session settings file. The feature SHALL
  have a kill switch that also stops recorded loadouts from being replayed.
- **R3 (only what is installed, never silent):** Kookr SHALL enable a plugin for
  an agent only if it is installed at resolve time. A named plugin that is not
  installed SHALL be recorded on the task with a reason, logged at warn level,
  and counted in `kookr doctor`. This holds even when every named plugin is
  skipped.
- **R4 (recorded and replayed):** The task SHALL record, for each plugin it was
  given, the id, the installed version and the install path **at spawn**. A
  resumed agent SHALL get the recorded ids, not a fresh resolution. The version
  is a record, not a pin: a resume loads whatever version is installed then, and
  the task SHALL show when that differs from the recorded one.
- **R5 (runtime truth):** An operator SHALL be able to check what a Claude agent
  launched with the current fleet set actually loads, including plugin load
  errors, without reading logs.
- **R6 (version detection for every plugin):** For every installed plugin whose
  marketplace is registered, Kookr SHALL report `current`, `behind` or `unknown`
  with a reason from a fixed list, and the time of the last catalog refresh.
- **R7 (browse, install, uninstall):** The manager SHALL list registered
  marketplaces and the plugins each offers, install one, and uninstall one.
  Updating or uninstalling a plugin that running tasks were given SHALL name
  those tasks and ask for confirmation.
- **R8 (gated offer):** Kookr SHALL be able to offer a named set of plugins from
  a marketplace **only** to a user for whom a silent, non-interactive access
  check succeeds. A user without access SHALL see no offer, no warning and no
  doctor finding. An operator SHALL be able to ask explicitly why an offer is or
  is not showing.
- **R9 (honest coverage):** The manager SHALL state that the fleet set reaches
  Claude agents only, and that a change reaches new spawns only.
- **R10 (changes made elsewhere):** The plugin store is shared with the
  operator's own sessions and with Claude Code's own updater. Kookr SHALL detect
  a fleet plugin whose installed version changed without a Kookr action, and
  SHALL treat it like its own update: re-run the fleet check and show which
  running tasks started on the older version.

## Design

Two facts from the evidence pack fix the delivery route:

1. In bypass mode, a per-session settings file that sets
   `enabledPlugins["<plugin>@<marketplace>"] = true` makes Claude Code load that
   installed plugin under its real id (probe B).
2. A second `--plugin-dir` pointing at the plugin's install path also loads it,
   but under the synthetic id `<name>@inline` (probe C).

The fleet set uses route 1. Ids stay stable, the version the manager shows is the
version agents load, and the auto-update idle check already reads the loadout
recorded on each task.

### 1. Fleet set — a base loadout level

The resolver gains a fourth, least specific level named `fleet`. Resolution stays
per plugin, most specific level winning:

```
task-type  →  playbook  →  project  →  fleet
```

**Storage.** The fleet set lives in its own file in the Kookr data directory,
`plugin-fleet.json` (`{ version: 1, plugins: { "<id>": true|false } }`), owned by
the same `LoadoutStore` class. It is deliberately **not** a new key inside
`plugin-loadouts.json`. The current reader of that file ignores its `version`
field and copies only the three levels it knows, and every write rewrites the
whole file. So a server rolled back to today's build would silently erase a
fleet level on its next loadout edit. A separate file is invisible to an older
server and survives a rollback untouched. No migration, no version bump.

**Who filters.** Resolution stays pure. The "installed only" rule (R3) is one
pure step in the launcher, after resolution and before recording:

```
partitionByInstalled(resolved, installed) → { resolved, plugins, skipped }
```

- `installed` comes from a narrow `InstalledPlugins` port backed by a direct read
  of `~/.claude/plugins/installed_plugins.json`, using the tolerant reader
  `registry.ts` already has (`readInstalledPlugins`). The spawn path never shells
  out to `claude plugin list`: measured, the file read takes under a millisecond
  and the CLI call about three seconds.
- `plugins` is `[{ id, version, installPath }]` for what was kept (R4). The
  registry holds a list of install records per plugin, one per scope. The step
  takes the user-scope record, and the highest version when there are several,
  which is the rule `highestInstalledVersion` already applies.
- `skipped` is `[{ id, reason }]`. The only reason today is `not_installed`. The
  existing reader returns an empty registry for a missing or malformed file, so
  an unreadable registry is indistinguishable from "nothing installed": every
  named plugin is then skipped as `not_installed`. That fails closed, which is
  the safe direction: the agent gets the bundled toolkit and the task says why
  it got nothing else.
- The step recomputes the bypass allowlist and the winning level, so provenance
  never names a level whose only entries were skipped.
- An entry whose plugin name matches a plugin the adapter loads with
  `--plugin-dir` (the bundled toolkit) is passed through untouched. The renderer
  already rewrites such an entry to `<name>@inline`, which is how a project
  disables the toolkit today. The toolkit is always loaded and is not a fleet-set
  member: its row has no Kookr agents switch.
- A record is written whenever any level named any plugin, **including when the
  filter removed all of them**. Today an empty result records nothing; that
  would hide exactly the worst case.

Replay (resume, crash recovery, relaunch; the call sites are in
`launch-service.ts` and `crash-recovery.ts`) does not filter: it reuses the
recorded ids, as today. It does run the same partition against the current
registry for reporting, and stores the result as `replaySkipped`, so a resumed
task whose plugin has since been uninstalled shows that fact from the same
source as a fresh spawn.

**One place decides whether loadouts apply.** Today both the launcher and the
adapter read `KOOKR_PLUGIN_LOADOUTS`, and the adapter's own check is what makes
the flag a real kill switch: with the flag off, a resumed task renders no
`enabledPlugins` even though it carries a recorded loadout (documented as
deliberate in `docs/reference/environment-variables.md`). That behaviour is
kept, but the decision moves to one predicate in the launcher layer, used by
both the first-spawn path and the replay path. The adapter stops reading the
flag and renders whatever it is handed. The rule becomes:

| `KOOKR_PLUGIN_LOADOUTS` | Slice 1 | From slice 3 |
|---|---|---|
| `0` / `false` | off (kill switch) | off (kill switch) |
| `1` / `true` | on | on |
| unset | **off** (as today) | on **only if** the fleet file or loadout file names a plugin |

"Off" means no session, new or resumed, is handed a loadout. So slice 1 changes
nothing for anyone who has not opted in, and the operator soaks it on the
production instance by setting the flag. The default changes only when the
screen that lets a user configure a fleet set ships. Even then, an install with
nothing configured never resolves and writes the same bytes as today (R2).

The spawn gate keeps both of its existing arms. Today it takes the plugin
mutation lock when loadouts are on **or** when auto-update apply is on
(`spawnGateActive`), because the updater's idle check relies on a spawn not
slipping in underneath it. The loadout arm becomes "a loadout will actually be
recorded"; the auto-update arm is unchanged. With neither, there is no lock.

**Normal (non-bypass) mode.** User settings are loaded, so user-enabled plugins
already reach the agent. The fleet set adds its `true` keys on top; a project
override of `false` still disables. No new semantics.

**What a change reaches.** A fleet-set edit reaches new spawns only. Each write
bumps the existing config epoch, so the existing drift surface ("N sessions
started before your last change", with a restart action) covers it without new
machinery. Each write is also logged with the before and after sets.

The fleet set is a Kookr decision about Kookr's agents. The fleet file is the
only thing a fleet-set edit writes, with one disclosed exception described under
"Reduce" below. It never changes which plugins the operator's own sessions
enable.

**The store itself is shared (R10).** Installed plugins live in one user-scope
store, `~/.claude/plugins`, with one installed version per plugin. The
operator's terminal, `/plugin`, and Claude Code's own marketplace auto-update
all write to it, and none of them takes Kookr's lock, bumps the config epoch or
runs a busy check. Kookr's safeguards cover Kookr's writes only. Three measures
keep that honest without inventing a second store:

- **Detect.** The auto-update module already keeps the versions it last observed
  for every installed plugin and logs an `external_change` event when one moves
  without a Kookr action (`detectExternalChanges`). Today that comparison runs
  only inside the auto-update sweep, and the sweep starts only when
  `KOOKR_PLUGIN_AUTO_UPDATE` is set, which is off by default. So as shipped,
  nothing is detected on a default install. This RFC splits the sweep in two.
  The **observe** half (external-change detection, and from slice 2 the catalog
  refresh) runs on the same interval whenever loadouts are active, and also when
  the manager opens. The **apply** half (idle-gated updates) stays behind
  `KOOKR_PLUGIN_AUTO_UPDATE`. A detected change to a fleet plugin bumps the
  config epoch, re-runs the fleet check, and lists the running tasks whose
  record holds the older version.
- **Reduce.** For a marketplace that has a plugin in the fleet set, Kookr turns
  off Claude Code's own auto-update, so versions move only through Kookr. This
  reuses the mechanism the auto-update module has for `apply-when-idle` plugins,
  and it is a write to the operator's user settings
  (`extraKnownMarketplaces.<marketplace>.autoUpdate` in
  `~/.claude/settings.json`). That mechanism records the value it found, writes
  `false`, keeps it `false` while Kookr owns the decision, and restores exactly
  the recorded value when the last fleet plugin from that marketplace is
  removed. It therefore **does** override an operator's own `true` for as long
  as the marketplace has a fleet plugin, and it changes auto-update for the
  operator's own sessions too. Because of that it is not silent: switching on
  the first fleet plugin of a marketplace shows the existing blast-radius
  disclosure with this effect spelled out, and the manager shows "updates
  controlled by Kookr" on the marketplace.
- **Say so.** The record is "version at spawn". There is no pin and no
  downgrade. Undoing a bad plugin release means releasing a fixed version in the
  marketplace and updating again.

### 2. Runtime truth — the fleet check (R5)

The earlier RFC promised a diff between the plugins an agent actually loaded and
the intended loadout. It was never built, and the record holds intent only. That
matters more here, because Claude Code fails quietly: an enabled id that is not
installed is ignored (E1–E3), and a plugin with an unmet dependency drops out
with only a `plugin_errors` entry (D1, D2).

`POST /api/plugins/fleet/check` runs the same probe used to design this RFC: a
one-shot print-mode session started with the adapter's exact flags and the
settings a spawn would get, reading the `init` message. It returns, per plugin
in the resolved set, `loaded` (with version), `missing` or `errored` (with the
`plugin_errors` text), plus any `unexpected` plugin.

- It runs on demand from the manager ("Check what agents load"), and
  automatically after a fleet-set change, after a plugin update, and after a
  version change made outside Kookr (R10).
- Measured cost: the `init` message arrives about five seconds after launch, and
  the process can be stopped right after it, before any model reply.
- The last result and its time are shown beside the fleet set and reported by
  `kookr doctor`.
- It is the acceptance evidence for every slice and for any later change that
  relies on a plugin being present.

The fleet check is a pre-flight: it shows what a new agent would load, not what
a particular agent did load. For that, there is one usable signal. Interactive
sessions do not expose their plugin list (hook payloads carry none, and the
transcript has no `init` record), but each transcript contains one
`skill_listing` record with the namespaced skill names, and Kookr already gets
the transcript path from the SessionStart hook. After a task's first turn Kookr
reads that record and marks a recorded plugin `no skills seen` when no skill
with its prefix appears. The limits are stated in the UI: it sees skills only,
so a plugin that ships only subagents or hooks cannot be confirmed this way, and
it does not carry load errors.

### 3. Catalog and version source (R6)

One module, `src/server/plugin-manager/catalog.ts`, owns what Kookr knows about
marketplace contents. It is two pure parsers and one command:

- **Marketplaces:** `claude plugin marketplace list --json` (name, source,
  `installLocation`), through the existing CLI port. `installLocation` is a
  local clone for a git source and the original directory for a local-path
  source.
- **Latest version of an installed plugin.** Measured on a local-path
  marketplace: after a refresh, `claude plugin list --json` reports the catalog
  version as `folderVersion` beside the installed `version`. When that field is
  present it is the answer and Kookr parses no file. It was not present for the
  git-sourced marketplaces on the operator's machine (where installed and catalog
  versions happened to be equal), so there is a fallback: read
  `<installLocation>/<relative source>/.claude-plugin/plugin.json`, then the
  marketplace entry's `version`, else null. This matches Claude Code's own order,
  which was also measured: with `plugin.json` at 1.1.0 and the entry at 9.9.9,
  install and update both chose 1.1.0. Slice 2 pins which path a git-sourced
  marketplace takes, as part of its acceptance evidence.
- **Plugins not installed yet:** the `available` array of
  `claude plugin list --json --available`, filtered per marketplace. (It leaves
  out most installed plugins, which is why it cannot serve the previous point.)
- **Refresh:** `claude plugin marketplace update <name> --json`. It changes the
  local clone only and never an install, so it does **not** take the plugin
  mutation lock that spawns wait on. It has its own one-at-a-time guard per
  marketplace. Triggered by a manual button and by the observe half of the
  sweep (section 1, "Detect"), which does not need `KOOKR_PLUGIN_AUTO_UPDATE`.
  Refresh state (`lastRefreshedAt`, last error, duration) is kept in memory and
  logged per attempt.

Staleness for a non-toolkit plugin is one rule:

- both versions are semver → `behind` if installed < catalog, else `current`;
- otherwise → `unknown`, with a reason from this list: `marketplace_not_registered`,
  `never_refreshed`, `refresh_failed`, `catalog_unreadable`, `entry_missing`,
  `no_version`, `not_semver`.

A version that merely differs (a commit SHA, `v1.2`) is `unknown`, not `behind`:
a difference says nothing about direction, and a false `behind` would make
`apply-when-idle` update on every tick. The Update button stays available on an
`unknown` row. As a second guard, an auto-update that leaves the installed
version unchanged drops that plugin to `notify`.

The bundled toolkit keeps its git source. A marketplace that Kookr is expected
to track must give each plugin an explicit semver and bump it on every change;
otherwise there is nothing to compare.

**Auto-update and the idle check.** The idle check counts a task with no
recorded loadout as using every plugin. Non-Claude tasks never record one, so a
single running Codex task currently blocks every update. Since non-Claude agents
cannot load marketplace plugins at all, the check will treat them as using none.
Even so, a fleet plugin is in use whenever any Claude task runs, so on a busy
instance `apply-when-idle` will fire rarely. The expected path is `notify` plus
a manual update; this RFC does not try to make idle more frequent.

### 4. Browse, install, uninstall (R7)

- `GET /api/plugins` gains `marketplaces: [{ name, source, lastRefreshedAt,
  lastRefreshError, available: [{ id, description, version }] }]` and, per
  installed row, `fleet: true|false|null`.
- `POST /api/plugins/marketplaces/:name/refresh`.
- `POST /api/plugins/:id/uninstall` runs `claude plugin uninstall <id>` through
  `PluginMutationService`, with the existing backup wrapper and the existing
  guard on the bundled toolkit. It does **not** edit the fleet or loadout files.
  A plugin that is still named there shows as "named but not installed" (the
  resolve-time filter already handles it) with a one-click remove.
- Update and uninstall both check for running tasks whose record lists the
  plugin. If there are any, the response names them and the action needs
  `force`. Today a manual update runs underneath live agents without saying so.
- Install reuses the existing own-session install route.

### 5. Manager screen

The Plugin Manager dialog gains:

- a **Kookr agents** switch on each installed row (writes the fleet file), with
  the per-project override in the row's expansion, and the line "Applies to
  Claude agents, from their next spawn";
- the fleet check result and a "Check what agents load" button;
- an **Available** section per marketplace with Install buttons and the refresh
  time;
- **Uninstall** on each row;
- the version pair on a `behind` row ("1.2.0 → 1.3.0"), and the reason on an
  `unknown` row.

### 6. Gated offers (R8)

Kookr ships a small manifest, `config/plugin-offers.json`:

```json
{ "offers": [ { "marketplace": "owner/repo", "plugins": ["a", "b"] } ] }
```

It ships empty. For each offer the server runs an access probe:

- `git ls-remote <url> HEAD`, where `<url>` is derived from the offer's source
  exactly as `claude plugin marketplace add` would clone it, so a passing probe
  means the add will work. Environment: `GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=never`, 10-second timeout.
- Exit 0 means readable. Anything else means "no access" and is treated the same
  as "does not exist" (measured: exit 128 in both cases, no prompt, under one
  second).
- A success is cached for 24 hours. A failure is cached for 5 minutes, so a
  network blip does not hide the offer for a day.
- The probe checks the credentials of the **server process**, not the browser
  user. On a single-operator instance these are the same person.

An offer exists for the UI only when the probe succeeded. The manager then shows
a **Recommended** section with one confirmation that adds the marketplace,
installs the listed plugins and adds them to the fleet set (a checkbox, on by
default). That sequence is one use case composing the existing mutation service
and the loadout store; `offers.ts` owns only the manifest and the probe.

For a user without access nothing renders and nothing is logged above debug.
To keep that silence diagnosable, `kookr doctor --offers` (and
`GET /api/plugins/offers/diagnostics`) prints, per offer, the last probe time,
exit code, duration and whether the answer was cached. It is shown only when
asked for.

The manifest names a repository in public source. A private repository's name
discloses only that it exists.

## Deferred, with triggers

Each item was cut from this RFC because nothing needs it yet. Each has a
concrete event that reopens it.

- **Delivery to Codex and Grok agents.** Trigger: before the first change that
  removes from the bundled toolkit a skill those agents use. Until then they
  keep the bundled toolkit, and R9's line says so. The Codex fork's support for
  more than one plugin directory is recorded under Open questions.
- **Playbook plugin requirements** (a `requires-plugins` frontmatter key, a
  launch warning, a listing rule). Trigger: the first bundled playbook whose
  instructions name a skill that is no longer bundled. The design must keep a
  playbook visible when a schedule references it, and must put the listing
  filter in a server use case, not in `src/core/playbook-discovery.ts`.
- **Local source override** (load one plugin from a checkout while editing it).
  Trigger: the first time a Kookr task needs to try an unreleased change to an
  external plugin. It needs a distinct `devSources` field and a plugin directory
  list in the adapter, and must show a visible "dev source" badge.

## Files to change

- **Contracts:** `src/shared/contracts/plugins.ts` (`fleet` level; `plugins`,
  `skipped`, `replaySkipped` on `TaskLoadoutRecord`; marketplaces and `fleet` in
  the read model; staleness reason list; fleet check and offer types).
- **Core:** `src/core/claude-settings/loadout.ts` (level order; activation rule
  moves to the launcher), `src/core/plugin-auto-update/idle-predicate.ts`
  (non-Claude tasks use no marketplace plugin).
- **Server:** `src/server/plugin-manager/loadout-store.ts` (fleet file,
  `partitionByInstalled`, always-record), `registry.ts` (`InstalledPlugins`
  port), new `catalog.ts`, new `fleet-check.ts`, new `offers.ts`,
  `version-source.ts` (staleness rule), `read-model.ts`, `cli.ts` (`uninstall`,
  `marketplaceList`, `marketplaceUpdate`, `folderVersion` and `available` in the
  list parser), `mutation-service.ts` (uninstall, busy check),
  `auto-update-service.ts` and `auto-update-store.ts` (react to an external
  change of a fleet plugin; `autoUpdate` ownership for fleet marketplaces as
  well as `apply-when-idle` ones), `auto-update-wiring.ts` and
  `src/server/index.ts` (observe half of the sweep runs when loadouts are
  active), `launch-service.ts`, `agent-lifecycle.ts` and `crash-recovery.ts`
  (shared activation predicate; `replaySkipped` at the replay sites),
  `src/server/routes/plugin-routes.ts`.
- **Adapter:** `claude-code-adapter.ts` (stop reading the flag; no other change).
- **Frontend:** `PluginManagerDialog.tsx`.
- **CLI and docs:** `src/cli/kookr-doctor.ts` (loadouts on/off and why, fleet
  size, named-but-not-installed count, last fleet check, catalog refresh age),
  `docs/reference/api.md`, `docs/reference/environment-variables.md`.
- **Tests:** resolver with four levels; fleet file absent, empty, malformed;
  `partitionByInstalled` (all kept, some skipped, all skipped still records,
  registry unreadable); activation table for both slice rules; byte identity and
  no lock with nothing configured; replay with an uninstalled plugin; catalog
  parsing from fixtures; staleness rule and reason list; busy check on update
  and uninstall; idle check with non-Claude tasks; external version change
  bumps the epoch and lists affected tasks, with `KOOKR_PLUGIN_AUTO_UPDATE`
  unset; `autoUpdate` previous value recorded, `false` written, and the recorded
  value restored on release (absent, `true` and `false` cases); kill switch off
  renders nothing on resume; `skill_listing` check from a
  transcript fixture; offer hidden on every non-zero probe result, failure TTL,
  diagnostics output.

## Shipping plan

Three pull requests, in order. Slice 2 needs slice 1's records for its busy
check; slice 3 needs both.

1. **Fleet set, delivery, truth.** Fleet file and level, `partitionByInstalled`,
   the richer task record, the activation rule (still opt-in), the fleet check
   endpoint, the per-task `skill_listing` check, detection of version changes
   made outside Kookr with the `autoUpdate: false` write (R10), doctor lines,
   idle-check fix. No screen: the fleet file is written through one route.
   *Acceptance evidence, recorded in the PR:* on the production instance with the
   flag set, a fleet set naming one installed marketplace plugin; the fleet check
   output showing it `loaded`; one real spawned task whose record lists the
   plugin with version and settings hash; a second run naming a plugin that is
   not installed, showing the `skipped` record and the doctor count.
2. **Catalog, versions, uninstall.** `catalog.ts`, the staleness rule,
   marketplaces in the read model, refresh, uninstall, busy check.
   *Acceptance evidence:* a refresh against one real git-sourced marketplace
   with its timestamp, stating whether `folderVersion` or the fallback supplied
   the catalog version; one plugin shown `behind` then `current` after an
   update; one `unknown` row with its reason.
3. **Manager screen and offers.** The dialog changes, `plugin-offers.json`
   (empty), the probe, the Recommended section, offer diagnostics, and the
   activation rule's change of default.
   *Acceptance evidence:* install, switch on, check, switch off and uninstall
   performed from the dashboard; an offer for a readable repository shown; the
   same offer absent, with nothing logged above debug, when the probe runs with
   credentials withheld; diagnostics output for both.

**Rollback.** Setting `KOOKR_PLUGIN_LOADOUTS=0` and restarting the server is the
kill switch. From then on no session is handed a loadout: new spawns resolve
nothing, and a resumed or relaunched task renders no `enabledPlugins` even if it
recorded one, which is the shipped behaviour. Sessions that are already running
keep the plugins they loaded until they are restarted. A full rollback is
therefore: set the flag to `0`, restart, and restart the tasks that should not
keep the plugins. Emptying the fleet set is optional and only matters for when
the flag is turned back on. Reverting the server build is safe at every slice
because the fleet file is separate and an older build treats an unset flag as
off.

## Edge cases

- **Fleet plugin uninstalled outside Kookr.** Next resolve skips it and reports
  it (R3). The manager row shows "named but not installed".
- **Resume after an uninstall.** The recorded ids are replayed and one names a
  plugin that is gone. Claude Code ignores it (E2, print mode), so the agent
  resumes without that plugin, and the task shows `replaySkipped`.
- **Resume after an update.** The record keeps the version the task first
  loaded, so the difference is visible. The resumed agent loads the version
  installed now (R4).
- **Update or uninstall while agents run.** Measured: an update keeps the old
  version directory and marks it with an `.orphaned_at` file; an uninstall also
  leaves the files on disk. A session that loaded the old version can still read
  its skills and hooks. Claude Code removes orphaned directories later (on the
  operator's machine nothing older than about eleven days survives), on a
  schedule that was not measured. The busy check stays, as a confirmation rather
  than a hard block.
- **Version changed outside Kookr.** Detected on the next observe pass or manager open
  (R10); the affected running tasks are listed. They keep working for the reason
  above.
- **Catalog refresh fails** (offline, or a private marketplace without
  credentials in the server's environment). Staleness is `unknown` with
  `refresh_failed` and the last successful refresh time. One attempt per tick.
- **A plugin in the fleet set is disabled at user scope.** It is still enabled
  for Kookr agents. The row shows both states.
- **Project overrides a fleet plugin to `false`.** The project wins. The task
  record says which level won, as today.
- **Access probe gives a false negative.** The offer is hidden for at most five
  minutes after the cause clears. Nothing else depends on it.
- **Spawn while a plugin mutation runs.** As today, the record step waits up to
  5 seconds for the lock and then proceeds. A spawn that proceeded without the
  lock is now marked on the task and counted, not only logged. Catalog refresh
  no longer holds that lock, so the wait is limited to real installs, updates
  and uninstalls.

## Alternatives considered

- **Pass every plugin as an extra `--plugin-dir`.** Works (probe C), but ids
  become `@inline`, Kookr would resolve install paths itself, and the manager
  would show a version that agents might not be loading.
- **Declare the external plugins as dependencies of the bundled toolkit.**
  Rejected on evidence: an unmet dependency unloads the toolkit (D1, D2).
- **Drop `--setting-sources ''` so user-enabled plugins load.** Rejected: the
  flag is what makes bypass mode work (user `ask` rules otherwise win), and it
  would tie agents to whatever the operator enabled for themselves.
- **Per-project loadouts only, with a "copy to all projects" action.** Rejected:
  new projects start empty, which is the failure the fleet level removes.
- **Fleet level inside `plugin-loadouts.json`.** Rejected: an older server
  erases it on its next write (see Storage).
- **A plugin store that Kookr owns and pins per task.** The record already holds
  the versioned install path, and a path can be loaded with `--plugin-dir`
  (probe C), so each task could be pinned to the exact directory it started
  with. Not done now: ids become `@inline`, Kookr would have to keep directories
  alive against Claude Code's own cleanup, and the measured behaviour (old
  versions stay readable) removes the urgent case. Reopen if a version change
  under running tasks causes a real failure.
- **Turn the flag on by default in slice 1.** Rejected: it would change the
  spawn path for every user before anything was soaked.
- **Treat any version difference as `behind`.** Rejected: direction is unknown
  and it can make auto-update loop.
- **Remove a plugin from the fleet and loadout files during uninstall.**
  Rejected: two stores, two failure modes, no atomicity. The resolve-time filter
  already makes a stale entry harmless and visible.
- **Auto-install offered plugins.** Rejected: Kookr would be installing software
  unasked. One confirm is the cost of consent.
- **Keep offers in operator-local config only.** Simpler and discloses nothing,
  but then a second person with access gets no guided setup, which is the point
  of R8.

## Open questions

- **When Claude Code removes an orphaned version directory.** Old versions stay
  readable after an update, but for how long was not measured. A task that runs
  for many days across an update could lose its plugin files when the directory
  is cleaned up.
- **Does a git-sourced marketplace report `folderVersion`?** Decided by slice 2's
  acceptance evidence; the fallback covers a "no".
- **Interactive sessions and not-installed ids.** E1–E3 ran in print mode. The
  installed filter makes this irrelevant for fresh spawns; it matters only for
  resume after an uninstall.
- **Catalog version for non-relative sources.** For `git-subdir` and `url`
  sources with no declared version, the latest version is a commit SHA Kookr
  does not have locally. Reported as `unknown` (`no_version`).
- **Codex delivery, when its trigger fires.** The fork accepts `--plugin-dir`
  more than once but loads only each directory's `skills/`. Subagents and hooks
  from a plugin would not reach Codex agents by that route.

## Critic feedback incorporated

### Round 1 (2026-11-14) — five critics in parallel, shared evidence pack

Panel: `boundary-critic`, `failure-mode-analyst`, `design-minimalist`,
`delivery-pragmatist`, `operability-reviewer` (5, within the cap).

- `boundary-critic` (Needs Revision). The installed filter had two named owners;
  the flag was read in two layers; `devSource` pushed a resolution decision into
  the adapter; the playbook listing filter would have made core depend on server
  state; `offers.ts` mixed manifest, probe and install sequence; refresh coupled
  the read-side version source to a write-side lock; uninstall claimed atomicity
  across two stores. **Incorporated:** one pure launcher step
  (`partitionByInstalled`) behind an `InstalledPlugins` port; the launcher alone
  decides activation; `offers.ts` reduced to manifest and probe with a use case
  for the install sequence; refresh off the mutation lock; uninstall no longer
  edits loadout files. `devSource` and playbook requirements are deferred, with
  the ownership constraints the critic named written into their triggers.
- `failure-mode-analyst` (Revise). A rolled-back server erases a fleet level
  stored in the loadout file; "the launcher already has the read model" was
  false and would have put a CLI call on every spawn; refresh under the mutation
  lock would turn the spawn gate into a 5-second delay; the idle check is
  blocked by any non-Claude task; nothing recorded when the filter removed
  everything; uninstall had no running-task check; entry-first version order
  disagreed with Claude Code and "differs means behind" could loop; a failed
  access probe was cached for a day. **Incorporated:** separate fleet file;
  direct registry read; refresh off the lock; idle-check fix; always-record;
  busy check on uninstall; Claude Code's version order and `unknown` for
  non-semver; short failure TTL and same-transport probe. **Not incorporated:**
  making idle more frequent by excluding parked tasks; stated instead as an
  honest limit of `apply-when-idle`.
- `design-minimalist`. Cut playbook requirements, the local source override and
  Grok/Codex wiring; do not flip the flag; skip the store version bump; shrink
  the staleness table; simplify the offers manifest; three slices not four; drop
  the uninstall cleanup. **Incorporated**, all of these. **Partially rejected:**
  replacing the offers manifest with an operator-local setting, because a second
  person with access would then get no guided setup (R8); and dropping the busy
  check on manual update, because updating underneath live agents is the one
  action here that can break running work.
- `delivery-pragmatist` (Shippable with revisions). The kill switch does not
  undo recorded loadouts; slice 1 was not verifiable by the operator; the flag
  flip was bundled with the feature; slices were not independent; staleness
  arrives after delivery. **Incorporated:** explicit three-step rollback;
  acceptance evidence per slice; opt-in in slice 1 with the default changing
  only in slice 3; the real slice order stated; the fleet check as proof of
  load.
- `operability-reviewer` (Opaque, becoming "Needs Better Signals" with its first
  four findings). No observed-versus-intended signal; no version on the record;
  skips with no reason list or fleet-level alert; no view of which tasks predate
  a change; offers undiagnosable by design; partial `unknown` reasons.
  **Incorporated:** the fleet check (R5); id, version and path on the record;
  a fixed reason list, warn log and doctor count; config-epoch reuse for drift;
  offer diagnostics on request; the staleness reason list; marking spawns that
  proceeded without the lock. **Deferred to an open question:** per-task capture
  of the loaded set, pending a channel.

No adversarial pair ran: `ambition-amplifier` was left out to stay within five
lenses, because the scope is fixed by the operator's request and the
`design-minimalist` cuts each carry a reopening trigger rather than a deletion.

**Intent preservation check.** The operator's load-bearing asks are: choose in
Kookr which plugins Kookr's agents use; see new versions and update from Kookr;
an easy setup shown only to people who can read a private marketplace; public
Kookr keeps working without it. The revised design keeps all four (sections 1
and 5; 3 and 4; 6; R2 and the opt-in default). The cuts removed only the
author's additions.

### Empirical validation checkpoint (2026-11-14) — `design-experimenter`, Claude Code 2.1.325

Five claims probed in a throwaway config directory; the operator's real plugin
store was not touched. Raw results are in the evidence pack.

- **Version detection from the marketplace copy — confirmed, with two
  corrections.** A local-path marketplace is not cloned (`installLocation` is the
  original directory), and `claude plugin list --json` already reports the
  catalog version as `folderVersion`. `plugin.json` wins over the marketplace
  entry's `version`. Section 3 rewritten around these.
- **Old install directory after an update — the pessimistic assumption was
  wrong.** The old version is kept and marked `.orphaned_at`; uninstall also
  leaves the files. Edge cases and the busy check reworded; cleanup timing moved
  to Open questions.
- **A capture channel for interactive sessions — none live.** Hook payloads carry
  no plugin list. The transcript's `skill_listing` record is a usable,
  skills-only, after-the-fact signal. Section 2 now uses it and states its
  limits.
- **Cost of the installed check — confirmed.** Registry file read under 1 ms;
  `claude plugin list --json` about 3 s. The spawn path uses the file.
- **Codex multi-directory support — confirmed, skills only.** Recorded under
  Open questions for the deferred item.

### Consensus attack (2026-11-14) — one `general-purpose` agent against the panel's agreement

`general-purpose 2026-11-14`: consensus-attack — **shared blind spot found and
incorporated.** Every safeguard the panel negotiated (the mutation lock, busy
check, idle check, config epoch, automatic fleet check, recorded version) fires
only on Kookr's own writes, yet the plugin store is the operator's shared
user-scope store, which a terminal session or Claude Code's own updater can
change at any time. The agent verified that the lock is in-memory only and that
versions in the store already change without Kookr acting. It also pointed out
that the design's stated reason for rejecting `--plugin-dir` delivery (the
manager might show a version agents are not loading) applies to the chosen route
on every resume. **Triage:** incorporated as R10 and the "store itself is
shared" part of section 1 (detect, reduce through `autoUpdate: false`, and say
plainly that the version is recorded, not pinned), with R4 reworded. The
alternative it raised, a Kookr-owned pinned store, is recorded under
Alternatives with a reopening trigger. This was the single permitted revision
after convergence; it did not reopen the review.

### Independent merge review (2026-11-14) — fresh-context reviewer on the pull request

The first review of the pull request returned BLOCK with two confirmed defects,
both introduced by the consensus-attack revision, and six non-blocking notes.
All are corrected in this version.

- **`autoUpdate: false` was described wrongly.** The text said the fleet set does
  not touch `~/.claude/settings.json` and that the reused mechanism never
  overwrites an operator's value. The mechanism writes exactly that file and
  does pin `false` over an operator's `true` while Kookr owns the decision,
  restoring the recorded value on release. Section 1 now says so and requires a
  disclosure.
- **Detection depended on a sweep that is off by default.** External-change
  detection and catalog refresh were attached to the auto-update sweep, which
  runs only with `KOOKR_PLUGIN_AUTO_UPDATE`. The sweep is now split into an
  observe half that runs whenever loadouts are active and an apply half that
  keeps the flag.
- **Notes taken:** the spawn gate keeps its auto-update arm; the kill switch
  keeps its shipped effect on resume, through one shared predicate, and the
  Rollback section matches it; `registry_unreadable` removed as unreachable, and
  a selection rule added for per-scope install records; the bundled toolkit's
  `@inline` rewrite and its row are stated; the file list names the modules that
  actually hold the observed-version baseline and the replay call sites; three
  evidence-pack corrections.

