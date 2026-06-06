# API Reference

Kookr exposes local HTTP and WebSocket endpoints from the Hono server. In development the backend defaults to port `4801`; production-style runs default to `4800`.

## Health And Build

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Server status, agent count, and build info |
| `GET /api/health/stt` | Bundled speech-to-text container health |
| `GET /api/startup-summary` | Crash-recovery startup summary fetched once on UI mount |

## Tasks And Agents

| Endpoint | Description |
| --- | --- |
| `GET /api/tasks` | All tasks with sessions |
| `POST /api/tasks` | Create and launch a new task |
| `POST /api/tasks/:id/complete` | Mark a finished task `completed` (non-destructive) and tear down its idle session |
| `DELETE /api/tasks/:id` | Stop and remove a task |
| `POST /api/agents/:id/message` | Send a message or hint to a running agent |
| `GET /api/agents/:agentId/edit-events/:toolUseId` | Fetch a recorded Edit/Write tool event for diff display |
| `GET /api/sessions/:sessionId/effective-hook-settings` | Resolved per-session hook settings |

### `POST /api/tasks` body fields

`prompt` (required) and `cwd` (required) plus optional `criteria`, `parentTaskId`,
`agentType`, `effort`, `disableDedup`, `metadata`, and `dependencies`.

`effort` (optional, string) sets the reasoning-effort level for *this one task*,
overriding the per-agent-type default (see [Reasoning effort](#reasoning-effort)).
It is validated against the **resolved** agent's allowed set — `round-robin`
resolves to a concrete agent first — and an invalid level returns
`400 {"error", "code": "invalid_effort"}`. Allowed levels:

- `claude-code`: `low`, `medium`, `high`, `xhigh`, `max`
- `codex-cli`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`

Omitting `effort` falls back to the per-agent-type setting, then to the agent
CLI's own default (no effort flag passed — unchanged from before this field
existed). The `kookr-spawn --effort <level>` flag maps to this field.

### `POST /api/tasks/:id/complete`

Non-destructive way to mark a finished task terminal, distinct from
`DELETE` (which removes the task) and from cancel/kill (which carries
abort semantics). Transitions an `inProgress` task to `completed` and
tears down its idle agent session through the same lifecycle handler the
dashboard's complete action uses, so projections, the schedule service,
and the coordinator all observe the terminal state. History is preserved.

This is the safe path for an operator — or an orchestrating agent cleaning
up its own finished helper tasks — to clear a task that has delivered its
work but whose session is still alive (issue #691). A task completed this
way carries no completion digest, so it never surfaces as an actionable
`done_not_cleared` finding, yet it is terminal and leaves the default
actionable list like any other completed task.

Success returns `200 {"ok": true, "task": {...}}` with the task now
`completed`.

- `inProgress` → `completed`, and a `terminated` task (dead sessions
  awaiting acknowledgement) is also acked to `completed`.
- Idempotent: an already-`completed` or deliberately `cancelled` task
  returns `200 {"ok": true, "alreadyTerminal": true}`; a concurrent
  double-complete resolves to the same no-op rather than an error.
- Unknown id returns `404`.
- A task that never started (`open`/`pending`) returns
  `409 {"code": "not_in_progress"}` — delete or cancel it instead.
- A task with an active Ralph loop returns
  `409 {"code": "ralph_loop_active"}` — cancel it to stop the loop.
- Remote-owned `shared:` ids return `403`.

Worktree-lease release and pending-task promotion run on the periodic
reconcile/liveness pass rather than inline (the lease service and adapter
registry are not wired into the route layer — same as `DELETE`); the
dashboard's WebSocket complete action does both inline.

## Supervisor Surface

| Endpoint | Description |
| --- | --- |
| `GET /api/snapshot` | Current agent states and anomalies |
| `GET /api/queue` | Attention queue contents |
| `GET /api/anomaly-stats` | Anomaly counters and detector stats |
| `GET /api/capture/:sessionId` | Snapshot of the dtach session ring buffer |
| `POST /api/hook-event/:sessionId` | HTTP push surface for hook events, used by Codex CLI hooks |

## Projects

| Endpoint | Description |
| --- | --- |
| `GET /api/projects` | Tracked project directories |
| `POST /api/projects/track` | Register a project directory |
| `POST /api/projects/untrack` | Remove a tracked project |
| `GET /api/projects/contributions` | Contributions summary across projects |
| `GET /api/projects/configs` | Per-project configuration |
| `POST /api/projects/configs` | Update a project's configuration |
| `GET /api/projects/discovery-status` | Background project-discovery progress |
| `POST /api/projects/rescan-skills` | Re-scan tracked repos for `.claude/skills/` |

## Playbooks And Schedules

| Endpoint | Description |
| --- | --- |
| `GET /api/playbooks?cwd=` | Discover playbooks at a CWD |
| `GET /api/schedules` | List scheduled tasks |
| `POST /api/schedules` | Create a scheduled task |
| `POST /api/schedules/preview` | Preview next-run timestamps for a candidate schedule |
| `PATCH /api/schedules/:id` | Update a schedule |
| `DELETE /api/schedules/:id` | Delete a schedule |
| `POST /api/schedules/:id/run` | Trigger a scheduled task immediately |

## Reflection And Telemetry

| Endpoint | Description |
| --- | --- |
| `GET /api/reflect` | Analyze session friction patterns |
| `GET /api/reflect/recommendation` | Top-priority reflection recommendation for the UI banner |
| `GET /api/telemetry/report` | Aggregated telemetry over the session log |
| `GET /api/shadow-report` | Shadow-detection comparison report, with `?format=text` for plain text |

## GitHub

| Endpoint | Description |
| --- | --- |
| `GET /api/github` | All tracked tasks' PR and issue state |
| `GET /api/github/status` | GitHub scanner status |
| `GET /api/github/:taskId` | PR or issue state for one task |

## Settings And Infrastructure

| Endpoint | Description |
| --- | --- |
| `GET /api/settings` | Get user and project settings |
| `PUT /api/settings` | Update settings |

### Reasoning effort

`agentEffort` is a per-agent-type map in settings (`~/.kookr/settings.json`,
editable in the dashboard's Settings → Task Management) that sets the default
reasoning-effort level spawned agents launch at:

```json
{ "agentEffort": { "claude-code": "high", "codex-cli": "medium" } }
```

When set, the adapter launches `claude-code` with `--effort <level>` and
`codex-cli` with `-c model_reasoning_effort="<level>"`. Allowed levels are
agent-specific (`claude-code`: `low|medium|high|xhigh|max`; `codex-cli`:
`none|minimal|low|medium|high|xhigh`); invalid `(agent, level)` pairs are
dropped on save with a warning. The map is **empty by default** — an unset
agent launches at the agent CLI's own default with no effort flag passed
(identical to behavior before this setting existed). A per-task `effort` on
`POST /api/tasks` (or `kookr-spawn --effort`) overrides this default for one
launch. Resolution order: per-task override → per-agent-type setting → unset.
| `GET /api/circuit-breakers` | Snapshots of wrapped-dependency breakers |
| `GET /api/diagnostic` | Latest self-diagnostic report and last error |
| `POST /api/diagnostic/run` | Trigger a self-diagnostic run |
| `GET /api/oss-attempts` | OSS contribution-attempt store snapshot |
| `POST /api/oss-attempts/refresh` | Refresh PR and issue state for tracked OSS attempts |
| `POST /api/oss-attempts/events` | Record an OSS attempt event, used by hooks |
| `GET /api/deploy/status` | Production-update job status plus user-global toolkit symlink freshness |
| `POST /api/deploy/trigger` | Trigger a `pnpm prod:update` job |
| `POST /api/deploy/toolkit-refresh` | Reinstall user-global Kookr hooks/toolkit symlinks from the production worktree |

## WebSocket

| Endpoint | Description |
| --- | --- |
| `ws://host:port/ws` | Real-time updates, snapshots, alerts, and suggestions |
| `ws://host:port/ws/terminal/:sessionId` | Interactive terminal bridge using binary frames over the dtach session |

## Data Directory

Kookr stores local state by port:

- Port `4800`: `~/.kookr/`
- Other ports: `~/.kookr-<port>/`
