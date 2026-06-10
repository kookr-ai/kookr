# User Guide

Kookr is a supervision surface for many AI coding agents. The main workflow is: launch or discover work, watch findings, respond to the highest-priority agent, then move on.

## Dashboard Concepts

**Findings** are the main queue. A finding means Kookr believes a human response may unblock an agent or prevent wasted work.

**Tasks** are the unit of work. A task has a prompt, working directory, agent session, lifecycle state, and optional completion criteria.

**Terminal panel** is the live attach surface for the selected agent's managed dtach session. It replays recent output and streams live bytes.

**Healthy agents** are still visible, but they are not the focus. Kookr keeps them out of the urgent queue until something changes.

## Launching Agents

Use the dashboard **Launch** button for an interactive start:

1. Pick the project directory.
2. Choose the agent provider when available.
3. Enter the task prompt.
4. Add optional completion criteria.
5. Launch.

Kookr starts the agent in a persistent dtach session. If the server restarts, the dtach master keeps the child process alive and Kookr reconciles state on startup.

For Ralph loops that look stopped after a crash or show a **Replace with new** recovery dialog, see [Ralph Loop Stopped Or Shows "Replace With New"](troubleshooting.md#ralph-loop-stopped-or-shows-replace-with-new).

## Responding To Findings

When a finding appears:

1. Read the finding explanation.
2. Inspect the terminal context if needed.
3. Send a reply or hint.
4. Kookr advances to the next queued finding.

Quick actions and AI suggestions may appear when Kookr can infer likely responses. AI suggestions require an LLM provider key — see [Configuration](configuration.md#ai-suggestions).

## Dense Supervision Workflow

When several agents are running, the useful screen area is usually split between the project rail, the findings list, project context, activity, dependency controls, GitHub state, and the terminal. Use this workflow when the terminal needs to stay readable while you still route attention quickly:

1. Press `Alt+N` to jump to the next highest-severity finding.
2. Inspect the explanation and recent activity first. If you need raw context, switch to the terminal.
3. Press `Alt+T` on desktop to enter terminal focus mode. This keeps the selected task visible while hiding secondary project and dependency chrome.
4. Press `Alt+R` to focus the reply input, type the answer, then press `Enter` to send the reply and continue.
5. Press `Alt+T` again when you need project context, dependency controls, Activity, or GitHub details back.

Terminal focus mode is a desktop-only space-saving mode. On mobile, use the **Findings** and **Task** tabs instead; the task tab keeps the selected task and terminal surfaces in the foreground without adding a separate focus toggle.

### Reclaiming Workspace

Use these controls together before resizing the browser or abandoning the dashboard:

- `Alt+P` toggles the project sidebar.
- `Alt+T` toggles terminal focus mode on desktop.
- `Alt+0` returns to all projects.
- `Alt+4` through `Alt+9` select visible projects in sidebar order.
- `Alt+J` and `Alt+K` move through all tasks, including healthy tasks.
- `Alt+1` through `Alt+3` sends that digit to the terminal and moves to the next task, useful for simple agent menus.
- `?` opens the shortcuts dialog.

On narrower desktop windows, the detail panel uses **Activity**, **Terminal**, and **GitHub** tabs. Keep **Terminal** selected while reading or replying, then switch briefly to **Activity** or **GitHub** only when you need summarized context.

### Project-Scoped Triage

For dense multi-repository sessions, start broad and narrow only when the queue is noisy:

1. Use **All projects** or `Alt+0` to catch global blockers.
2. Select a busy project from the sidebar or with `Alt+4` through `Alt+9`.
3. Clear its urgent findings with `Alt+N`, `Alt+R`, and `Enter`.
4. Return to **All projects** so lower-volume projects are not hidden for the rest of the session.

Project filters are workspace controls, not task ownership changes. Agents continue running in their original working directories.

## Finding Types

Kookr prioritizes findings by urgency. Common V1 cases include:

- Permission blocks
- Repeated errors
- Idle or stopped agents that likely need input
- GitHub PR or CI events tied to an agent-created branch
- Budget or cost warnings

For the full catalog — every anomaly type, what triggers it, the recommended response, and how to suppress or tune it — see the [Findings Reference](reference/findings.md).

LLM-powered trajectory analysis is a later direction. The current system favors reliable signals before speculative interpretation.

## Multi-Project Tracking

Kookr can track several project directories. Registered projects appear in the workspace UI and are used for project-scoped configuration, playbooks, contribution summaries, and task launch defaults.

## Playbooks

Playbooks are reusable task templates. Kookr discovers them from three tiers:

- Bundled playbooks in the `kookr-toolkit` plugin
- User playbooks under `~/.kookr/playbooks/`
- Project playbooks under `<repo>/.kookr/playbooks/`

Project playbooks can define parameters and completion criteria. See [Playbook Scoping](playbook-scoping.md) for the exact discovery and precedence rules, and the [Playbooks Reference](reference/playbooks.md) for the authoring schema.

## Schedules

Scheduled tasks use cron-style triggers for recurring work such as nightly scans, periodic supervision, and housekeeping. The schedules UI can preview next-run timestamps before you save.

## GitHub Awareness

When an agent references GitHub PRs or issues, Kookr associates those references with the task. It can then poll PR state, CI status, review decisions, and unresolved review threads, routing actionable changes back into the findings queue.

## Voice And Remote Chat

Speech and Telegram integrations are optional. They are disabled unless configured in `.env`.

- Speech-to-text and text-to-speech can run as bundled Docker Compose stacks or point at external services.
- Telegram remote chat requires a bot token plus explicit user and project allowlists.

See [Configuration](configuration.md) for setup notes.

## Privacy

Kookr runs locally and collects no telemetry. State lives in `~/.kookr/` for port `4800` or `~/.kookr-<port>/` for other ports.

Networked integrations are opt-in and named explicitly in configuration.
