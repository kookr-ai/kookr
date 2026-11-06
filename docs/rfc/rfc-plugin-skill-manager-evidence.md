# Evidence pack — Plugin & Skill Manager RFC

Shared evidence for critic review. **Evidence to check, not settled fact** — re-read cited source before relying on any claim.

## Pipeline map — existing plugin/skill surface in Kookr

Kookr ships exactly **one** marketplace (`kookr`) with exactly **one** plugin
(`kookr-toolkit`, 65 skills + 19 review subagents), sourced from the kookr repo's
own `./plugin` directory.

### Manifests
- `.claude-plugin/marketplace.json` — marketplace `kookr`, one plugin entry
  `kookr-toolkit` with `"source": "./plugin"`, category `development`.
- `plugin/.claude-plugin/plugin.json` — `kookr-toolkit` v0.16.49, 65 skill dirs
  under `plugin/skills/`.
- `plugin/skills/<name>/SKILL.md` — one dir per skill (65).
- `plugin/reviewer-specialists/`, `plugin/agents/`, `plugin/hooks/`,
  `plugin/playbooks/` — the plugin's other asset classes.

### Backend (already built)
- `src/shared/contracts/plugin-version.ts` — wire contract `PluginVersionStatus`
  `{ pluginId, installedVersion, availableVersion, stale }`, plus
  `PluginUpdateCommands/Result/Error`, `pluginInstallCommands`,
  `pluginUpdateCommands`, `marketplaceNameFromPluginId`, and the pinned
  `TOOLKIT_MARKETPLACE_SLUG = 'kookr-ai/kookr'`.
- `src/server/plugin-version-status.ts` — `getPluginVersionStatus()` reads the
  installed version from `~/.claude/plugins/installed_plugins.json`
  (`plugins[pluginId]` is an **array** of records, one per install scope; highest
  version wins), compares against the available version via a small dotted
  integer `compareVersions`. Comment confirms: *"Claude Code's marketplace install
  never auto-updates and is sourced from GitHub, so the cached plugin silently
  drifts behind the local source."*
- `src/server/routes/deploy-routes.ts`:
  - `GET /api/deploy/status` → includes a `plugin` field (install/stale status).
    Available version is read from `origin/main:plugin/.claude-plugin/plugin.json`
    (same remote `/plugin marketplace update` pulls from), falling back to disk.
  - `POST /api/deploy/plugin-install` → runs `claude plugin marketplace add <slug>`
    then `claude plugin install <id>` non-interactively (via `execFile`), with a
    **full backup/restore of `~/.claude/plugins`** and a 3-try verification loop.
  - `POST /api/deploy/plugin-update` → runs `claude plugin marketplace update <mkt>`
    then `claude plugin update <id>`.
  - A single `pluginMutating` boolean serializes all mutations to
    `~/.claude/plugins/` (409 on concurrent).
  - `pluginUpdateBin` defaults to `process.env.KOOKR_AGENT_BIN ?? 'claude'`.
- `src/server/toolkit-symlink-status.ts` + `scripts/install-hooks.sh` — a
  **separate** delivery path: install-hooks.sh symlinks a *small* set of
  hook-companion skills (`pre-pr-review`, `pr-contribution-excellence`) and
  `reviewer-specialists` from the repo into `~/.claude/skills/` /
  `~/.claude/reviewer-specialists/` so globally-firing hooks can find them. This
  is NOT the general skill-delivery path — the marketplace plugin is. Symlink
  rows are emitted by `install-hooks.sh --print-global-assets`.

### Frontend (already built, React/.tsx)
- `src/frontend/components/TopBar.tsx` — version badge + popover; already holds
  `updateToolkitPlugin()` wired to `POST /api/deploy/plugin-update`, reads
  `deployStatus.plugin.stale` / `.installedVersion`. TopBar already consolidated
  most icon actions into a **command palette** (`onCommandPalette`); Schedules,
  Settings, Help, OSS, etc. live there now.
- `src/frontend/components/PluginInstallBanner.tsx` — dismissible first-run nudge
  when the plugin is not installed; opens a confirm dialog that calls
  `installToolkitPlugin()`; shows a backup/rollback safety note; has a "show
  manual commands" toggle.
- `src/frontend/components/SettingsDialog.tsx`,
  `EffectiveHookSettingsModal.tsx` — existing settings surfaces.

## Key facts / measurements
- The plugin is **monolithic**: 65 skills in one plugin. No per-skill
  enable/disable is exposed to the Kookr user today; it's install-all or nothing.
- Kookr already shells out to the `claude plugin ...` CLI non-interactively and
  safely (backup/restore, lock, verification). Generalizing from one hardcoded
  plugin id to N plugins is an extension of proven code, not new infrastructure.
- Two skill-delivery paths coexist: (1) marketplace plugin in `~/.claude/plugins`
  (all sessions once installed), (2) the install-hooks symlink farm (a couple of
  hook-companion skills). Any per-skill mechanism must say which path it governs.
