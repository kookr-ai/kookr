# RFC: Default Agent Selection

## Status

**Accepted** (implemented in this branch)

## Date

2026-05-12

## Author

Jean Ibarz (with Codex)

---

## Problem

Kookr supports both Claude Code and Codex CLI agents. The launch surfaces already let the user choose an agent per task, and several frontend entry points remember the last choice in `localStorage` under `kookr:defaultAgentType`.

That preference is not an authoritative Kookr setting:

- It is browser-local, so CLI and API launches do not see it.
- It is not discoverable in Settings.
- It does not solve child-task launches such as `kookr-spawn`, where the agent usually omits `--agent` and expects the server default to apply.
- The server default is currently the adapter registry's first registered adapter, which is an implementation detail rather than a user preference.

The result is a split-brain default: the browser may preselect Codex CLI, while an agent-spawned child task still defaults to Claude Code.

## Requirements

- The user SHALL be able to choose the default agent from a convenient Settings location.
- The available choices SHALL be the currently supported agent types: Claude Code and Codex CLI.
- Manual Launch, Quick Launch, Playbook launch, Schedule creation, REST API launch, and `kookr-spawn` SHALL all resolve the same default when no explicit `agentType` is supplied.
- Explicit per-launch agent choices SHALL continue to win over the default.
- Existing task records SHALL keep their original `agentType`.
- The setting SHALL persist across browser reloads and server restarts.
- The UI SHALL avoid offering an agent type that the server does not advertise.
- Remote-chat guardrails SHALL stay stricter than the global default. If the global default is Codex CLI, Telegram launches still need the existing `KOOKR_REMOTE_CHAT_ALLOW_CODEX=1` opt-in.

## Implementation

The shipped UI adds a **Default agent** row to `Settings -> General -> Task Management`.

Behavior:

- The control uses the existing `AgentTypeSelector`.
- It persists through `/api/settings` as `defaultAgentType`.
- The server uses that value when a launch omits `agentType`, including REST and `kookr-spawn` child-task launches.

## Design

### Source of truth

Add `defaultAgentType: AgentType` to `KookrSettings` in `src/core/settings-store.ts`.

Default value:

```ts
defaultAgentType: DEFAULT_AGENT_TYPE // "claude-code"
```

Validation accepts only `claude-code` and `codex-cli`. Invalid or missing values fall back to `DEFAULT_AGENT_TYPE`, matching the existing settings-store pattern.

### Server launch resolution

Add a live default-agent getter to `LaunchServiceDeps`:

```ts
getDefaultAgentType?: () => AgentType;
```

Then resolve launch agent type in this order:

1. `opts.agentType`
2. `deps.getDefaultAgentType?.()`
3. `adapterRegistry.getDefaultType()`
4. `DEFAULT_AGENT_TYPE`

This keeps explicit launch requests stable while making omitted-agent launches honor Settings.

`POST /api/tasks` already passes `undefined` when the body omits `agentType`, so `kookr-spawn` can remain simple: when the user does not pass `--agent`, the CLI omits `agentType` and the server chooses the configured default.

### Settings API

`GET /api/settings` returns `defaultAgentType`.

`PUT /api/settings` validates and persists `defaultAgentType` with the rest of the settings. No separate endpoint is needed; the existing Settings dialog already edits the settings object as one document.

### Snapshot contract

The websocket snapshot already includes `defaultAgentType`, but today it comes from `adapterRegistry.getDefaultType()`. Change it to the persisted setting so frontend launch surfaces do not need to call `/api/settings` just to initialize their default.

### Frontend

Move the current browser-local default behavior toward server-backed behavior:

- Settings dialog writes `defaultAgentType` through `/api/settings`.
- Launch surfaces initialize from `useKookrStore().defaultAgentType`.
- A per-launch manual choice remains local component state.
- Do not keep writing every per-launch choice into `kookr:defaultAgentType`; changing the global default should be an intentional Settings action.

Migration:

- Existing `kookr:defaultAgentType` browser preferences are no longer used as the source of truth.
- Old settings files that lack `defaultAgentType` validate to `claude-code`.
- Per-launch selectors keep working as explicit overrides without mutating the global default.

## Files To Change

- `docs/rfc/rfc-default-agent-selection.md`
- `src/core/settings-store.ts`
- `src/core/settings-store.test.ts`
- `src/server/index.ts`
- `src/server/settings-api.test.ts`
- `src/server/launch-service.ts`
- `src/server/launch-service.test.ts`
- `src/server/routes/settings-routes.ts`
- `src/server/ws.ts`
- `src/server/ws-connection-handler.ts`
- `src/frontend/components/SettingsDialog.tsx`
- `src/frontend/components/SettingsDialog.test.ts`
- `src/frontend/components/LaunchTaskDialog.tsx`
- `src/frontend/components/QuickLaunch.tsx`
- `src/frontend/components/PlaybookBrowser.tsx`
- `src/frontend/components/SchedulesDialog.tsx`

