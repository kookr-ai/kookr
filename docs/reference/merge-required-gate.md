# Merge-required gate (issue #1836)

Hard boundary on `completion_ready` for tasks that hold **merge authority**: a
child that was told to merge its PR cannot be retired as completed after only
opening the PR.

Complements the prompt-side TERMINAL-STATE CONTRACT and the
pr-merge-rebase-watchdog janitor. Same enforcement pattern as the
[lesson-decision gate](./lesson-decision-gate.md) (#1538).

## Surfaces

| Surface | Behavior |
|---------|----------|
| `POST /api/tasks/:id/signal` (`kind=completion_ready`) | `409` with `code: "merge_required"` when the gate refuses; signal is **not** recorded |
| Signal outbox drain | Same check; rejection → `permanent_fail` (entry dropped) |
| Human `POST /api/tasks/:id/complete` | **Not** gated |

## Opt-in (merge authority)

The gate is off unless the task declares merge authority via any of:

1. Explicit stamps: `mergeRequired: true`, `terminalState: "merged-pr"`, or the
   same keys under `metadata`
2. Playbook param: `playbookParameterValues.mergeAfterImplementation` is
   `"true"` or `"1"`
3. Prompt text: `TERMINAL-STATE CONTRACT (mergeAfterImplementation=true)` (or
   the same policy language near “merge authority” / `mergedAt`)

Ordinary “PR is the review gate” tasks are unaffected.

## Evidence

Scanned from PreToolUse shell commands in `~/.kookr/hooks/<tmuxSession>.jsonl`
(Claude `Bash` + Grok `run_terminal_command` shapes):

| Signal | Detection |
|--------|-----------|
| PR opened | `gh pr create` |
| Merge (trail fallback) | `gh pr merge`, `pnpm merge`, `kookr-merge.sh` |
| Blocker (waives merge) | literal `PR-BLOCKER:` (e.g. `printf 'PR-BLOCKER: …'`) |
| Live verification | `gh pr view <n> --json mergedAt` — non-null `mergedAt` preferred over trail merge intent |

When live check is available for the PR numbers in the trail, it **wins** over a
PreToolUse merge command (a failed merge attempt must not green-light
completion). When `gh` is unavailable, trail merge commands are the hermetic
fallback.

## Fail-open table

| Condition | Result |
|-----------|--------|
| Gate disabled (`KOOKR_MERGE_REQUIRED_GATE=0\|false\|off\|no`) | Allow |
| No merge authority | Allow |
| No hooks directory configured | Allow |
| Merge authority, no `gh pr create` in trail | Allow (gate only covers open-but-unmerged) |
| Merge authority + create + merge verified or `PR-BLOCKER:` | Allow |
| Merge authority + create + unmerged + no blocker | **409 `merge_required`** |

## Env

See `KOOKR_MERGE_REQUIRED_GATE` in [environment-variables](./environment-variables.md).

## Recovery for agents

1. Merge the PR (`pnpm merge <n>` / `gh pr merge <n>`), confirm
   `gh pr view <n> --json mergedAt` is non-null, **or**
2. Record a blocker: `printf 'PR-BLOCKER: %s\n' '<reason>'`
3. Re-run `kookr signal completion-ready`
