# Evidence pack: Per-project automation pause

Treat every item as a **claim to verify**, not settled fact. Re-read cited
source before relying on it. Assembled 2026-09-02 from `origin/main`
(`5b1161f9`) plus the live `~/.kookr` node on this machine.

**Addendum after round 1:** several pack line numbers and the autonomous-source
set were grepped from a sibling checkout, not this tree. Corrected facts
below supersede the original pipeline map where they conflict.

## 1. Pipeline map

The global automation kill-switch (SAFE MODE, issue #1710) is already a
single conjunction in front of autonomous actuation. A per-project pause
should sit in that same conjunction, not invent a second control plane.

```text
Settings.automationKillSwitch  (global, default false)
        │
        ▼
isAutomationEnabled() = !automationKillSwitch && !settingsLoadError
        │
        ├── schedule-runner fire  ── skipped_safe_mode  (~947–967 on this tree)
        ├── launch-service        ── AutomationKillSwitchError
        │     (if isAutonomousLaunchSource: schedule | idle-refinery | post-recovery)
        ├── idle-refinery-runner  ── no-op tick
        └── post-recovery-service ── whole-tick suppress under global SAFE MODE
              (~359–361); per-repo kicks use launchSource 'post-recovery' (~806)
```

Proposed addition (this RFC):

```text
ProjectConfig.automationEnabled  (per project, omit = true)
        │
        ▼
projectAutomationAllowed(projectId) = automationEnabled !== false
        │
        ▼
mayAutonomousActuate(projectId) =
    isAutomationEnabled()
    AND projectAutomationAllowed(projectId)
```

Schedule `enabled` / `operatorHold` stay independent. A paused project
does **not** flip those bits.

### Load-bearing modules

| Role | Path | Notes |
|---|---|---|
| Global predicate | `src/core/automation-kill-switch.ts` | `isAutonomousLaunchSource` is `'schedule' \| 'idle-refinery' \| 'post-recovery'` (this tree, #2899). `isSafeModeExemptSchedule` matches exact basename `cross-repo-orchestrator.md`. |
| Settings persistence | `src/core/settings-store.ts` ~356–364, 766–784, 1030–1088 | `automationKillSwitch` + `safeModeSince`. Corrupt boolean fail-closes global SAFE MODE (#2085). |
| Fire-time gate | `src/server/schedule-runner.ts` ~947–967 | Skip outcome `skipped_safe_mode` / reason `safe_mode`. ~812 is playbook resolution, not the gate. |
| Launch-time gate | `src/server/launch-service.ts` ~1168–1179 | Autonomous sources only; `safeModeExempt` lets the orchestrator agent launch. |
| Idle refinery | `src/server/idle-refinery-runner.ts` ~25–27, 53, 132 | Short-circuits on `isAutomationEnabled` before calling the launcher. |
| Wiring | `src/server/index.ts` ~1687, 2204, 2272, 2297, 2322 | `isAutomationEnabled: () => !currentSettings.automationKillSwitch && !settingsLoadError`. |
| Orchestration pause | `src/core/orchestration-pause.ts` | Thin wrapper over **global** SAFE MODE. Not per-project. `orchestratorShouldSpawn` is the playbook-side honor check for API child launches. |
| Project config | `src/shared/contracts/project-config.ts` | Existing per-project row in `~/.kookr/project-configs.json`. Precedent boolean: `autoSyncOnManualLaunch` (REST `POST /api/projects/configs` only — **not** in WS `projectConfigPartial`). No automation field today. |
| Project config store | `src/core/project-config-store.ts` | `setConfig` merge-patch. REST write: `POST /api/projects/configs` (`project-routes.ts:69`). No file watcher on this JSON (only `getRateLimitsPath`). |
| Project identity | `src/core/project-identity.ts` `getProjectId(cwd)` ~156–169 | `git remote get-url origin` → `github.com/owner/repo`, else `local/<basename>`. |
| Canonical path | `src/core/project-identity.ts` `deriveCanonicalPath` ~190–198 | Special-case: `kookr-prod` suffix prefers the parent clone. |
| Schedule projectId today | `src/server/schedule-validator.ts` ~177–187 | Only set when a playbook parameter has `source: 'tracked-projects'`. Most schedules therefore launch **without** `projectId`. Agent-lifecycle later stamps it via `getProjectId(cwd)` (`src/server/agent-lifecycle.ts` ~174–193). |
| UI global switch | `src/frontend/components/SettingsDialog.tsx` ~1396–1416 | "Automation kill-switch" / SAFE MODE. |
| UI project drawer | `src/frontend/components/ProjectDetailDrawer.tsx` | Edits `dailyPrLimit`, `budgetWarnUsd`, `zeroDrainIssueLimit`, `notes` via `setProjectConfig`. No automation toggle. |
| Skip copy | `src/frontend/components/SchedulesDialog.tsx` ~145, 172 | Already renders `skipped: SAFE MODE`. |

### What the global switch does **not** stop

- Manual launches (`api` / `ui` / `cli` / `websocket` / `remote`).
- Child spawns from an already-running task (those are not autonomous sources).
- Drain mode is a different lever (`isAccepting`): it refuses **all** new launches.
- In-flight tasks keep running.

A per-project pause must match this shape, filtered by project.

## 2. Live fleet snapshot (2026-09-02, this machine)

27 schedules in `~/.kookr/schedules.json`, grouped by `cwd`:

| cwd | n | ON | Notes |
|---|---|---|---|
| `/home/jean/git/lucy` | 11 | 10 | Issue batch, prod-update watchdog, backtest watchdog, daily report, workflow reflection, orchestration supervisor, idea scout, incident sentinel (every 30 min), product-surface journey, **Kookr Queue Feeder** (fleet-wide, mis-homed), Grok batch off |
| `/home/jean/git/lucy-l3-runtime` | 2 | 2 | Deploy convergence, orchestration effectiveness. **Same git remote as Lucy.** |
| `/home/jean/git/kookr` | 3 | 2 | Parallel issue batch, PR merge watchdog; cross-repo orchestrator **off** |
| `/home/jean/git/kookr-prod` | 6 | 4 | Codex rebase, Kookr idea scout, Grok sync, deploy convergence; two idea scouts off. **Worktree of kookr; same git remote.** |
| `/home/jean/git/kb-scout-evol` | 1 | 1 | Orchestration supervisor |
| `/home/jean/.claude` | 1 | 1 | KB-Scout daily reflection. **Not the kb-scout-evol cwd.** |
| `/home/jean/git/knowledge-base-mcp-server` | 1 | 1 | Daily reindex |
| `/home/jean/git/tech-writing-evol` | 1 | 1 | Orchestration supervisor |
| `/home/jean/git/req-redundancy-research` | 1 | 0 | Held (`operatorHold`) |

Git remotes verified:

- `lucy` and `lucy-l3-runtime` → `github.com/jeanibarz/lucy` (separate clones, same origin).
- `kookr` and `kookr-prod` → `github.com/kookr-ai/kookr` (`kookr-prod` is a worktree; git-common-dir is the main clone).
- `kb-scout-evol`, `knowledge-base-mcp-server`, `tech-writing-evol` → their own GitHub remotes.

`project-configs.json` already has rows with `localPath` for Lucy, Kookr, kb-scout-evol, knowledge-base-mcp-server, tech-writing-evol, reason-at-home, local-research-agent. No automation field.

## 3. How recent projects actually automate

### Lucy (`github.com/jeanibarz/lucy`)

Almost all *agent* automation is already Kookr schedules (table above). The
Lucy orchestration supervisor playbook (`.kookr/playbooks/lucy-orchestration-supervisor.md`)
spawns children over the Kookr API; it is itself schedule-fired.

Lucy also has a **product** runtime (control room, newswire, price ticker)
with its own env kill switches (`PRICE_TICKER_ENABLED`, owner-id kill
switch in user-management docs). Those are the product, not Kookr
actuation. A Kookr per-project pause must not claim to stop the trading
bot.

### KB-Scout Evol

One orchestration supervisor schedule on the repo cwd, plus a daily
reflection schedule whose cwd is `~/.claude`. Training / eval loops are
started *by* that supervisor (or by humans), not by a second scheduler.

### Knowledge-base MCP server

One Kookr schedule (`kb-reindex.md` at 05:00). The MCP server process
itself is not a Kookr actuator.

### Tech-writing evol

One orchestration supervisor schedule. Same shape as KB-Scout.

### Reason-at-home / local-research-agent

Present in `project-configs.json` with `localPath`. No live Kookr
schedules on this node today. Idea-scout schedules for local-research
exist under `kookr-prod` cwd and are currently **off**.

## 4. Source pointers for critics

- Global gate semantics: `src/core/automation-kill-switch.ts:26–39`, `src/server/schedule-runner.ts:947–967`, `src/server/launch-service.ts:1168–1179`.
- Autonomous sources: `src/core/automation-kill-switch.ts:33–39` (`schedule | idle-refinery | post-recovery`).
- Post-recovery: whole-tick SAFE MODE suppress `src/server/post-recovery-service.ts:359–361`; kick `launchSource: 'post-recovery'` `:806`; `projectId` from repo `:774–801`.
- Dead-man suppression set: `src/server/schedule-dead-man.ts:142–155` (includes `skipped_safe_mode`; a new skip must be added here).
- `mapErrorToReasonCode`: `src/server/schedule-runner.ts:1710–1722` (`AutomationKillSwitchError` → `safe_mode`).
- Project config write: `POST /api/projects/configs` `src/server/routes/project-routes.ts:69`. WS `projectConfigPartial` `src/shared/contracts/client-message-schema.ts:66–78` (no `autoSyncOnManualLaunch`).
- Identity: `src/core/project-identity.ts:156–169` (always returns a string), `src/server/agent-lifecycle.ts:174–193`, `src/server/schedule-validator.ts:177–187`.
- Dual `ProjectSummary`: wire `src/shared/contracts/project-summary.ts`; projection `src/core/project-summary.ts` (`GET /api/projects`).
- Orchestration pause is global: `src/core/orchestration-pause.ts:1–30`, `376–399`.
- UI drawer: `src/frontend/components/ProjectDetailDrawer.tsx:16`, `119–140`.
- Skip outcome union (two copies): `src/shared/contracts/schedule.ts` and `src/core/schedule.ts` (mirror).

## 5. Telemetry / measurements

- 27 live schedules; Lucy owns 13 of them across two cwds that share one GitHub project id.
- Turning the **global** kill-switch off today is the only way to pause Lucy without also pausing Kookr deploy-convergence, kb-scout, and KB reindex — unless the operator clicks 10+ individual schedule toggles and later remembers which ones were already off.
- `schedule.enabled` is already overloaded: operator hold (#2196 / #2520), consecutive-failure auto-pause (#2353), trigger-limit exhaustion. Bulk-writing `enabled: false` would destroy that provenance.
- `~/.claude` origin is `github.com/jeanibarz/dotclaude` (verified `git remote get-url origin`). KB-Scout reflection cwd therefore pauses with **dotclaude**, not kb-scout-evol, unless pinned.
- Duplicate `project-configs.json` rows: `local/lucy` and `github.com/jeanibarz/lucy` both have `localPath: /home/jean/git/lucy`.
- Queue-feeder schedule cwd is `/home/jean/git/lucy` (fleet-wide actuator mis-homed).