## Edge Cases

- If the configured default agent binary is missing, launch should fail through the existing preflight path with a clear message. The Settings control should still only list server-advertised agent types; binary health is a separate diagnostic.
- If an older settings file lacks `defaultAgentType`, validation fills `claude-code`.
- If a future adapter is added, the setting validation and UI options should come from the shared `AgentType`/`AVAILABLE_AGENT_TYPES` contract, not a duplicated string list.
- If remote chat omits `agentType` and the default is Codex CLI, the existing remote-chat launch-source guard must still block unless `KOOKR_REMOTE_CHAT_ALLOW_CODEX=1`.
- Existing scheduled tasks should keep the agent type captured at schedule creation. Changing the global default should only affect newly created schedules.

## Alternatives Considered

### Keep `localStorage` as the default

Rejected. It is easy to implement but cannot affect agent-spawned child tasks, CLI launches, or API clients.

### Add a default-agent selector only to the Launch dialog

Rejected. The Launch dialog already has a per-task selector. The missing affordance is a global preference that applies when no launch surface is visible.

### Add `KOOKR_DEFAULT_AGENT_TYPE` only

Rejected as the primary mechanism. An environment override may be useful later for deployments, but the user asked for a convenient UI control and Kookr already has a persisted settings file.

## Critic Feedback Incorporated

- Boundary review: the default belongs in server settings, not only frontend state, because the most important caller is `kookr-spawn` / child-task creation.
- Design-minimalist review: no new endpoint is needed; reuse `/api/settings` and the existing `AgentTypeSelector`.
- Failure-mode review: remote-chat Codex guardrails must remain explicit even when the global default is Codex CLI.

---

## Extension: Round-Robin Default Agent

### Status

**Accepted** (2026-05-16) — extends the accepted RFC above.

### Problem

Users on both a Claude plan and a Codex plan want to spread launches across
both rather than pinning every task to one agent. The original design only
allows a single concrete default.

### Requirements

- The Default agent control SHALL offer a third option, **Round robin**,
  alongside Claude Code and Codex CLI.
- Round robin SHALL be selectable both as the Settings default and as a
  per-launch choice in every launch surface (Quick Launch, Manual Launch,
  Playbook launch, Schedule creation).
- A launch that resolves to round robin SHALL alternate between Claude Code
  and Codex CLI; a persisted task or session SHALL always record a concrete
  agent type.
- The rotation SHALL survive a server restart.
- Round robin SHALL be offered only when at least two agents are available;
  with one agent it degrades to that agent.

### Design

**Selection vs. agent type.** `AgentType` stays the concrete pair
(`claude-code | codex-cli`). A new `AgentSelection = AgentType | 'round-robin'`
type carries the *selectable* value — settings default, launch request, and
schedule definition. The `round-robin` sentinel never reaches a task record:
`launchTask` resolves it to a concrete `AgentType` before dedup and task
creation.

**Resolution.** `resolveRoundRobinAgent(cursor, availableTypes)` filters the
canonical order `['claude-code', 'codex-cli']` to registered adapters and
indexes it by the rotation cursor. `launchTask` resolves
`opts.agentType ?? getDefaultAgentType()`; if that is `round-robin`, it calls
`advanceRoundRobinCursor()` (returns the index for this launch, then advances).

**Cursor persistence.** `KookrSettings.roundRobinIndex` holds the next
rotation index. Each round-robin launch advances it in memory synchronously
(so concurrent launches get distinct indices) and persists it fire-and-forget.
The `/api/settings` update path preserves this server-managed cursor so an
operator settings save never rolls the rotation back. `saveSettings` writes
through a unique temp filename so a per-launch cursor write cannot corrupt a
concurrent settings-PUT write.

**Wire contract.** The `launch` / `relaunch` / `launchPlaybook` client
messages and the snapshot `defaultAgentType` widen to `AgentSelection`. The
adapter-driven `availableAgentTypes` list stays concrete; the frontend appends
the Round robin option client-side via `buildAgentSelectionOptions` when two
or more agents are available.

### Edge Cases

- A round-robin schedule resolves a fresh concrete agent on each run, so a
  recurring schedule also alternates.
- Ralph loops resolve round robin once at loop start; the loop task records a
  concrete agent and subsequent iterations stay on it.
- Remote-chat Codex guardrails are unchanged: the R19 check runs on the
  resolved concrete agent, so a round-robin launch landing on Codex via
  Telegram still requires `KOOKR_REMOTE_CHAT_ALLOW_CODEX=1`.
