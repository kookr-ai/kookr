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

## Responding To Findings

When a finding appears:

1. Read the finding explanation.
2. Inspect the terminal context if needed.
3. Send a reply or hint.
4. Kookr advances to the next queued finding.

Quick actions and AI suggestions may appear when Kookr can infer likely responses. AI suggestions require an LLM provider key — see [Configuration](configuration.md#ai-suggestions).

## Finding Types

Kookr prioritizes findings by urgency. Common V1 cases include:

- Permission blocks
- Repeated errors
- Idle or stopped agents that likely need input
- GitHub PR or CI events tied to an agent-created branch
- Budget or cost warnings

LLM-powered trajectory analysis is a later direction. The current system favors reliable signals before speculative interpretation.

## Multi-Project Tracking

Kookr can track several project directories. Registered projects appear in the workspace UI and are used for project-scoped configuration, playbooks, contribution summaries, and task launch defaults.

## Playbooks

Playbooks are reusable task templates. Kookr discovers them from three tiers:

- Bundled playbooks in the `kookr-toolkit` plugin
- User playbooks under `~/.kookr/playbooks/`
- Project playbooks under `<repo>/.kookr/playbooks/`

Project playbooks can define parameters and completion criteria. See [Playbook Scoping](playbook-scoping.md) for the exact discovery and precedence rules.

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
