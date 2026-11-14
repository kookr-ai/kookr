# Evidence pack — RFC: plugins for the Kookr fleet

Shared evidence for `docs/rfc/rfc-external-plugin-fleet.md`. Everything here is
**evidence to check, not settled fact**: re-read the cited source before relying
on a claim that carries weight in your review.

Source revision: `origin/main` at `ca18b984`. Claude Code `2.1.325`, Linux (WSL2).

## Pipeline map

How a plugin reaches a spawned Claude agent today, and who owns each step.

| Step | Owner | What it does |
|---|---|---|
| Resolve the bundled plugin directory | `src/core/plugin-paths.ts:35-53` `resolvePluginDir` | Returns **one** path (explicit option, then `KOOKR_PLUGIN_DIR`, then `<repo>/plugin`), or `undefined` |
| Build the launch command | `src/adapters/claude-code-adapter.ts:399-414` | In bypass mode adds `--dangerously-skip-permissions --setting-sources ''`; always adds one `--plugin-dir <bundled>` |
| Write the per-session settings file | `src/adapters/claude-code-adapter.ts:1031-1116` `generateSettings` | Emits hooks, permissions and, when a loadout is passed and the flag is on, `enabledPlugins` |
| Resolve a loadout | `src/server/plugin-manager/loadout-store.ts:137-151,284-300`; pure resolver in `src/core/claude-settings/loadout.ts:43-77` | Three levels, most specific wins per plugin: task-type (`agentType`), playbook (`playbookId`), project (`projectId`). Always resolved in `bypass` mode. Claude adapter only |
| Render a loadout | `src/core/claude-settings/loadout.ts:96-109` `renderEnabledPlugins` | Turns `enabledOverrides` into the `enabledPlugins` map; rewrites ids of directory-loaded plugins to `<name>@inline` |
| Record on the task | `TaskLoadoutRecord` in `src/shared/contracts/plugins.ts:141-149` | Resolved loadout, winning level, settings-file hash and path. Resume replays it (`replayRecordedLoadout`) |
| Feature flag | `src/core/claude-settings/loadout.ts:111-119` | `KOOKR_PLUGIN_LOADOUTS`, **off by default** |
| Fleet read model | `src/server/plugin-manager/read-model.ts:43-116` | One row per **installed** plugin, from `claude plugin list --json` |
| Available version | `src/server/plugin-manager/version-source.ts:18-42` | Git-sourced for `kookr-toolkit` only. Every other plugin: `staleness: unknown`, reason "Catalog not refreshed" |
| Mutations | `src/server/plugin-manager/cli.ts:53-85`; routes in `src/server/routes/plugin-routes.ts` | `list`, `details`, `update`, `marketplaceAdd`, `install`. **No uninstall.** `POST /api/plugins/install` installs the toolkit only; `own-session/install` installs any id |
| Auto-update idle check | `src/core/plugin-auto-update/idle-predicate.ts` | A non-terminal task with **no recorded loadout counts as depending on every plugin** |
| Spawn gate | `src/server/plugin-manager/loadout-store.ts:41-88` | When loadouts or auto-update are on, the loadout record step takes the plugin mutation lock (waits up to 5 s, then proceeds without it) |

Other agent types:

- **Codex** (`src/adapters/codex-cli-adapter.ts:357,397-406,576-591`): one `--plugin-dir`, passed only when the binary's `--help` advertises the flag.
- **Grok** (`src/adapters/grok-home-composer.ts:131-209`): builds a per-session home and symlinks every entry under `~/.grok/plugins/*`; falls back to linking the one bundled directory.
- **OpenCode**: receives no skills or subagents; only profiles and two notebook hooks.

Playbooks: `src/core/playbook-discovery.ts:49-122` has three tiers (project, user,
plugin). The plugin tier is the bundled directory's `playbooks/`. Frontmatter keys
are an allowlist in `src/core/playbook-parser.ts:30-45`.

Dashboard: `src/frontend/components/PluginManagerDialog.tsx` renders installed
plugins, enable/disable for own sessions, per-plugin update and install-by-id.
No frontend file calls the loadout routes.

## Measurements and probes

All sessions: `claude -p 'say OK' --output-format stream-json --verbose
--dangerously-skip-permissions --setting-sources ''` plus the listed flags; the
`system/init` message's `plugins[]`, `skills[]` and `plugin_errors[]` were read.

| # | Extra flags | Result |
|---|---|---|
| A | `--plugin-dir <bundled>` | Only the bundled plugin loads (`kookr-toolkit@inline`). No user-installed plugin |
| B | A + `--settings {"enabledPlugins":{"<installed>@<mkt>":true}}` | The installed marketplace plugin **loads under its real id** |
| C | A + second `--plugin-dir <install path of that plugin>` | It loads as `<name>@inline` |
| D1 | `--plugin-dir <plugin whose plugin.json declares a dependency that exists nowhere>` | **Plugin does not load.** `plugin_errors: dependency-unsatisfied` |
| D2 | Same, dependency is installed but not enabled in the session | **Plugin does not load.** Same error |
| D3 | D2 + `--settings` enabling the dependency | Both load |
| D4 | Bare-name dependency satisfied by a second `--plugin-dir` | Both load |
| E1 | `--settings` enabling an id that does not exist in a known marketplace | Silently ignored. No error, nothing loaded |
| E2 | `--settings` enabling a real, available, **not installed** plugin | Silently ignored. `installed_plugins.json` unchanged (no auto-install in `-p` mode) |
| E3 | `--settings` enabling a plugin from an unknown marketplace | Silently ignored |

