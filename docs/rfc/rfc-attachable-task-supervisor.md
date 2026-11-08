# RFC: Attachable Task Supervisor — one-click supervision of running tasks

**Status:** Draft (v3 — converged: 2 critic rounds + empirical checkpoint + consensus attack)
**Date:** 2026-11-08
**Author:** Jean Ibarz (with Claude)
**Evidence pack:** [`rfc-attachable-task-supervisor-evidence.md`](./rfc-attachable-task-supervisor-evidence.md)
**Related:** `plugin/playbooks/goal-supervisor.md` (fleet-wide, cron-driven goal driver — a different
shape), draft `rfc-autonomous-goal-supervisor.md`, `rfc-supervision-next-actions.md`,
`rfc-meta-task-coordinator.md`. **Found along the way:** issue #3513.

---

## Summary

Having one Kookr task supervise others is the operator's most leveraged way to step away, but today
it is a hand-written prompt that names its targets vaguely, re-states the same rules every time, and
relies on the supervisor waking itself up, which it does not reliably do. This RFC makes
**supervision a first-class Kookr object**: select running tasks, press *Supervise*, review a brief
pre-filled from the targets' state and the operator's standing preferences, launch. Kookr then
**wakes the supervisor when a target needs it and at least every 45 minutes**, **alerts the
operator's phone if the supervisor itself stops working**, keeps a server-written record of what was
done on the operator's behalf, and learns preferences only through operator-confirmed proposals.

The most valuable piece is the cheapest: a **server-side heartbeat wake plus a dead-supervisor
alert**. The live supervisor that motivated this RFC (5c99a663) went idle one hour into a four-hour
mandate while the operator was away, because its self-armed `Monitor` expired and nothing woke it.

## Problem

Observed (evidence pack §2, plus round-2 measurements):

1. **Supervision is a manual prompt.** 9 Kookr supervisor runs plus 13 prompts asking a plain Claude
   session to supervise Kookr tasks. Each re-types goals, duration, autonomy, anti-laziness and money
   rules.
2. **Targets are named vaguely** ("the two existing running tasks"); the supervisor has to guess.
3. **The supervisor goes idle and nobody notices.** An agent cannot reliably schedule its own wake-up
   (5c99a663: `Monitor` expired → `POSSIBLY HUNG`, operator away). The 20.7 h run 6e87d33e ($105) used
   72 `ScheduleWakeup`s; 19 were no-ops; ~51 re-pasted a growing block of standing rules.
4. **The craft is known but not packaged.** The `kookr-task-supervisor` agent and notebook shelf
   encode the rules (read the *full* last message; heartbeat ≠ liveness; `/compact` workers yourself;
   workers verify themselves) but it is a Claude Code subagent, not a Kookr launch option.
5. **Steering can answer a worker's question by accident.** `kookr reply` → `sendDirectAgentInput`
   sends Ctrl-U + paste + Enter with no screen check. **Measured (C1):** at a Claude Code menu the paste
   is discarded and Enter picks option 1. Production runs with `KOOKR_BYPASS_ALL_PERMISSIONS=true`, so
   workers rarely see tool-approval prompts; the menus they do show are mostly `AskUserQuestion`
   (sampled `PermissionRequest` events: 24 AskUserQuestion, 2 Bash). A supervisor's "please continue"
   sent to a worker that just asked "A or B?" silently answers "A". Issue **#3513**.
6. **Money rules exist only as prose**, and the real exposure is different from how the rules are
   phrased. "Never refill / subscribe" mostly describes web-dashboard purchases that an API key cannot
   make. The reachable risk is **postpaid metered keys** in the host environment (sessions inherit the
   full server env — C6), whose spend has no ceiling; a **prepaid** key is self-limiting by its balance,
   which is exactly why the operator is comfortable with "spend all of the DeepInfra prepaid budget".

## Goals and non-goals

**Goals**
- G1. Launching a supervisor over N named running tasks takes < 30 s and no free-form prompt writing.
- G2. While a mandate is active, the supervisor is woken when a target needs it and at least every
  `heartbeatMin`; if it cannot be woken or stops responding, the operator is alerted.
