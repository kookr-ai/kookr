# Lucy Prod Update Watchdog Reference

The **Lucy Prod Update Watchdog** is a daily schedule that updates lucy's prod
deployment and must confirm the update actually converged. This page is the
source-of-truth spec for its required behavior, because the schedule itself is
operator state (it lives in `~/.kookr/schedules.json`, not in this repository —
see [Data Directory](data-directory.md)) and its prompt is not served over the
schedules API.

## Why this spec exists

On 2026-07-26 the watchdog ran and completed **green**, yet lucy prod kept
serving a deprecated model — `HTTP 410` on every session-summary write
(Nemotron-120B) — for hours after two corrective fixes (lucy #1622, lucy #1632)
had already merged (lucy #1653). The watchdog neither converged prod nor alerted
on the lag.

A watchdog that completes green while its postcondition is false is worse than
none: it manufactures false confidence and suppresses the very alert an operator
needs. The rule this page enforces: **verify the real postcondition after the
update, and terminate non-green with an alert artifact whenever it is unmet.**

## Schedule definition

| Field | Value |
| --- | --- |
| `name` | `Lucy Prod Update Watchdog` |
| `id` | `2bced178-a478-4439-ab19-671b8dfc2bff` |
| `enabled` | `true` |
| `cron` | `0 4 * * *` (daily 04:00, scheduler timezone) |

The prompt/playbook body is operator state; audit or edit it in
`~/.kookr/schedules.json` (or via `PATCH /api/schedules/<id>` if a future build
exposes the prompt field — as of build `1ee2931e` the schedules API does not
return it).

## Required behavior

The watchdog run **must** perform the following after its update attempt. Every
probe is time-bounded so a hanging status surface escalates rather than hangs.

1. **SHA-convergence postcondition.** Read lucy prod's live `GIT_SHA` from lucy's
   status surface (its `/status` / health endpoint) and compare it to
   `origin/main` of the lucy repository. The run passes this check only when
   `live GIT_SHA == origin/main HEAD`.
2. **Critical-config sanity probe.** Confirm the deprecated-model failure mode is
   gone: no `HTTP 410` on session-summary writes observed since the restart, and
   a probe request that exercises the model path returns success (not 410). This
   is the concrete regression from lucy #1653.
3. **Escalate on any failure.** If either check fails (SHA still behind, or the
   config probe 410s / fails), the run **must terminate non-green** and produce
   an operational alert artifact naming the divergence: the live SHA vs
   `origin/main`, and the failing probe's verbatim output. Escalation means
   file/update an alert (e.g. comment on the tracking issue) — never a silent
   green.
4. **Bounded probes.** Apply an explicit timeout to every network probe (status
   surface read, model probe). A hanging status surface yields an escalation
   ("status surface unreachable within N s"), not a hung watchdog run.

## Acceptance criteria (from #1595) — how this spec satisfies them

- **Reproducing #1653 cannot end green.** Behavior (1)+(3): when the update
  leaves live SHA behind `origin/main`, or the 410 persists post-restart, the
  postcondition check fails, the run terminates non-green, and the alert
  artifact names the divergence (live SHA vs main, failing probe output).
- **A genuinely-converged update completes green.** Behavior (1)+(2): when live
  SHA matches `origin/main` and the config probe passes, the run completes green
  with the verified SHA logged.
- **No hung watchdog.** Behavior (4): all probes are time-bounded; a hanging
  status surface produces an escalation, not a hang.

## Auditing / updating the schedule

Because the schedule is operator state, apply this spec by editing the
watchdog's prompt so it implements behaviors (1)–(4). Preferred (server
running), through the API so the in-memory store and on-disk file stay
consistent:

```bash
# Inspect the current schedule (metadata; prompt is not returned by the list API):
curl -sS --max-time 10 http://127.0.0.1:4800/api/schedules \
  | jq '.[] | select(.name=="Lucy Prod Update Watchdog")'

# Update the prompt to implement behaviors (1)-(4) above (field name per the
# build's schedule schema, e.g. "prompt"):
curl -sS --max-time 10 -X PATCH \
  http://127.0.0.1:4800/api/schedules/2bced178-a478-4439-ab19-671b8dfc2bff \
  -H 'content-type: application/json' \
  -d '{"prompt":"<watchdog prompt implementing the SHA-convergence check, config probe, escalation, and bounded timeouts specified above>"}'
```

Only edit `~/.kookr/schedules.json` directly while the server is **stopped** — a
running server holds schedules in memory and rewrites the file on every mutation
(`ScheduleStore.persist()`), so a live direct edit is clobbered.

## References

- Issue: #1595 (umbrella #1551).
- lucy incident: lucy #1653; merged-but-not-live fixes: lucy #1622, lucy #1632.
- Sibling precedent for documenting an operator-state schedule from source:
  [Kookr Self-Batch Schedule](kookr-self-batch-schedule.md) (#1563).