E1–E3 were run in print mode. Kookr agents are interactive sessions; whether an
interactive session fetches a not-installed plugin named in `--settings` is
**not** measured.

Access check for a private marketplace repository, `GIT_TERMINAL_PROMPT=0 git
ls-remote <https url> HEAD`:

| Case | Exit code | Time |
|---|---|---|
| Readable private repository (empty, no commits) with `--exit-code` | 2 (no matching ref) | 0.9 s |
| Repository that does not exist or is not readable | 128 | 0.5 s |
| Readable repository, credentials withheld | 128, no prompt | 0.3 s |

So exit 0 **without** `--exit-code` means readable; 128 means not readable or
absent. It never prompts with `GIT_TERMINAL_PROMPT=0`.

Native catalog: `claude plugin list --json --available` returns
`{installed:[…], available:[…]}`. `available` entries carry `pluginId`, `name`,
`marketplaceName`, `source`, and `version` when the marketplace entry declares
one (3,589 of 4,057 on this machine). Four of five installed plugins are absent
from `available`, so it cannot supply the latest version of an installed plugin.
`claude plugin marketplace list --json` returns name, source and `installLocation`
(a local clone containing `.claude-plugin/marketplace.json`).
`claude plugin marketplace update <name> --json` refreshes one clone.

Documented behaviour (Claude Code plugin docs; not re-measured):

- Version resolution order: `plugin.json` `version`, then the marketplace entry
  `version`, then the source commit SHA.
- `--plugin-dir` is repeatable, and an enabled directory-loaded plugin replaces a
  same-named installed plugin.
- There is no alias for a skill or subagent whose plugin changes.
- `claude plugin uninstall <id>` exists (`claude plugin --help`).

Cost figure used in the RFC: `claude plugin details kookr-toolkit` reports
"Always-on ~10,655 tok" for the bundled plugin (77 skills, 25 subagents).

## Source pointers

- Prior RFC and its probes: `docs/rfc/rfc-plugin-skill-manager.md` (Layer 2 at
  259-325, split deferred at 522-530), `docs/rfc/rfc-plugin-skill-manager-evidence.md`
  (P3 at 93-100), `docs/rfc/rfc-plugin-skill-manager-p2-probe.md`.
- Production runs bypass mode: `KOOKR_BYPASS_ALL_PERMISSIONS=true` in the
  operator's `.env`; documented in `CLAUDE.md` "Bypassing agent permission prompts".
- Toolkit-only literals: `src/server/plugin-version-status.ts:14-21`
  (`DEFAULT_PLUGIN_ID`), `src/server/plugin-manager/read-model.ts:17`
  (`UNINSTALL_GUARDED_PREFIXES`), `src/shared/contracts/plugin-version.ts:69`.
- Playbook launch error when the plugin tier is missing:
  `src/server/use-cases/playbook-launch.ts:80,232`.

## Empirical checkpoint results (after review round 1)

Run in a throwaway `CLAUDE_CONFIG_DIR` with a local-path marketplace (`mk`) and
one plugin (`demo`), unless stated.

| Question | Observation |
|---|---|
| Is a local-path marketplace cloned? | No. `marketplace list --json` reports `"source":"directory"` and `installLocation` equal to the original path. A git-clone marketplace was not exercised |
| Staleness signal after bumping `demo` to 1.1.0 and `marketplace update mk` | `plugin list --json` reports `"version":"1.0.0"`, `"folderVersion":"1.1.0"` |
| `folderVersion` on the operator's git-sourced marketplaces | Not present on any of five installed plugins (installed and catalog versions equal there) |
| `plugin.json` 1.1.0 versus marketplace entry `version` 9.9.9 | `update` and a fresh `install` both chose 1.1.0 |
| Old version directory after `update` | Kept. Gains an `.orphaned_at` file (millisecond timestamp); skills and manifest intact |
| Cache after `uninstall` | Both version directories still on disk; `installed_plugins.json` empty; reinstall reuses the path |
| `list --json --available` for an installed plugin | Not listed in `available` |
| SessionStart hook payload fields (5 recent of 413 files) | `session_id`, `transcript_path`, `cwd`, `source`, `model`, `kookr_hook_written_at_ms`. No plugin or skill list |
| Interactive transcript | No `plugins` or `plugin_errors` record. One `skill_listing` attachment with namespaced skill names (77 `kookr-toolkit:` names in one) |
| Print-mode canary timing (3 runs) | `init` line at 4.8–5.7 s; total 10–11 s; stopping after `init` works (6.9 s) |
| `claude plugin list --json`, 10 runs | Median 2,975 ms, max 3,216 ms |
| Direct read of `installed_plugins.json`, 10 runs | Median 0.0 ms, max 0.2 ms. `registry.ts` already has `readInstalledPlugins` |
| Codex fork `--plugin-dir` | Advertised, "May be specified multiple times" (`plugin_dirs: Vec<PathBuf>`). Loads only each directory's `skills/`. Stock `codex` on PATH does not have the flag |

From the consensus attack (read-only checks on the operator's machine):

- The plugin mutation lock is an in-memory field of `PluginMutationService`; no
  lockfile.
- The bundled toolkit's marketplace install has 22 version directories dated
  3–14 November; nothing older survives although it was first installed in May.
- A plugin whose marketplace is not registered changed version three times in
  two days without a Kookr action.