- G3. Standing rules are stated once, pre-filled, visibly applied, and corrected in place.
- G4. On return, the operator sees a server-built account of what happened, even if the supervisor died.
- G5. Kookr never answers a worker's menu or prompt by accident, and is explicit about which money and
  destructive-action rules it enforces versus only instructs.

**Non-goals**
- A billing/metering engine; Kookr cannot see a provider balance.
- Defending against an *adversarial* supervisor on the same host (see Threat model).
- Replacing `goal-supervisor` (fleet-wide, cron). Attached supervision is task-scoped,
  operator-launched and time-bounded.
- Multi-user identity, nested supervision, autonomous goal decomposition.

## Threat model

The supervisor is an LLM with a shell on the operator's machine, under the operator's account. It can
`curl` any local route, `tmux send-keys` any pane, read other processes' environments and launch tasks.
**Kookr cannot make a same-host supervisor *unable* to do something** (round 1 rejected per-supervision
tokens; round 2 rejected the env allowlist as "capability removal" for the same reason). The realistic
failure is an **over-eager but honest** supervisor or worker. The design therefore:

1. **Makes the safe path the easy path:** structured `kookr answer` for menus; `kookr reply` refuses to
   type into any screen it does not positively recognise as an idle prompt.
2. **Puts a fail-closed guard before obviously reserved tool calls** for workers launched under the guard
   (a blocking `PreToolUse` hook, §5), and says plainly that already-running workers are not covered.
3. **Puts the money guarantee where it actually is:** provider-side (prepaid balance, auto-recharge off)
   and in which keys exist in the environment, which the launch reports.
4. **Writes the audit trail on the server**, so the operator sees what happened even if the supervisor
   didn't record it.

## Design

### Ownership

One core **`SupervisionService`** (with a store port) owns the supervision aggregate and its
invariants; the CLI, dashboard, Telegram, the wake tick and the answer route go through it, and every
ledger append goes through it.

| Concept | Owner / store |
|---|---|
| **Supervision**: supervisor task id, explicit targets, `deadlineAt`, `nextHeartbeatAt`, `costCapUsd`, health, last-delivered digest key | `SupervisionService` → `~/.kookr/supervisions/<id>/state.json` (atomic temp+rename) |
| **Effective targets** = explicit ∪ `spawned_by` descendants (depth ≤ 2), recomputed each tick; **one live supervisor per effective target** (a descendant already supervised elsewhere stays with its first supervisor) | derived |
| `supervises` edges | projection written by the service so the existing UI renders the tree; rebuildable from `state.json` |
| **Brief** | `brief.md`, rendered **by the server** at launch from parameters + effective preferences; the playbook reads only the brief |
| **Ledger** (server facts: wakes and their outcome, supervisor `peek`/`reply`/`answer` calls inferred from API actor, refusals, health changes, escalations) | `ledger.jsonl`, appended only via the service |
| **Notes** (supervisor-written judgement: `decided`, `held`, `escalated` + reason) | `notes.jsonl` via `kookr supervision note` (optional enrichment, not the source of truth) |
| **Never-policy** (enforced rules as data + one `evaluate(toolCall)`) | core `NeverPolicy` module; `~/.kookr/supervision-never.yaml`, separate from advisory preferences, on the protected-paths list |
| **Preferences** (advisory) | `~/.kookr/supervision-preferences.yaml`; written only by the operator's accept action |

### 1. The `task-supervisor` playbook

`plugin/playbooks/task-supervisor.md` packages the `kookr-task-supervisor` craft as a launchable
playbook with three parameters: `targets` (task ids), `goals` (textarea, pre-filled §6), `until` (`+4h`
default; `+Nh` or `HH:MM`). The body: `kookr peek` the full last message, never truncated; stall flags
are hints, so cross-check before nudging and never restart a working agent; workers verify their own
work and "should work" is rejected; `/compact` a worker only at its idle boundary; decide technical
questions yourself; answer worker menus with `kookr answer`; escalate only on dead end, reserved
action or credential wall; **do not run `Monitor`, `sleep` loops or `ScheduleWakeup`: end your turn,
Kookr wakes you**. `NB_ROLE=kookr-task-supervisor` loads the existing lessons. Default model Sonnet,
overridable (the Opus run cost $105 over 20.7 h).