- An existing RFC `docs/rfc/rfc-plugin-skill-improvements.md` covers skill
  *content quality* (stale refs, drift, token bloat) — orthogonal to this RFC,
  which is about *management/UX*. `scripts/validate-skills.ts` +
  `npm run validate:skills` is the existing skill linter/CI gate.

## EMPIRICAL RESULTS (design-experimenter, `claude` 2.1.319, isolated probes)
High-confidence runtime findings that falsify/clarify load-bearing claims:

- **P1 — deny name form:** plugin skills are named `<plugin>:<skill>`. `Skill(<plugin>:<skill>)`
  blocks precisely; bare `Skill(<skill>)` also matches (over-matches); `Skill(<plugin>:*)`
  blocks the whole namespace. **Canonical rule: `Skill(<plugin>:<skill>)`.**
- **P2 — per-skill deny does NOT save context (FALSIFIES the RFC's budget framing).**
  Deny is an *invocation gate*, not a loader exclusion. `/context` still lists a denied
  skill; measured input tokens are identical denied vs not. Control: `enabledPlugins:false`
  removes the plugin from `init.plugins` and saves **~55.6k tokens** for kookr-toolkit;
  a whole-namespace deny saves **+11** (nothing). `claude plugin details kookr-toolkit`
  = "Always-on ~8,994 tok" that deny cannot reduce. → **Budget control is plugin-level ONLY.
  Per-skill deny = behavior/safety gate only.**
- **P3 — bypass mode (`--setting-sources ''`, used by the adapter at
  `claude-code-adapter.ts:301`) DROPS global user AND project `enabledPlugins` +
  `permissions.deny`.** Confirmed: init.plugins falls to built-ins only, init.skills
  19 vs 124, a user `.env` deny is ignored. BUT explicit `--settings <file>` still applies
  (enablement + deny), and `--plugin-dir` still applies. → **Editing global settings.json
  does NOT reach bypass-mode Kookr agents; the per-session `--settings` file is the only
  lever.** (The adapter already writes `--settings <path>` on every spawn — lines 349/351 —
  and `generateSettings` already emits `permissions:{allow,deny}` — lines 264-266.)
- **P4 — settings pickup:** a NEW `claude -p` session reflects a settings-file edit
  (`enabledPlugins` and deny). Live running sessions still need `/reload-plugins`.
- **P5 — name collision:** `Skill(<plugin>:<skill>)` targets the plugin skill alone;
  bare `Skill(<skill>)` hits both the plugin skill and a same-named user/project skill.
  **No rule targets the user-symlinked copy alone** → the hook-companion skills
  `pre-pr-review` / `pr-contribution-excellence` (both plugin-skill AND `~/.claude/skills`
  symlink) can't be deny-scoped without ambiguity; mark them protected.

## Live-config caveats (failure-mode-analyst, verified on disk)
- Enablement is **tri-state**: `claude-notifications-go` has NO `enabledPlugins` entry
  (absent ≠ false). The read model must resolve absent → native default.
- `stripe@anthropic-plugin-directory`'s marketplace is **absent** from
  `known_marketplaces.json` — don't assume every plugin's marketplace is registered there.
- `autoUpdate` is **absent** on every live marketplace entry (3 of 5 marketplaces have no
  entry at all) — read defaults, don't assume the field exists.
- Existing readers/writers of these keys already exist: `src/core/ralph-plugin-coexistence.ts`
  (reads `enabledPlugins`), `src/adapters/claude-code-adapter.ts` (writes per-session
  `permissions.deny` via `--settings`). A single settings-access owner is warranted.
- Existing plugin backup covers `~/.claude/plugins/` only — NOT `settings.json`.

## Source pointers
- `.claude-plugin/marketplace.json`
- `plugin/.claude-plugin/plugin.json`
- `src/shared/contracts/plugin-version.ts:8-69`
- `src/server/plugin-version-status.ts:21-89`
- `src/server/routes/deploy-routes.ts:284-706` (status/install/update routes)
- `src/server/toolkit-symlink-status.ts:28-63`
- `scripts/install-hooks.sh:82-209`
- `src/frontend/components/TopBar.tsx:1-290`
- `src/frontend/components/PluginInstallBanner.tsx:150-273`

## REAL on-disk config (this operator's machine, 2026-11-07)
Ground truth read directly from `~/.claude`:

- `~/.claude/plugins/installed_plugins.json` (`"version": 2`) already lists **5
  plugins across 5 marketplaces**: `claude-notifications-go@claude-notifications-go`,
  `ralph-wiggum@claude-code-plugins`, `rust-analyzer-lsp@claude-plugins-official`,
  `kookr-toolkit@kookr` (v0.16.81), `stripe@anthropic-plugin-directory`. Each value
  is an array of `{ scope, installPath, version, installedAt, lastUpdated,
  gitCommitSha, directoryRepositoryKey? }`. `installPath` is a per-version cache dir
  (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`). → **Multi-plugin,
  multi-marketplace is already the lived reality**, managed today only through
  Claude Code's own `/plugin` UI.
- `~/.claude/settings.json` holds:
  - `enabledPlugins`: a **plugin-level boolean map**, e.g.
    `{ "ralph-wiggum@claude-code-plugins": false, "kookr-toolkit@kookr": true, ... }`.
    → enable/disable granularity is **per-plugin**, keyed `plugin@marketplace`,
    and is a plain editable JSON boolean.
  - `extraKnownMarketplaces` (where added marketplaces register).
  - Other keys: `permissions, model, hooks, statusLine, modelSettings, tui, …`.
  - **No per-skill key of any kind.** Nothing scopes an individual skill on/off.
- Implication (strong, pending agent confirmation of the negative): Claude Code
  exposes **plugin-level** enable/disable only. Per-skill disable is not a native
  setting. Splitting the monolith into themed plugins is therefore the
  native-supported route to "skill-group" control.

## RESOLVED — native Claude Code capability (verified via docs + installed binary)
Confirmed by a claude-code-guide agent against code.claude.com/docs + the installed
`claude plugin --help`. Treat the two "uncertain" items as spike targets.

1. **Per-skill enable/disable — NO native per-skill toggle; granularity is
   plugin-only** for enable/disable (`claude plugin enable|disable <plugin>`,
   the `/plugin` Installed tab, `enabledPlugins`). `skillOverrides` is documented
   **not** to apply to plugin skills. **BUT** per-skill *disable* is reachable via
   the permission system: `"permissions": {"deny": ["Skill(<name>)"]}` is
   documented to apply to plugin skills (also `--disallowedTools`). Frontmatter
   gating exists but a consumer can't edit an installed plugin's SKILL.md.
   *Uncertain (spike):* the exact `Skill(...)` name form for a plugin skill
   (`Skill(x)` vs `Skill(plugin:x)`), and whether a denied skill still costs
   context tokens.
2. **`enabledPlugins`** — `{"<name>@<origin>": boolean}` in `~/.claude/settings.json`
   (user), `.claude/settings.json` (project), `.claude/settings.local.json`
   (local), `--settings`, managed. Precedence low→high: --add-dir, user, project,
   local, flag, managed.
3. **Marketplaces/plugins CLI (verified, non-interactive):**
   - `claude plugin marketplace add <source> [--scope user|project|local] [--json]`
     (source accepts `owner/repo#ref`); `marketplace list|update [name]|remove <name> [--json]`.
   - `claude plugin install <plugin>[@marketplace] [-s user|project|local] [-y] [--json]`.
   - `claude plugin list [--json] [--available]`, `claude plugin details <name>`
     (**reports component inventory + projected token cost** — useful for the UI),
     `claude plugin enable|disable [plugin]`, `claude plugin configure <plugin> --values-stdin`.
   - Registry `~/.claude/plugins/installed_plugins.json` `version:2` (shape confirmed
     above). Also `~/.claude/plugins/known_marketplaces.json`
     `{"<name>": {"source": {source:"github", repo}, installLocation, lastUpdated}}`.
4. **Updates** — auto-update is **ON by default for official + claude.ai
   marketplaces, OFF for others**; per-marketplace `autoUpdate` flag on the
   `extraKnownMarketplaces` entry; global kill via `DISABLE_AUTOUPDATER=1` etc.
   Apply non-interactively: `claude plugin update <id> -y --json` (**no update-all**).
   Catalog refresh `claude plugin marketplace update` does **not** change installed
   plugins. **No native check-without-apply** — comparing refreshed catalog vs
   `installed_plugins.json` version is the (inferred) way, which is exactly what
   Kookr's `getPluginVersionStatus` already does for one plugin. Ref pinning
   (`#ref`, `sha` wins over `ref`) supported.
5. **enabledPlugins edit pickup** — a **new session** picks up file edits; a
   **running session** does **not** until `/reload-plugins` or restart. So Kookr
   edits are naturally scoped to future sessions; live sessions need a reload nudge.
6. **Subset-of-skills mechanisms (ranked by the agent):** A per-session plugin
   switch `--settings '{"enabledPlugins":{...false}}'` (plugin granularity);
   **B per-session deny list `--settings '{"permissions":{"deny":["Skill(x)"]}}'`
   / `--disallowedTools` (recommended spike first)**; C filtered copy via
   `claude --plugin-dir <copy>` (delete unwanted `skills/<name>/`; SDK:
   `plugins:[{type:"local",path}]`); D standalone copies in project `.claude/skills/`;
   E `CLAUDE_CONFIG_DIR` per agent. Kookr already spawns agents, so per-session
   `--settings` injection (A/B) is the cheapest lever for *Kookr-spawned* agents.
