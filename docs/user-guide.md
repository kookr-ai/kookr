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
3. Optionally pin reasoning effort and model. Leave them on "Agent default"
   to keep the server / CLI default. Codex hides Model; Grok Build hides both.
   After a successful launch, the next open restores those pins when the
   current agent still accepts them.
4. Enter the task prompt, or click a sample on the Manual tab to fill one
   (working directory and Launch stay yours).
5. Add optional completion criteria.
6. Launch.

Kookr starts the agent in a persistent dtach session. If the server restarts, the dtach master keeps the child process alive and Kookr reconciles state on startup.

Claude Code, Codex CLI, and Grok Build all appear as Launch providers when their CLI is installed and ready. Grok is the one that needs an extra install and login step.

### Pinning Model And Effort

The Launch dialog's effort and model controls (step 3 above) set these per task from the dashboard. The last pins you launched with are remembered locally and shown in those menus the next time you open Launch or Quick Launch. From the terminal, `kookr spawn --effort <level>` and `--model <id>` pin them for a single launch, overriding the server / CLI default for that one task. Support varies by agent: `claude-code` accepts a Claude model id and effort levels `low` through `max`; `codex-cli` and `grok-build` reject `--model` (set `KOOKR_CODEX_MODEL` / `KOOKR_GROK_MODEL` instead) and have their own effort rules. See the [CLI reference](reference/cli.md#kookr-spawn) flag table for the exact per-agent values.

To set a lasting default instead of pinning each launch, use **Settings → Task Management**, where each agent type has a reasoning-effort default that new tasks start at. A per-task `--effort` always wins over that default.

### Grok Build

Grok Build is xAI's coding agent. Kookr can launch it the same way it launches Claude Code and Codex CLI. Install the official `grok` CLI (`npm install -g @xai-official/grok`) so it appears in Launch, then sign in once on the machine that runs Kookr:

```bash
grok login --device-code
```

Prefer `--device-code` on the Kookr host; `grok login --oauth` also works on a machine with a browser. If `grok` is not on PATH, point `KOOKR_GROK_BIN` at the binary. Kookr omits Grok from Launch when the binary is missing, and refuses a launch when credentials are missing or expired.

