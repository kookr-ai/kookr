# Findings Reference

Kookr's supervisor surfaces **findings** (anomalies) to route operator attention
across many AI coding agents. Each finding has a typed `AnomalyType` that
determines how it is grouped, prioritized, and explained in the dashboard.

This page is the canonical catalog for every anomaly type: what it means, what
triggers it, the recommended developer response, and how to suppress or tune it.
The runtime explanation shown on a finding card is per-instance; this catalog is
the complete set.

The source-of-truth union is
[`AnomalyType` in `src/core/anomaly-types.ts`](../../src/core/anomaly-types.ts).
A drift-guard test (`src/core/anomaly-types.test.ts`) asserts that every member
of the union has a section here, so adding a new anomaly type without
documenting it fails CI.

Findings are ordered severity-first: **critical** before **warning** before
**info** (F2.8). The same finding can be skipped, snoozed, or marked as a false
positive regardless of its type — see [Cross-cutting controls](#cross-cutting-controls).

## Catalog

| Anomaly type | Severity | Meaning |
| --- | --- | --- |
| [`needs_input`](#needs_input) | info / warning | Agent finished its turn or is explicitly asking a question. |
| [`permission_blocked`](#permission_blocked) | warning | Agent is blocked on a tool-permission prompt. |
| [`repeated_error`](#repeated_error) | warning | The same error recurred past the threshold. |
| [`merge_conflict`](#merge_conflict) | warning | A git operation hit a merge/rebase conflict. |
| [`stale_agent`](#stale_agent) | info / warning | Agent appears stuck, exited, or hung with no progress. |
| [`hook_disconnected`](#hook_disconnected) | warning | Agent is visibly active but the hook pipeline stopped delivering events. |
| [`hook_missing`](#hook_missing) | warning | Hooks were never wired up for the session. |
| [`tmux_unresponsive`](#tmux_unresponsive) | warning | The terminal backend is unreachable. |
| [`api_error`](#api_error) | warning / critical | The model/provider API failed and killed the turn. |
| [`budget_exceeded`](#budget_exceeded) | warning / critical | Task cost crossed the configured USD threshold. |

---

## `needs_input`

**Meaning.** The agent is waiting for the developer — either it finished its
turn and is idle, or it explicitly asked a question.

**Severity.** `info` for a completed turn (`subType: 'stop'`); `warning` for an
explicit `AskUserQuestion` call (`subType: 'ask_user_question'`).

**Trigger.** Detected in `src/core/anomaly-detector.ts`: a trailing `Stop` hook
event (the agent finished its turn — `detectNeedsInput`), or a trailing
`AskUserQuestion` tool call with no subsequent `tool_result`/`input_received`
resolving it (`detectAskUserQuestion`). The watchdog
(`src/core/watchdog.ts`) also raises it when the pane shows a confident input
prompt and the agent is stale.

**Recommended response.** Read the explanation (it includes the last assistant
message), inspect the terminal if needed, then send a reply or hint. Kookr
advances to the next queued finding.

**Suppression / tuning.** No threshold knob — the signal is event-driven. Snooze
the finding if you intend to leave the agent idle, or mark a false positive
(F9.1) if the agent was not actually waiting. A completed turn is rendered as
"Turn Complete" rather than "Needs Input" (issue #358) to tone down idle agents.

## `permission_blocked`

**Meaning.** The agent is blocked on a tool-permission prompt and cannot
proceed until a human allows or denies it.

**Severity.** `warning`.

**Trigger.** Detected in `src/core/anomaly-detector.ts` (`detectPermissionBlocked`)
when the latest event is a `permission_request`, fired by the `PermissionRequest`
hook before the dialog appears. The watchdog also raises it from an
authoritative pending permission request or a high-confidence
`permission_dialog` pane classification.

**Recommended response.** Approve or deny the tool in the agent's terminal, or
use Kookr's quick actions when offered. The explanation names the blocked tool.

**Suppression / tuning.** Launching agents with
[`KOOKR_BYPASS_ALL_PERMISSIONS=true`](environment-variables.md#operational-risk)
removes permission prompts entirely (Claude Code gets
`--dangerously-skip-permissions`; Codex gets
`--dangerously-bypass-approvals-and-sandbox`). This removes a safeguard — use it
only for controlled local sessions.

## `repeated_error`

**Meaning.** The agent keeps hitting the same error and is not changing its
approach.

**Severity.** `warning`.

**Trigger.** Detected in `src/core/anomaly-detector.ts` (`detectRepeatedError`):
the same `error` event message recurs at least `repeatedErrorThreshold` times
(default `3`) within the detection window (`windowSize`, default `50` events).

**Recommended response.** Read the repeated error, then send a hint that
unblocks the loop (a corrected command, a missing dependency, an alternative
approach).

**Suppression / tuning.** `repeatedErrorThreshold` and `windowSize` are detector
config (`AnomalyDetectorConfig`), not environment variables; they default to `3`
and `50`. Snooze or mark a false positive (F9.1) to suppress similar anomalies
for the rest of the session.

## `merge_conflict`

**Meaning.** A git operation the agent ran (merge, rebase, pull, cherry-pick,
stash pop/apply, `gh pr checkout`, etc.) produced a conflict.

**Severity.** `warning`.

**Trigger.** Detected in `src/core/anomaly-detector.ts` (`detectMergeConflict`):
the latest `Bash` `tool_result` follows a git-conflict-capable command and its
output matches a conflict pattern (`CONFLICT (content)`, `Automatic merge
failed`, `Unmerged paths:`, and similar). Conflicted file names are extracted
into the explanation when present.

**Recommended response.** Resolve the conflict — either guide the agent to fix
the listed files and continue, or resolve it yourself in the working tree.

**Suppression / tuning.** No threshold knob. Snooze the finding while you resolve
the conflict manually, or mark a false positive (F9.1) if the output was not a
real conflict.

## `stale_agent`

**Meaning.** The agent appears stuck, hung, or has exited — no progress for
longer than the stale threshold, with no tool in progress and no token activity.

**Severity.** `warning` in most cases; `info` when the pane process is alive but
is not Claude Code.

**Trigger.** Raised by the heartbeat watchdog (`src/core/watchdog.ts`) when
events have been silent past `staleThresholdMs` (default 30s) with a frozen pane
and no token activity, or when a tool has been running past
`maxToolExecutionTimeMs` (default 10min). The process-liveness strategy
(`src/core/process-liveness.ts`) and pane semantics
(`src/core/pane-patterns.ts`, shell-prompt state) also emit `stale_agent` when
the Claude Code process is gone or the pane fell back to a shell prompt.

**Recommended response.** Inspect the terminal. If the agent is genuinely hung,
send input to nudge it, or stop and relaunch the task. If the process exited,
relaunch.

**Suppression / tuning.** Thresholds live in `WatchdogConfig`
(`staleThresholdMs`, `unconditionalStaleThresholdMs`, `maxToolExecutionTimeMs`,
`tokenActivityThresholdMs`, `gracePeriodMs`, `mcpStartupGracePeriodMs`) rather
than environment variables. Snooze the finding to pause monitoring for a chosen
duration (F3.7).

## `hook_disconnected`

**Meaning.** The agent is visibly active (the pane is changing) but Kookr has
received no hook events for a long time — the hook pipeline, not the agent, is
broken.

**Severity.** `warning`.

**Trigger.** Raised by the watchdog (`src/core/watchdog.ts`) when the pane keeps
changing but no hook events arrive for at least `unconditionalStaleThresholdMs`
(default 60s).

**Recommended response.** Check that the agent's Claude Code / Codex hooks are
installed and pointing at the running Kookr instance. See
[Hooks Setup](../hooks-setup.md). The agent itself is usually fine; restoring
the hook pipeline restores accurate findings.

**Suppression / tuning.** Threshold is `unconditionalStaleThresholdMs` in
`WatchdogConfig`. Fixing the hook configuration is the real remedy; snoozing
only hides the symptom.

## `hook_missing`

**Meaning.** Hooks were never wired up for the session, so Kookr cannot observe
the agent's lifecycle events at all.

**Severity.** `warning`.

**Trigger.** This type is part of the liveness anomaly family (see
[`docs/system-models/subsystems/supervisor-agent/00-subsystem-summary.md`](../system-models/subsystems/supervisor-agent/00-subsystem-summary.md))
and the supervisor-feedback taxonomy. It signals an absent hook configuration
rather than a transient disconnect.

**Recommended response.** Install and configure the Kookr hooks for the agent.
See [Hooks Setup](../hooks-setup.md). Until hooks are present, event-driven
findings for that session are unavailable.

**Suppression / tuning.** No threshold knob. Resolve by configuring hooks; this
is a setup gap, not a tunable signal.

## `tmux_unresponsive`

**Meaning.** The terminal backend is unreachable, so Kookr cannot read the
agent's pane or drive its session.

**Severity.** `warning`.

**Trigger.** Part of the liveness anomaly family. The symbol is named
`tmux_unresponsive` for historical reasons; a rename to `backend_unreachable`
is pending (see [`docs/architecture.md`](../architecture.md)). Kookr's only
supported backend today is `dtach` (the tmux backend was removed).

**Recommended response.** Check the dtach backend and socket directory
(`KOOKR_DTACH_SOCK_DIR`). If the backend is wedged, stop and relaunch the
affected task.

**Suppression / tuning.** No threshold knob. See the
[Terminal Backend](environment-variables.md#terminal-backend) variables for
backend configuration.

## `api_error`

**Meaning.** The model/provider API returned an error that killed the agent's
turn.

**Severity.** `critical` for `billing_error` and `authentication_failed` (they
require developer action); `warning` for other, typically transient, errors.

**Trigger.** Detected in `src/core/anomaly-detector.ts` (`detectApiError`) when
the latest event is a `stop_failure`. The explanation includes the error code
and a truncated last message.

**Recommended response.** For `billing_error` / `authentication_failed`, fix the
provider credentials or billing, then relaunch or resume. For transient errors,
retry the turn; relaunch if it persists.

**Suppression / tuning.** No threshold knob. Critical API errors are intentional
attention signals — resolve the underlying provider issue rather than
suppressing them. See the
[LLM Provider](environment-variables.md#llm-provider) variables for credential
configuration.

## `budget_exceeded`

**Meaning.** The task's observed token cost crossed its configured USD
threshold.

**Severity.** `warning` at the threshold; `critical` at twice the threshold.

**Trigger.** Raised by `src/core/budget-checker.ts` when observed cost reaches
`KOOKR_BUDGET_WARN_USD` (warning) or `2 × KOOKR_BUDGET_WARN_USD` (critical).
Each level fires at most once per task; a jump past both levels prefers the
critical alert and marks the warning delivered (F2.5, F4.9).

**Recommended response.** Decide whether the spend is justified. If not, stop or
redirect the task. If it is, acknowledge the finding and continue.

**Suppression / tuning.**
[`KOOKR_BUDGET_WARN_USD`](environment-variables.md#diagnostics-and-budgeting)
sets the warning threshold (default `25`); the critical level is always twice
that. Setting it to `0` disables budget findings entirely.

---

## Cross-cutting controls

These apply to any finding regardless of type:

- **Skip** (F3.6) deprioritizes an agent to the back of the queue; the
  supervisor keeps monitoring and re-queues it if state changes.
- **Snooze** (F3.7) pauses monitoring for a chosen duration with an optional
  reason; on expiry the supervisor re-evaluates and re-queues if the anomaly
  persists.
- **Findings feedback** (F9.1) lets you mark a finding as a false positive; the
  monitor records the verdict and suppresses similar future anomalies for the
  session.
- **Do Not Disturb** (F5.8) silences toasts, notifications, and the chime while
  detection keeps running.

## See also

- [Features — F2: Smart Anomaly Detection](../features.md#f2-smart-anomaly-detection-supervisor-agent)
- [User Guide — Finding Types](../user-guide.md#finding-types)
- [Environment Variables](environment-variables.md)
- [Architecture — anomaly catalogue](../architecture.md)