`kookr supervise <id…> --print-brief` prints the rendered brief (exact ids, state, preferences) for
the operator to paste into a plain Claude session, since 13 of 22 observed supervisions ran outside
Kookr. Those sessions get the brief but not the wake or the watchdog.

### 2. Wake: heartbeat first, attention digest second

A tick driver (60 s, plus an early kick from turn-state transitions with `meta.origin !== 'replay'`,
C2) calls a pure `decide(supervisionState, targetStates, now) → actions`, persists the result through
the service, and hands deliveries to a **`notifySession` adapter**.

- **P2a, the heartbeat (would alone have saved 5c99a663):** at `nextHeartbeatAt` (default 45 min) and
  at `deadlineAt`, deliver `[kookr supervision 7e01] mandate until 18:00 · 2 targets · brief: <path>`
  or `mandate ended: recap and signal completion-ready`.
- **P2b, the attention digest:** deliver when the **digest key** changes. The key is the per-target
  `(state, turn/prompt sequence id)`, so a second `completed_turn` or a second question in the same
  state still counts as new (round-2 failure-mode #5).

  | Target condition | Digest line |
  |---|---|
  | `waiting_for_input` (menu or question) | needs an answer: `kookr peek` then `kookr answer` |
  | `completed_turn` | stopped at a boundary: decide next step |
  | terminal status | finished: status |
  | stall anomaly | possible stall: look before acting |
  | unchanged for > 30 min with ≥ 2 supervisor looks | "still stuck since HH:MM, looked N×": escalate to operator |

  An item escalated to the operator **leaves the attention set** until its state changes, so the
  supervisor is not re-woken (and billed) for something it may not act on.
- **Restart-safe by construction:** the tick recomputes from current state and persisted timers; no
  in-memory queue, no replay storm.
- **Kill switch:** `KOOKR_SUPERVISION_WAKE_DISABLED=1`. Watchdog and status keep running.

**`notifySession` delivery is fail-closed.** It types only when a fresh pane capture is **positively
recognised as an idle input prompt** (pinned fixtures per Claude Code version); any unrecognised
screen means "don't type". It re-captures immediately before sending Enter. Round 2 showed the
existing `isPaneBusyOrAwaitingDialog` is deliberately tuned to accept false negatives, which is
unsafe here. A supervisor whose pane is idle but whose `lastTurnState` says `running` (background
tasks, C5) still receives the wake. It returns `delivered | busy | menu | unrecognised`. P0 (#3513)
uses the same recogniser, so there is one dialog guard, not two.

**Context hygiene:** no Kookr-driven `/compact` of the supervisor. It relies on Claude Code
auto-compact (C4: Kookr does not disable it; the upstream default is unverified, and a 4 h soak is a
P2 exit criterion). Every wake carries the brief path; nothing load-bearing lives only in
conversation memory.

### 3. Watchdog and health (P2a)

Health: `healthy · degraded(undeliverable | thrashing | over-budget) · dead · ended(deadline |
targets-terminal | operator)`. The watchdog is its own function, the only writer of health.

- **Undeliverable:** a due wake not delivered for 3 consecutive ticks (busy/menu/unrecognised), or no
  delivery at all for `heartbeatMin + 15 min`, gives `degraded:undeliverable` and an alert. This closes
  the starvation path where a supervisor that keeps a `Monitor` running is never idle and so never
  declared dead (round-2 failure-mode #4).
- **Dead:** no supervisor turn within 10 min of a delivered wake, or the supervisor task becomes
  terminal or hung during the mandate, gives `dead` and an alert.
- **Thrashing:** more than 12 deliveries/hour. **Over-budget:** supervisor token spend above
  `costCapUsd` (existing per-task counters). Wakes pause in both states.
- **Self-healing before alerting (hybrid continuity).** A live session is kept while it is healthy,
  because it carries judgement between wakes (which worker over-claimed earlier, what it was already
  told). But continuity is an optimisation, not a dependency: the brief, `state.json`, the ledger and
  the notes are a complete hand-off. On `undeliverable` or `dead`, Kookr **automatically starts a
  fresh supervisor episode** from them (the previous session is ended; the projection edges move to
  the new task), at most 3 times per mandate and at most once per 30 min. **It alerts the operator
  only when a fresh episode also fails**, or when the restart limit is reached. A Claude Code update
  or a stray banner at 01:30 therefore costs one cold start, not a 2 a.m. phone alert or six dead
  hours. `goal-supervisor` already shows this per-run shape works.
- **Alerts** go through the existing Telegram notifier's routing (one outbound owner) with a
  `bypassQuietHours` flag (used only after self-healing failed), and carry [Restart again] [End] buttons.
- `kookr supervision status <id>`, `GET /api/supervisions/:id` and Telegram `/supervisions` ship in P2a.

### 4. Answering workers: `kookr answer` (P3a)

Workers mostly need *answers* (menus, questions), not tool approvals (problem §5).
`kookr answer <task> --option <n> | --text "<free text>"` reads the live `AskUserQuestion` /
permission request from the worker's latest `PermissionRequest` event, checks it is still live and
matches what the supervisor peeked (prompt id + staleness check, extracted from the Telegram Approve
use-case into a shared core use-case), selects the explicit option with keystrokes (no blind Enter),
and appends a ledger fact. For a tool-approval prompt (non-bypass workers), it evaluates the tool call
against `NeverPolicy` and refuses matches. Covers Claude Code first, Codex next; other adapters are
refused and escalated.

### 5. Guarding reserved actions (P3b), and what it does not cover

- **Guard hook:** a **separate, blocking, fail-closed** `PreToolUse` hook (not the shared
  fire-and-forget event writer) that runs `kookr policy check` against `NeverPolicy` and exits non-zero
  on a match **or when it cannot decide** (server down, timeout). It is installed at spawn on workers
  launched or relaunched under supervision and on the supervisor itself. It works under
  `--dangerously-skip-permissions`, because hooks still run there. To verify in P3b: the hook's blocking
  exit semantics under bypass mode and its latency cost per tool call.
- **Not covered:** workers that were already running when attached (their `--settings` cannot change
  mid-session, C3) and Codex workers. The attach dialog says so and offers *Relaunch under guard*
  (resume the session with new settings) where the adapter supports resume.
- **Default never-policy (extend-only):** provider billing/plan/top-up endpoints and CLIs;
  force-push or delete of protected refs; `rm -rf` outside the task worktree; writes to credential files,
  Kookr settings, `supervision-never.yaml` and `supervision-preferences.yaml`; raw terminal injection
  (`tmux send-keys`, the raw message route). This is pattern matching, a strong reduction and not a
  seal.

### 6. Money, prefill and preferences (the headline ask)

**What the launch reports (P3c):** which provider credentials the supervisor and its targets can reach
(names only), each classified *prepaid* / *postpaid-metered* / *unknown* from the preferences file.
The brief and the return card say, for example, "postpaid keys reachable: BASETEN_API_KEY. Spend
ceiling is advisory." This is the honest money surface.

```yaml
# ~/.kookr/supervision-preferences.yaml  (advisory; hand-seeded from past prompts in P3c)
autonomy: decide-yourself
until: +4h
costCapUsd: 15
recap: telegram
escalation: { channel: telegram, quietHours: "23:00-08:00" }
providers:
  deepinfra: { billing: prepaid, autoRechargeVerifiedOff: 2026-11-07, use: freely }
  baseten:   { billing: postpaid, use: ceiling, usd: 20, expires: 2026-11-15 }
  default:   { use: ask-me }
do:   ["workers verify on the host and read session logs", "/compact workers between slices"]
dont: ["ask me questions you can answer from the brief", "buy, subscribe, top up or refill anything"]
```

- **Prefill (P3c):** the deterministic part comes first. Each target's state, its pending question if
  any ("1a2b is waiting on you: model A or B?"), and the applicable preferences are rendered with no
  LLM. A Sonnet call (existing `llm/factory`, behind a proposal-only port) then drafts the `goals` lines
  from the targets' prompts and last messages. Kookr records how much the operator edits each draft. If
  most drafts are rewritten, the LLM step is removed and the deterministic prefill stays. Each
  preference chip says **enforced** (never-policy, guard hook) or **advisory** (everything in
  `supervision-preferences.yaml`).
- **Learning (P4), propose-and-confirm only:** at mandate end, and immediately when the operator answers
  an escalation with "always" or "never", a Sonnet pass proposes a YAML diff ("you approved Baseten
  spend 3× under $20: add a ceiling?"). Nothing is written until the operator accepts that line.
  Ceilings carry `expires`; rules unconfirmed for 60 days show "still true?" at the next prefill.

### 7. UX surfaces (P3d / P3e)

- **Entry:** task-list multi-select → *Supervise selected (N)*; task detail → *Supervise…* /
  *Attach to supervisor ▸*; Telegram `/supervise <id…>` → prefilled card [Launch] [Edit on web]
  [Cancel]; CLI `kookr supervise <id…> [--until 4h] [--print-brief]`.
- **Supervisor row:** targets with state, last look/intervention, *next wake*, health, mandate
  progress, cost vs cap; [Message] [Extend] [Detach] [End].
- **Return card, built by the server** from ledger + target states, with notes as optional enrichment,
  so it works when the supervisor is dead or wrote nothing. It shows per-target outcome, answers given
  on the operator's behalf (with *wrong, teach me*), pending escalations, health incidents, cost, and
  reachable postpaid keys. It is sent to the recap channel and its delivery is logged.

## Phased delivery

| PR | Ships | Exit / safety |
|---|---|---|
| **P0** | #3513: one fail-closed idle-prompt recogniser; `kookr reply` and the raw message route refuse to type into anything else (menus, permission prompts, unrecognised screens). | Independent safety fix for today's supervisors. Ship now. |
| **P1** | `SupervisionService` + `state.json`; `task-supervisor.md`; `kookr supervise` (+ `--print-brief`); `supervises` projection. Playbook's "Kookr wakes you" line is behind the P2a flag; until then it keeps today's self-wake guidance. | Not unsafe alone: never ships a playbook that disables self-wake without a server wake. |
| **P2a** | Heartbeat + deadline wake via `notifySession`; watchdog + health + Telegram alerts; `status` CLI/API/Telegram; kill switch. | **Fixes the motivating incident.** Exit: a real 4 h soak with an absent operator (also confirms C4). |
| **P2b** | Attention digest (sequence-keyed); escalation leaves attention set; server ledger incl. inferred looks. | Behind the same kill switch. |
| **P3a** | Shared answer/approve use-case extracted from Telegram; `kookr answer`. | Pure refactor plus route. |
| **P3b** | `NeverPolicy` + `kookr policy check` + blocking fail-closed guard hook at spawn; *Relaunch under guard*. | Spike first: blocking semantics under bypass mode and per-call latency. |
| **P3c** | Credential report; preferences file (hand-seeded); deterministic prefill + Sonnet goal draft + edit-rate metric. | Chips stay "advisory" unless P3b is live for that worker. |
| **P3d** | Dashboard: button, brief form with target picker, supervisor row, server-built return card. | Needs P0, P2a, P3a; not P3b/P3c. |
| **P3e** | Telegram `/supervise`. | |
| **P4** | Propose-and-confirm learning; *teach me*; expiry prompts. | Built on real usage. |

Rollback: each PR is behind its own flag or is additive. `~/.kookr/supervisions/` is ignored when the
service is absent. Projection edges are marked `source: api, evidence: supervision` so a revert can
supersede them in bulk. Follow-up issue (not this RFC): the same `NeverPolicy` and guard hook for
`goal-supervisor` children.

## Requirements

- **R1.** Targets are explicit. Effective targets add `spawned_by` descendants (depth ≤ 2), and each
  effective target has at most one live supervisor.
- **R2.** An idle supervisor with an active mandate is woken at least every `heartbeatMin` and once at
  the deadline, across restarts.
- **R3.** Within 60 s of a change in the digest key (state + sequence id), one digest is delivered to an
  idle supervisor, or the attempt outcome is in the ledger.
- **R4.** Nothing is typed into a session unless a fresh capture is positively recognised as an idle
  prompt (supervisor wakes, `kookr reply`, the raw route).
- **R5.** A due wake undelivered for 3 ticks, a supervisor silent 10 min after a delivered wake, or a
  supervisor that dies during the mandate triggers an automatic fresh episode from brief + ledger +
  notes (≤ 3 per mandate, ≥ 30 min apart); the operator is alerted, bypassing quiet hours if needed,
  only when that fails or the limit is reached.
- **R6.** Worker menus and prompts are answered only by explicit option or text via `kookr answer`;
  every answer is a ledger fact.
- **R7.** The guard hook blocks never-policy matches and fails closed; the UI states which workers it
  does not cover.
- **R8.** The return card is built by the server and is correct with zero supervisor notes.
- **R9.** Preference changes require an operator-accepted diff; chips say enforced/advisory; the launch
  reports reachable postpaid credentials.

## Edge cases

- **Server restart:** the first tick recomputes; timers are persisted; replayed events don't kick.
- **Supervisor-induced loops** (nudge, worker turn, wake, nudge): bounded by thrashing detection,
  the "looked N×" escalation and `costCapUsd`.
- **Operator answers a target directly:** an operator-actor ledger fact; the next digest says so.
- **Stall false positives during compaction or long builds:** they produce a look, never an action.
- **Claude Code UI change breaks the idle-prompt fixtures:** delivery fails closed, giving
  `undeliverable`, an alert, and a fixture update. It fails loudly, never by approving something.

## Alternatives considered

1. **Better prompt only.** Necessary (P1) but not sufficient: an agent cannot reliably wake itself.
2. **Edge-triggered wake processor with in-memory coalesce/dedup** (v1). Lost wakes, replay storms,
   lost timers. Replaced by a persisted, level-triggered tick.
3. **Per-supervision tokens** (v1) and an **env allowlist as capability removal** (v2). A same-host
   LLM can bypass both; dropped in favour of an explicit threat model.
4. **`kookr approve` + never-list at the approval step as the main safety layer** (v2). Under the
   operator's bypass configuration workers almost never ask for tool approval, so the layer guarded the
   wrong thing. Replaced by `kookr answer` plus a pre-tool guard hook.
5. **Push subscription (WS/SSE) for the supervisor.** More moving parts per agent; a digest typed into
   an idle prompt works for any agent type.
6. **Extend `goal-supervisor`.** Blends a cron fleet lifecycle with an event-driven, task-scoped one.
7. **Spend engine.** Kookr can't see balances. The credential report plus prepaid-vs-postpaid
   classification addresses the real exposure.
8. **Silent preference learning.** A silently learned money rule is a silent grant.

## Open questions

1. Should the supervisor be **fully episodic** (a short fresh task per wake, no live session at all)?
   The hybrid keeps a live session for judgement continuity. The P2a 4 h soak should compare one run
   in each mode on cost per hour, interventions, and misjudgements caught. If episodic is as good, drop
   live-session delivery and the idle-prompt recogniser is then needed only for P0.
2. Should the guard hook also be offered fleet-wide (all workers, not only supervised ones)? It is the
   only pre-tool money guard Kookr would have.

## Critic feedback incorporated

**Round 1** (2026-11-08): `boundary-critic`, `failure-mode-analyst`, `design-minimalist`,
`ambition-amplifier`, `operability-reviewer` (N=5).
- *Incorporated:* explicit threat model; token dropped; `SupervisionService` owns the aggregate, edges
  are a projection; level-triggered tick with persisted timers, replay exclusion, idle-checked
  delivery, wake budget; watchdog, health, Telegram dead-man and status in P2; server ledger vs
  supervisor notes; server-built return card; approval checks extracted from Telegram; credential
  check; supervisor `costCapUsd`; Sonnet default; dropped processor-driven `/compact`, `--steal`,
  nesting and per-project merges.
- *Rejected:* enforcing spend tiers with `getLifetimeSpendUsd` (that counts Kookr agent tokens, not
  provider spend; reused only as the supervisor cost cap). `goal-supervisor` coverage moved to a
  follow-up issue.
- *Adversarial pair:* the minimalist wanted preferences, learning and prefill cut; the
  ambition-amplifier wanted them earlier. **I sided with ambition on timing** (prefill and hand-seeded
  preferences ship in P3c, because they are the operator's headline ask) **and with the minimalist on
  shape** (one advisory file, no merge semantics, no token, no nesting, learning last).
- `ambition-amplifier 2026-11-08: novel finding (prefill timing contradiction; refill guarantee unverified)`.

**Empirical checkpoint** (`design-experimenter`, Claude Code 2.1.319, throwaway sessions):
- C1 confirmed, and worse than expected: text + Enter at a menu or prompt selects option 1. Became #3513 / P0.
- C2 partial: `lastTurnState` is rewritten during replay. The kick now ignores replay.
- C3 falsified: deny rules don't reload mid-session. The guard covers workers at spawn; the attach dialog discloses the gap.
- C4 inconclusive: auto-compact is not disabled by Kookr. A 4 h soak is a P2a exit criterion.
- C5 partial: `completed_turn` lags; the delivery gate is the pane recogniser.
- C6 confirmed: full env inheritance. This drives the credential report.

**Round 2** (2026-11-08): `failure-mode-analyst` (re-attack), `socratic-challenger`,
`delivery-pragmatist`, `boundary-critic` (re-check) (N=4).
- *Verified by the author:* prod `.env` sets `KOOKR_BYPASS_ALL_PERMISSIONS=true`; sampled
  `PermissionRequest` events are mostly `AskUserQuestion` (24 of 26 parsed).
- *Incorporated:*
  - the approval layer was reframed as `kookr answer` plus a pre-tool guard hook (socratic Q1–Q2);
  - the guard hook is a separate fail-closed hook, not the fail-open shared writer (failure-mode #2);
  - a positive, fail-closed idle-prompt recogniser shared by P0 and wakes (failure-mode #1);
  - an undeliverable-starvation alert (failure-mode #4, socratic Q6);
  - a sequence-keyed digest (failure-mode #5);
  - uniqueness enforced on effective targets (failure-mode #6, boundary #4);
  - escalated items leave the attention set (failure-mode #7);
  - the env allowlist was dropped as "capability removal" (failure-mode #3);
  - the money surface was reframed around postpaid-vs-prepaid keys (socratic Q3);
  - `--print-brief` for plain sessions (socratic Q4);
  - heartbeat-first P2a (socratic Q5, delivery);
  - a deterministic prefill plus an edit-rate check on the Sonnet draft (socratic Q7);
  - server-inferred looks (socratic Q8);
  - P3 split into P3a–e, P1 kept inert until P2a, a kill switch and a 4 h soak exit (delivery);
  - one `NeverPolicy` module with `kookr policy check`, a decide/tick/notify split, the
    server-rendered brief, protected preference files and one outbound alert owner (boundary).
- *Rejected:* none outright. The minimalist-style suggestion to drop the Sonnet goal draft entirely
  (socratic Q7) became a measured experiment, because the operator asked for it explicitly.

**Consensus attack** — `general-purpose 2026-11-08: consensus-attack — finding`. The whole panel
assumed the supervisor must be one long-lived session that Kookr wakes by typing into its pane. Much
of the design existed to keep that session alive, and the fail-closed delivery turns a Claude Code
update at 01:30 into a 2 a.m. alert or six dead hours. *Incorporated (one revision):* hybrid continuity.
The live session is kept while healthy; on `undeliverable`/`dead` Kookr automatically starts a fresh
episode from brief + ledger + notes (rate-limited); the operator is alerted only if that fails. Fully
episodic mode is an open question, settled empirically by the P2a soak.