For Ralph loops that look stopped after a crash or show a **Replace with new** recovery dialog, see [Ralph Loop Stopped Or Shows "Replace With New"](troubleshooting.md#ralph-loop-stopped-or-shows-replace-with-new).

### Protecting A Worktree From Automatic Cleanup

When a task completes, Kookr normally removes its managed git worktree. The **Settings → Task Management → Clean worktrees on completion** toggle controls the default cleanup choice. The **Complete task** dialog shows that choice for each task, so you can uncheck it to keep a worktree for one completion or check it when the saved default is disabled.

Before you confirm, the dialog names the worktree and reports whether it can actually be removed, using the same inspection the cleanup itself runs — so a checked box means it really will go, and a disabled one means it really won't. A dirty worktree, a branch with unique commits, a worktree shared with another active task, a protected worktree, or one still driven by a running Ralph loop is reported as kept, and the checkbox is disabled with the reason. A patch-equivalent branch, including one whose commits were squash-merged with new SHAs, can be removed even when its raw commits are still ahead of the cleanup baseline. Expand **why?** for the evidence (changed-file counts, commits ahead of the cleanup baseline, and the full path). Because the verdict is a snapshot, use the re-check control (**↻**) after committing or merging elsewhere to refresh it without closing the dialog; it is hidden for reasons that can never change, such as the repository's primary checkout.

Cleanup has unconditional backstops: it refuses the repository's primary checkout, any path that is not a currently registered linked worktree, and automatic removal of worktrees on `main`, `master`, `develop`, or `dev`. Every Git worktree removal is revalidated against Git immediately before Kookr runs `git worktree remove`; if repository context or current identity cannot be established, Kookr leaves the path in place for manual recovery. The workspace cleanup dialog shows a second confirmation checkbox before it will remove a protected-branch worktree. The default protected-branch list can be replaced for a server process with `KOOKR_PROTECTED_BRANCHES=branch-a,branch-b`.

The cleanup choice removes the managed worktree and its task branch when Git reports the worktree is safe to remove. Dirty or unique-commit worktrees remain available for manual recovery; patch-equivalent worktrees are safe to remove even when their original commit SHAs are not reachable from the cleanup baseline. To keep a long-lived worktree regardless of the cleanup choice, create a `.kookr-protected` file at the worktree root before the task completes:

```text
production runtime
parentRepo: /path/to/project
```

For managed task worktree cleanup, the file's presence makes Kookr skip removal with reason `protected`. The first non-empty line is an optional human-readable reason. The optional `parentRepo:` field identifies the parent repository when Kookr needs to resolve it; replace the example path with the real absolute path. A production checkout such as `kookr-prod` should use this marker when it must remain long-lived.

This marker does not preserve Kookr's ephemeral reflection worktrees. Those carry a separate `.kookr-reflect.json` identity marker, live directly under Kookr's reflection-worktree root, and are intentionally force-removed through Git when their reflection task ends. Legacy plain reflection directories without that marker are removable during the startup or scheduled lifecycle-timer sweep when their UUID basename and direct-child root checks pass; Git-looking directories are left untouched.

Remove `.kookr-protected` only when the worktree may be cleaned up normally again. The filename must be exact and the file must be at the worktree root.

## Responding To Findings

When a finding appears:

1. Read the finding explanation.
2. Inspect the terminal context if needed.
3. Send a reply or hint.
4. Kookr advances to the next queued finding.

Quick actions and AI suggestions may appear when Kookr can infer likely responses. AI suggestions require an LLM provider key — see [Configuration](configuration.md#ai-suggestions).

When you reply with the same text often, save it as a **reply snippet** so you do not retype it. Create and edit snippets under **Settings → Reply Snippets**: each snippet has a short label and its reusable text, and Kookr keeps up to 20 of them. Once at least one snippet exists, the reply box shows a chip for each snippet (up to eight). If you have more than eight, an **Insert snippet…** dropdown lists the rest. Choosing a chip or dropdown entry inserts the snippet text at the cursor. Selecting a snippet never sends it automatically — you still send the reply yourself — so you can edit a snippet or combine it with free-text first.

When grouped findings contain identical pending prompts, Kookr may show **Reply to matching** for that subset. For policy-covered low-risk prompts, it may show **Approve matching**, which sends the shown approval only to the matching agents. Merge, scope, destructive, permission, credential, and secret-related prompts remain manual.

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
- `Alt+4` through `Alt+9` select projects in unfiltered sidebar order.
- `Alt+J` and `Alt+K` move through all tasks, including healthy tasks.
- `Alt+1` through `Alt+3` sends that digit to the terminal and moves to the next task, useful for simple agent menus.
- `?` opens the shortcuts dialog.

On narrower desktop windows, the detail panel uses **Activity**, **Terminal**, and **GitHub** tabs. Keep **Terminal** selected while reading or replying, then switch briefly to **Activity** or **GitHub** only when you need summarized context.

### Command Palette

When you would rather jump straight to a command or a specific record than hunt for it on screen, open the command palette with `Ctrl+K` (Windows/Linux) or `Cmd+K` (macOS). Clicking the top-bar **Search actions & tasks** field opens the same palette.

The palette has two modes:

- **Browse.** With the query empty, it lists every action that Kookr can run — the same commands that live behind the top-bar controls — grouped into labelled sections so you can discover what is available without knowing its name.
- **Search.** As you type, it filters and ranks results across four kinds at once: **actions**, **tasks**, active **findings**, and **projects**. Actions show their keyboard shortcut and any status badge; tasks, findings, and projects show summarizing context such as lifecycle state, severity, or active-agent counts.

Use `↑` and `↓` to move through results, `↵` to run the highlighted action or open the highlighted task, finding, or project, and `Esc` to close the palette. The palette is a fast entry point, not a replacement for the shortcuts dialog — `?` still opens the full list of keyboard shortcuts.

### Project-Scoped Triage

For dense multi-repository sessions, start broad and narrow only when the queue is noisy:

1. Use **All projects** or `Alt+0` to catch global blockers.
2. When the project rail is long, type in the compact filter under **All projects** to narrow rows by display name or local path. **All projects** stays visible; `Alt+4` through `Alt+9` still follow the unfiltered sidebar order.
3. Select a busy project from the sidebar or with `Alt+4` through `Alt+9`.
4. Clear its urgent findings with `Alt+N`, `Alt+R`, and `Enter`.
5. Return to **All projects** so lower-volume projects are not hidden for the rest of the session.

Project filters are workspace controls, not task ownership changes. Agents continue running in their original working directories.

## Do Not Disturb And Quiet Hours

When you need to step away, use **Do Not Disturb (DND)** to silence alerts without stopping supervision. While DND is on, Kookr mutes toasts, desktop notifications, and the audible chime, but anomaly detection keeps running and findings still accumulate in the dashboard. Nothing is lost — only the interruptions are muted.

### The DND Pill

The top-bar **DND** pill is the manual control:

- Click the pill to turn Do Not Disturb on until you turn it off again. Click it again to turn it off.
- Use the caret (`▾`) next to the pill to silence alerts for a fixed duration instead — **15 minutes**, **30 minutes**, **1 hour**, **2 hours**, or **Until I turn it off** (the same indefinite state as clicking the pill directly). When a duration is set, the pill tracks the time remaining and re-enables alerts automatically when it elapses.
- When you enable DND manually, findings that arrive while it is on are counted on the pill, so you can see how many new findings are waiting the moment you return.

The manual toggle is per-browser and persists across reloads, and it stays in sync across open tabs so enabling DND in one tab silences the others too.

### Quiet Hours

Quiet hours put DND on a recurring schedule. Open **Settings → Notifications & Alerts → Quiet hours** and add one or more time-of-day windows:

- Each window has a **From** and **To** time and a set of weekdays it applies to.
- Times are local wall-clock time (`HH:MM`, 24-hour), so windows follow your clock — including daylight-saving changes — rather than a fixed UTC offset.
- A **To** time earlier than the **From** time wraps past midnight (for example, `22:00`→`08:00` covers overnight), with the weekday selection referring to the day the window starts.

While a quiet-hours window is active, the DND pill shows an **Auto** badge to indicate that the schedule — not a manual toggle — is silencing alerts. Clicking the pill during a quiet-hours window pins DND on manually so it stays on after the window ends; edit or remove the windows from Settings at any time.

## Finding Types

Kookr prioritizes findings by urgency. Common V1 cases include:

- Permission blocks
- Repeated errors
- Idle or stopped agents that likely need input
- GitHub PR or CI events tied to an agent-created branch
- Budget or cost warnings

For the full catalog — every anomaly type, what triggers it, the recommended response, and how to suppress or tune it — see the [Findings Reference](reference/findings.md).

LLM-powered trajectory analysis is a later direction. The current system favors reliable signals before speculative interpretation.

## Task Coordinator

The task coordinator is a lightweight layer for supervising relationships between tasks. It is separate from the main findings queue: findings answer "which agent needs attention now?", while the coordinator answers "which tasks are related, duplicated, stale, or ready to clear?" Coordinator state is derived from live task records, hook activity, and declared task relationships.

### Coordinator Chips

Coordinator chips appear on task rows when Kookr has a recommendation for that task. The chip text is the action; the icon and number summarize the evidence.

| Chip action | When it appears | What it does |
| --- | --- | --- |
| `Nudge` with a clock | An in-progress task has no recent `PostToolUse` activity and no newer active session start for about 30 minutes. | Sends "Please provide a concise status update and the next concrete step." to that agent. |
| `Compare` with a match icon | Another active task has the same effective prompt, canonical working directory, and agent type. | Opens a peer task so you can compare or close the duplicate. |
| `Acknowledge` with a check | A completed task has a completion digest and no follow-up signal or active anomaly. | Hides that task-level recommendation for 30 days. |
| `Nudge` or `Snooze` with a chain icon | The task has declared `blocks` or `blocked_by` edges, or an edge points at a missing task. | `Nudge` is used for downstream-only edges. `Snooze` is used when the selected task is blocked by upstream work. |

The small dismiss button on a chip suppresses that detector class for that agent type, not just the selected task. The first two dismissals last 7 days; the third and later dismissals last 30 days. Suppressions persist in the Kookr data directory as `coordinator-suppressions.json`, and widened suppressions are also recorded in `coordinator-feedback.jsonl`.

### Chain Strips

When a selected task has related tasks, Kookr shows a chain strip with compact members such as `parent`, `child`, `blocks`, and `blocked by`. Parent and child entries come from task launch linkage. `blocks` and `blocked by` entries come from manually declared task edges.

The strip's `Mark prior N done` action applies only to prior tasks: parent tasks and tasks listed as `blocked_by`. Before changing anything, Kookr refreshes GitHub state for those prior tasks and verifies that the chain has not changed. It only marks prior tasks done when each prior task is already terminal, has a freshly verified merged PR, has passing or neutral post-merge checks, and has no dirty worktree health.

### Declaring And Removing Edges

Use the **Relationships** control in the task detail panel to declare task dependencies:

1. Open the relationships control.
2. Choose **Add blocker** when the selected task is waiting on another task, or **Add downstream** when the selected task blocks another task.
3. Search for a non-terminal task by name or ID, or type a milestone name.
4. Select the task result or use **Add milestone**.

Task edges are stored as `task:<task-id>`. Milestone edges are stored as `milestone:<name>`. Removing an edge from the relationships menu updates the task immediately. Task edges can appear in chain strips and coordinator chips; milestone edges stay visible in the relationships control but do not appear in chain strips because they have no task status to display.

### Duplicate Launch Interrupts

`kookr spawn` checks for active duplicate prompts before launching. A duplicate means the same effective prompt, working directory, and agent type already has an active task.

- `--dedupe=warn` is the default. In an interactive terminal it warns, lets you view a prompt diff, and asks whether to continue. In non-interactive mode and JSON mode it blocks with exit code `5`.
- `--dedupe=block` always blocks a duplicate active prompt with exit code `5`.
- `--dedupe=skip` bypasses the interrupt and marks the new task as an intentional duplicate so the coordinator does not group it as accidental duplication.

The Launch dialog and Quick Launch bar show the same warning before submit. You can open the existing task or launch anyway; launch-anyway marks the new task as an intentional duplicate so the coordinator does not group it as accidental. CLI defaults are unchanged.

The dashboard duplicate chip is the follow-up surface for active duplicates that already exist. The CLI interrupt and the launch-form warning prevent many duplicates before they start.

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

## Sharing A View

Kookr stays local-first, but you can hand a collaborator a view of your work — either a read-only viewer link or, with the hosted relay, a streamed session. Two paths exist:

- **Read-only viewer links (preview).** Use **Share read-only view** (from the command palette, `Ctrl+K` / `Cmd+K`) to mint, list, and revoke scoped, optionally expiring links to the whole dashboard or a single project. This build ships the owner side — link management plus every server-side guard — but **live viewer admission is still a preview**: a collaborator who opens a link reaches the app in a browser (no install) yet is not admitted to live data until that wiring lands. Set links up now and they start carrying data the moment admission is enabled. See [Read-Only Shared View Setup](reference/shared-view-setup.md) for the current status and setup.
- **Hosted relay.** Pair your instance with the hosted relay under **Settings → Sharing**, then use a task's **Share** control to stream selected terminal sessions to a remote collaborator. Remote input is permissioned separately from viewing and **fails closed**: when the remote-input grant is missing or relay connectivity drops, the shared session stays view-only.

Terminal sharing requires `KOOKR_RELAY_TRUSTED=true` in the running Kookr process, and public browser access requires HTTPS/WSS. See [Session Sharing](reference/session-sharing.md) for owner and collaborator setup, and [Hosted Relay Operations](reference/hosted-relay-operations.md) for the hosted relay.

## Privacy

Kookr runs locally and collects no telemetry. State lives in `~/.kookr/` for port `4800` or `~/.kookr-<port>/` for other ports.

Networked integrations are opt-in and named explicitly in configuration.
