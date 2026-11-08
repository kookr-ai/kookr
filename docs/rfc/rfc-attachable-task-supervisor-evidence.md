# Evidence pack — Attachable Task Supervisor RFC

**Gathered:** 2026-11-08, against `origin/main` (f70cc9d9). Treat every item as a claim to check, not settled fact.

## 1. The operator's ask (verbatim intent)
Supervising running tasks with a supervisor task "is an extremely useful pattern and should be more easy
to run. Currently I have to run manual prompt instructions." Ideas floated (not decided): a button to
spawn a supervisor; attach running Kookr sessions to it; small guidance (goals / constraints / do /
don't); prefill all of it with a Sonnet agent that investigates the attached tasks and uses common
sense plus **preferences learned from previous supervisor sessions** — example: "never subscribe or pay
anything without my approval, but it is usually OK to spend up to all prepaid budget on the existing
DeepInfra plan; just don't refill the budget automatically."

## 2. How supervision is done today (observed from task store + transcripts)
- 9 Kookr supervision runs found since 09-02 plus **13 operator prompts** in `~/.claude/history.jsonl`
  asking a plain Claude session to supervise Kookr tasks — most supervision happens *outside* Kookr.
- **Targets are named vaguely**: the live supervisor 5c99a663 was told "the two existing running tasks";
  it had to guess targets via `kookr status` + `curl /api/tasks` and grep `~/.claude/projects`.
- **Wake/poll is ad hoc and fails**: 5c99a663 armed one `Monitor` (sleep-120 loop, 30-min timeout),
  ended its turn, the monitor expired and nothing re-woke it → `POSSIBLY HUNG` ~1h into a 4h mandate
  (operator was absent). 6e87d33e (20.7h, $105) used `/loop` + 72 `ScheduleWakeup`; 19 wakes were no-ops;
  ~51 wakes re-pasted a growing standing-rules block.
- **Supervisor misdiagnoses**: 6e87d33e declared a worker "stopped silently" from `updatedAt`/hook trail
  after its own script truncated the worker's last message to ~2000 chars (worker had cleanly paused).
  `provider-or-agent-stalled` / `stale_agent` false-positive during `/compact` and long builds.
- **Recurring operator instructions** (approx. counts): decide yourself / don't ask me (11);
  duration / absence window ("at least 4 hours", "until 11am, I'm sleeping") (~10); anti-laziness,
  workers must verify themselves, read session logs (~7); money rules (5); no destructive actions (2);
  delivery cadence (merge, release, next) (4); final recap (email) (3); `/compact` between slices (2);
  2–4 free-text goals each time.
- **Money rules are tiered, provider-specific, and change over time**: (a) existing prepaid/API budget
  is usable (DeepInfra $10 prepaid, "existing deepseek baseten model"); (b) an explicit one-off ceiling
  ("preauthorize $20 on baseten if confident"); (c) never buy / subscribe / top-up / refill quota
  ("DO NOT buy any quotas"). Today these exist only as prompt text.
- Shipped knowledge that encodes supervision craft: `~/.claude/agents/kookr-task-supervisor.md`
  (opus; read full last message via `kookr peek`; heartbeat != liveness; supervisor sends `/compact`;
  worker does own verification; escalate only on dead end / destructive / credential wall) and
  notebook shelf `kookr-task-supervisor` (7 voted lessons). **Not a Kookr launch option** — nothing in
  `src/` references the agent.

## 3. Code map — what already exists (Explore pass; file:line on origin/main)
- **Relation model**: `src/shared/contracts/task-relations.ts:11-30` types include **`supervises`**
  (also spawned_by, successor_of, same_chain, depends_on, blocks, related_to); sources include `manual`,
  `api`, `llm-inference`; lifecycle `active|superseded|rejected`; `confidence`, `evidence[]`.
  Table `task-sqlite-store.ts:509-522`. `POST /api/task-relations`
  (`src/server/routes/task-relations-routes.ts:40`) can link two **pre-existing** tasks.
  UI already renders `supervises` as parent→child (`dependency-rail-model.ts:56`,
  `related-tasks-model.ts:44,54`, `RelatedTasksSection.tsx`). **Nothing writes a `supervises` edge.**
- **Launch**: `LaunchTaskDialog.tsx` / `QuickLaunch.tsx` launch over WS `{type:'launch'}`;
  `POST /api/tasks` at `task-routes.ts:673`. Playbook `parameters:` render as a form
  (`PlaybookParameterForm.tsx:79-130`: select/textarea/text). Launch contract
  `src/shared/contracts/launch.ts:30-140` (playbookId, playbookParameterValues, agentType, model, effort,
  projectId, launchSource, dependencies[], `sandboxProfile?: 'reflect'`, autoCloseOnSignal, unattended).
  `deliveryAuthorization` ∈ `pre-authorized|ask-first|self-advancing` comes from server policy/playbook.
- **Supervisor↔worker channel**: `kookr peek` (`src/cli/kookr-peek.ts`) = transcript route +
  snapshot turnState/anomaly/sessionHealth; `kookr reply` → `POST /api/agents/:agentId/message`;
  `kookr logs` reads hook JSONL from disk. **No subscribe/push for a task** — a supervising task can only
  poll. Waiting detection: `src/core/turn-state.ts:34-100` (AskUserQuestion → waiting_for_input,
  PermissionRequest → blocked); `event-pipeline.ts:657-678` records `session.lastTurnState` transitions
  — the natural hook point for a "target became waiting / finished / stalled" wake. Telegram already
  routes operator replies/permission approvals to a task (`src/integrations/telegram/index.ts:98-104,285`).
- **LLM calls**: `src/adapters/llm/factory.ts` multi-provider client; used today only for completion
  criteria verdicts and task naming. **No prompt-prefill feature exists.**
- **Preferences**: no per-operator preference store. `supervisor-feedback-cases.jsonl` is about detector
  false positives (unrelated). Agent Notebook (`nb`) is the existing bounded, voted, per-role lesson store.
- **Spend**: lifetime spend tracking (`getLifetimeSpendUsd`), Ralph `costCapUsd`, provider quota/pause.
  **No billing/subscription/provider-budget model; "never pay" is prompt text everywhere.**
- **Related shipped/drafted work**: `plugin/playbooks/goal-supervisor.md` (cron fleet-wide goal driver,
  merged #3491 — not attached-task supervision); uncommitted draft `rfc-autonomous-goal-supervisor.md`
  (unattended goal driver; capability-removal enforcement, shadow→nudge→full); `rfc-supervision-next-
  actions.md` (follow-up surface); `rfc-meta-task-coordinator.md` (cross-project attention routing).
