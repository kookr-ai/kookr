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
| `DELETE /api/tasks/:id` | Stop and remove a task |
| `POST /api/agents/:id/message` | Send a message or hint to a running agent |
| `GET /api/agents/:agentId/edit-events/:toolUseId` | Fetch a recorded Edit/Write tool event for diff display |
| `GET /api/sessions/:sessionId/effective-hook-settings` | Resolved per-session hook settings |

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
