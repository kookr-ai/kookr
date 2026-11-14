# Evidence pack: RFC playbook chains

Gathered 2026-11-14 before the critic panel. Every item is a claim to check, with
source pointers.

## Pipeline map (relevant modules)

- **Playbook launch, UI path:** WS `launchPlaybook` →
  `src/server/ws-handlers/playbook-handler.ts` →
  `preparePlaybookLaunchWithMetadata` (`src/server/use-cases/playbook-launch.ts:75`) →
  `launchTask` (`src/server/launch-service.ts`). Inputs: `playbookSourceCwd`,
  `taskTargetCwd`, `projectId`, `playbookPath`, `parameterValues`, `agentType`,
  `effort`, `model`, `scope`, `parentTaskId`.
- **Playbook launch, HTTP:** `POST /api/tasks` only supports *prompt-wrapper*
  playbooks (playbooks declaring a required `prompt` param,
  `src/server/routes/task-routes.ts:870-905`). Parameterised playbooks without a
  `prompt` param (like `agentic-capability-research.md`) cannot be launched by
  `kookr spawn --playbook` (notebook lesson 5b1bae).
- **Persisted on each task:** `playbookId`, `playbookSource {id, scope, sourceCwd,
  sourceDigest}`, `playbookParameterValues`, `parentTaskId`, `launchIntent
  {agentType, modelTier, effort, model, ...}` (`src/core/task-read-model.ts:141-160`,
  `src/shared/contracts/agent-state.ts:80-82`, `src/shared/contracts/task.ts:165-190`).
- **Single terminal chokepoint:** `TaskStore.transition()` (`src/core/tasks.ts:923`)
  — every move to completed/terminated/cancelled goes through it and stamps a
  `terminalReceipt`. Callers that complete tasks are spread across
  `task-lifecycle-commands.ts`, `lifecycle-timers.ts:2283/2296`,
  `lifecycle-handler.ts:430`, `agent-lifecycle.ts:662`.
- **Completion detection already in Kookr:** `evaluateCompletionSignal`
  (`src/core/completion-signal.ts`) auto-raises `completion-ready` for a
  `pre-authorized` task when a turn completes cleanly (background tasks/crons
  keep the turn `running`, so a lead waiting on background workers is NOT
  treated as done). `autoCloseOnSignal === true` closes such a task
  immediately (`src/core/completion/completion-ready-cleanup.ts:46-57`), sweep
  batches ≤2 per 60 s (`src/server/completion-ready-sweep.ts`).
- **Merge-required gate** (`src/core/merge-required.ts`) is opt-in only
  (mergeAfterImplementation / mergeRequired / contract header); un-opted tasks
  are unaffected.
- **Ralph loop** (`src/server/ralph-loop-service.ts`, 1528 lines, +
  `src/core/ralph-cycler.ts`): re-runs a prompt as fresh *sessions inside one
  task*. Iteration boundary = any Stop hook from the owner session
  (`src/server/ralph/stop-event-ownership.ts` — no turn-state / background-work
  check). Only for playbooks tagged `loopable` with `loop:` frontmatter
  (`looped-playbook-launch.ts:444`).
- **Schedules** (`src/core/schedule.ts:574`, `src/server/schedule-service.ts`,
  `schedule-runner.ts`): cron-triggered, have `maxTriggers`/`remainingTriggers`/
  `stopReason`, overlap-skip ("previous run still active"), launch with
  `launchSource: 'schedule'`, `disableDedup: true`, `automationProjectId` stamp.
- **Umbrella chain advancer** (`src/server/use-cases/umbrella-chain-advancer.ts`):
  60 s interval service, GitHub-umbrella/phase-ledger specific, started from
  `src/server/bootstrap/start-background-services.ts`. Pattern reference only.
- **Autonomous launch gate:** `isAutonomousLaunchSource`
  (`src/core/automation-kill-switch.ts:43`) — `schedule`, `idle-refinery`,
  `post-recovery`, `resource-watchdog`, `supervision`. Autonomous sources are
  refused in SAFE MODE and per-project automation pause and require a trusted
  `automationProjectId` stamp (`launch-service.ts:1405`).
- **Agent-side self-continuation today:** `plugin/skills/self-continuation-task/SKILL.md`
  — the agent must remember to spawn a successor at the end of its run.
- **UI indicator precedent:** `src/frontend/components/FindingsPanel/RalphLoopBadge.tsx`
  (`3/10` pill) rendered in FindingCard, HealthyRow, CompletedRow, RalphLoopControls.

## Telemetry: how real `agentic-capability-research.md` tasks ended

From `~/.kookr/tasks.json` (2026-11-13 20:54 → 2026-11-14 08:33), 56 tasks:

| Terminal outcome | Count |
|---|---|
| completed, `completionPath=api_complete` (agent POSTed `/complete` itself) | 45 |
| completed, `ui_complete` (operator clicked) | 6 |
| completed, `completed_recovery` (restart recovery) | 3 |
| terminated, `restart_recovery` | 1 |
| still inProgress | 1 |

All `deliveryAuthorization=pre-authorized`, `autoCloseOnSignal` unset, no
`parentTaskId` (launched from the UI via websocket, in bursts of 4).
Takeaways: (a) **corrected after the consensus attack:** `api_complete` means
"`POST /complete` without a prior signal" from *any* caller, not "the agent
closed itself". Those tasks carry receipt `source: user` and closed in
sub-second batches every 30–60 minutes, so an external closer (operator or an
orchestrating session) ended them; in surviving transcripts 2 of 8 leads never
signalled. Do not assume agents reliably close their own tasks. (b) A server
restart is the main source of non-`completed` terminal states. (c) The merge
gate never blocked these runs.

## KB lessons (agent-task-lessons)

- Successor spawns must pass the agent type explicitly; verify the child is
  actually running — a stillborn child (`terminated` right after spawn) is a
  launch failure, not success.
- An idempotency key mapped to a stillborn task replays the dead task instead of
  launching a new one.
