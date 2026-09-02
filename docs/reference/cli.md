# CLI Reference

Kookr exposes one public command-line entry point, `kookr`, with subcommands for launching tasks and inspecting a running instance. One further command, `kookr-self-report`, is not installed globally — the launcher puts it on a spawned agent's PATH.

Install them globally from a checkout:

```bash
pnpm build
pnpm link --global
```

If you linked Kookr before these commands existed, run `pnpm link --global` again. pnpm records bin symlinks at link time.

The standalone aliases `kookr-spawn`, `kookr-status`, and `kookr-ralph` still work for compatibility, but they are deprecated. Prefer the `kookr <subcommand>` forms below.

## Top-Level Flags

Print the installed package version:

```bash
kookr --version
kookr -v
```

Print root command help:

```bash
kookr --help
kookr -h
```

## Shell Completion

Print a static shell completion script:

```bash
source <(kookr completion bash)
```

```zsh
kookr completion zsh > "${fpath[1]}/_kookr"
```

The completion scripts cover the public `kookr` dispatcher commands, Ralph and maintenance subcommands, and command flags. They do not call the running Kookr server or complete dynamic task IDs.

## `kookr spawn`

Create a Kookr task from your current shell:

```bash
cd ~/git/my-project
kookr spawn "review the diff since origin/main and write a summary"
kookr spawn --json "review the diff since origin/main and write a summary"
```

The task uses `$PWD` as its working directory and appears in the dashboard immediately. Output starts with `task_id=<uuid>` for scripting.

Prompt sources:

```bash
kookr spawn "fix the auth bug"
cat prompt.md | kookr spawn
kookr spawn --prompt-file /tmp/prompt.md
```

`--prompt-file` is the safest form inside Claude Code sessions because hooks inspect the bash command line, not the file contents.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `-C`, `--cwd` | path | Current shell directory | Working directory for the task. Relative paths are resolved from the invoking process's cwd. |
| `-a`, `--agent` | `claude-code`, `codex-cli`, or `grok-build` | Server default | Agent type to launch for this task. |
| `--effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` | Kookr per-agent setting; Codex defaults to GPT-5.6 Sol with no effort override | Reasoning effort override for this task. `claude-code` accepts `low`, `medium`, `high`, `xhigh`, and `max`; `codex-cli` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; `grok-build` does not support effort — omit `--effort` (the server rejects any value). |
| `--model` | known Claude model id (e.g. `claude-fable-5`) | Agent CLI / env default | Pin the model for this task (#1518). `claude-code` accepts known Claude ids and dated suffixes; `codex-cli` / `grok-build` reject raw pins. Server returns 400 for invalid values. |
| `--model-tier` | `small` | unset | Request portable routine-work capacity without pinning an agent. Resolves after final agent choice to Haiku, Luna/high, or Grok 4.6. Codex requires the Kookr fork's per-task model capability and fails explicitly when it is unavailable. Mutually exclusive with `--model` and `--effort`. |
| `--criteria` | text | unset | Acceptance criteria sent with the task request. This value is argv-exposed; use prompt files or stdin for hook-sensitive text. |
| `--dedupe` | `warn`, `block`, or `skip` | `warn` | Active duplicate-prompt handling. `warn` prompts interactively and blocks in non-interactive shells, `block` exits with code 5, and `skip` creates the task intentionally while suppressing duplicate-cluster findings. |
| `--idempotency-key` | opaque string, ≤200 chars | unset | Retry key (issue #1526). Re-running `kookr spawn` with the SAME key replays the earlier launch outcome instead of launching a second task. A replayed active-prompt duplicate repeats the warning and confirmation flow. |
| `--auto-idempotency` / `--no-auto-idempotency` | none | off (env-controlled) | When no `--idempotency-key` is given, derive one (`auto-<hash>`) from prompt, cwd, criteria, agent, effort, model, model tier, playbook path, and playbook scope. A client-timeout retry replays only when all inputs are unchanged (bounded by the server's configured rolling idempotency TTL, 24h by default — no calendar component). If any input can change between retries, pass an explicit `--idempotency-key` that encodes the logical intent instead. Also enabled by `KOOKR_SPAWN_AUTO_IDEMPOTENCY=1`; `--no-auto-idempotency` forces it off. No effect under `--dedupe=skip`; an explicit `--idempotency-key` always wins. |
| `--wait` | optional seconds via `--wait=<seconds>` | false | Poll until the spawned task raises `completion-ready` or reaches a terminal state. |
| `--parent-task-id` | task id | `KOOKR_TASK_ID` when set | Explicit parent task to link in the dashboard. Mutually exclusive with `--no-parent-task`. |
| `--no-parent-task` | none | false | Launch detached and ignore `KOOKR_TASK_ID`. Mutually exclusive with `--parent-task-id`. |
| `--unattended` | none | false | Mark the task autonomous: the spawned agent's settings deny interactive tools (`AskUserQuestion` and equivalents) so a blocking call fails fast and flags the task **operator-needed** instead of hanging with nobody to answer (issue #1562). |
| `--playbook` | playbook path | unset | Wrap the resolved prompt with a playbook before launch. The playbook must declare a required `prompt` parameter and use `{{prompt}}` in its body. Kookr reads delivery policy from the playbook's metadata rather than accepting a client-side delivery toggle. Requires either `--idempotency-key` or auto-idempotency so an ambiguous launch can be reconciled safely. |
| `--playbook-scope` | `project`, `user`, or `plugin` | `project` | Select the playbook collection searched by `--playbook`: the current project's `.kookr/playbooks`, the user's playbooks, or the installed plugin. Requires `--playbook`. |
| `-f`, `--prompt-file` | path | unset | Read the prompt from a file instead of positional argv or stdin. |
| `--dry-run` | none | false | Validate discovery, resolve the prompt/cwd/idempotency key, run the read-only active-duplicate check, print the would-be `POST /api/tasks` body, and exit **without launching**. Exit codes match a real spawn for discovery failures and blocked duplicates (including exit 5). With `--json`, the envelope uses `code: "DRY_RUN"` on success. |
| `-h`, `--help` | none | false | Print command help and exit. |

For example, this reads the phase specification from a file, wraps it with the
installed plugin's guarded delivery procedure, and launches the resulting task:

```bash
kookr spawn --prompt-file /tmp/phase.md \
  --playbook architecture-refactor-phase.md --playbook-scope plugin \
  --idempotency-key "chain:owner/repo:42:phase:P1" --unattended
```

Wait for readiness:

```bash
kookr spawn --wait --prompt-file /tmp/prompt.md
kookr spawn --wait=600 "implement the issue and signal completion-ready"
```

`--wait` keeps the initial `task_id=<uuid>` output, then polls the existing read APIs (`/api/snapshot` for task state, `/api/tasks` for the pending completion signal) until the task raises `completion-ready` or reaches a terminal state. `--wait=<seconds>` bounds the wait. A `completion-ready` signal or `completed` task exits 0. `cancelled` and `terminated` unblock the wait and exit 4. A timeout exits 6.

Duplicate prompt handling:

```bash
kookr spawn --dedupe=warn "fix the auth bug"   # default: prompt on active duplicate; blocks when non-interactive
kookr spawn --dedupe=block "fix the auth bug"  # exit 5 on active duplicate
kookr spawn --dedupe=skip "fix the auth bug"   # create intentionally and suppress duplicate-cluster findings
```

In interactive `warn` mode, `show diff` prints the stored active prompt against the requested prompt before asking again.

In `--json` mode, duplicate `warn` prompts are treated as non-interactive and return `DUPLICATE_BLOCKED` instead of asking for confirmation. Use `--dedupe=skip --json` when automation intentionally wants to keep a duplicate.

Dry-run preview (issue #1768):

```bash
kookr spawn --dry-run "fix the auth bug"
kookr spawn --dry-run --json --dedupe=block --prompt-file /tmp/prompt.md
```

`--dry-run` discovers the instance, resolves the prompt source and cwd, applies auto-idempotency the same way a real spawn would, runs a **read-only** `GET /api/tasks` duplicate check, prints the would-be POST body, and exits without `POST /api/tasks`. Use it to debug discovery ambiguity (exit 3), inspect the resolved payload, or check whether `--dedupe=block` would refuse a launch (exit 5) before creating a task.

Idempotent retries (issue #1526):

```bash
kookr spawn --idempotency-key "kookr-ai/kookr#1526@batch-1" "implement the issue"
```

`--dedupe` compares prompt **content** (prompt + cwd + agent); it is defeated
when the prompt varies between attempts — for example a spawn helper that
embeds a fresh random branch suffix on every call. `--idempotency-key`
instead identifies the logical **request**: re-running the exact same
`kookr spawn --idempotency-key <key> ...` invocation (e.g. after a client
timeout against an overloaded server that had already created the task)
returns the SAME task instead of creating a duplicate, regardless of prompt
content. If the original request found an active prompt duplicate, a replay
preserves that result so interactive confirmation can resume after a client
restart. The confirmed launch uses its own stable key. A terminal task that
never actually ran (e.g. queued at capacity, then reaped before it ever
launched) is not replayed — the retry launches fresh instead; a terminal task
that did run (completed or was terminated
after starting an agent) is still replayed. A created-task replay prints `↺
Task already exists (idempotent replay)` instead of `✓ Task created`, exits
`0`, and (in `--json` mode) sets `details.idempotentReplay: true`. A replayed
prompt duplicate repeats the warning; confirmation derives a separate stable
key so a timeout during the intentional duplicate launch can be reconciled
safely. Reservations live in a TTL-bounded ledger on the server (24h by
default; configurable in settings).
Durability is best-effort, not absolute: a crash strictly between task creation
and the ledger write can lose that one reservation, and a ledger persist
failure is logged server-side without failing the request — see
[`POST /api/tasks` body fields](./api.md#post-apitasks-body-fields) for the full
server-side
contract and caveats.

Auto-close on completion signal:

```bash
kookr spawn --auto-close-on-signal "implement issue #42 then signal completion-ready"
kookr spawn --no-auto-close-on-signal "..."   # opt out of an inherited policy
```

With `--auto-close-on-signal`, the task auto-completes after its `kookr signal completion-ready` signal has been pending for the configured Auto-close delay (the `autoCloseCompletionReadyDelayMin` setting, default 30 minutes), instead of waiting indefinitely for manual review — freeing an active slot so queued tasks can run. If the flag is omitted, the new task **inherits the policy of its parent task** (the `parentTaskId` linkage, which `kookr spawn` sets from `KOOKR_TASK_ID` by default). That makes the policy propagate automatically down a self-continuation chain. Pass `--no-auto-close-on-signal` to opt a successor out of an inherited policy. See [auto-close-on-signal](./auto-close-on-signal.md).

## Hook-Safe Prompts

Claude Code PreToolUse hooks may block commands whose argv contains strings such as `gh pr create`, `git push --force`, or `rm -rf`.

Hook-safe:

```bash
kookr spawn --prompt-file /tmp/prompt.md
cat /tmp/prompt.md | kookr spawn
```

Not hook-safe:

```bash
kookr spawn "please gh pr create for this branch"
kookr spawn --criteria "ensure gh pr create succeeds"
```

## Dense Supervision From The Shell

For multi-agent sessions, keep long prompts and command-heavy task descriptions in files:

```bash
kookr spawn --prompt-file /tmp/prompt.md
```

This keeps the shell command short, avoids hook false positives, and leaves the dashboard as the main supervision surface. After spawning several tasks, use `kookr status` for a quick terminal snapshot and use the dashboard's dense-supervision controls for routing: `Alt+N` for the next finding, `Alt+T` for desktop terminal focus mode, `Alt+P` for the project sidebar, and `?` for the full shortcut list.

## `kookr-self-report`

On the PATH of every Kookr-spawned agent (alongside the `kb` shim). It exists for the case where the agent cannot do its job because of something upstream of the work itself — most often a task prompt that arrived damaged.

```bash
kookr-self-report "the prompt stops mid-sentence after 'not in'"
kookr-self-report --kind environment_broken "the worktree has no origin remote"
```

`--kind` is one of `prompt_unusable` (the default), `environment_broken`, or `other`. Identity and endpoint come from the session environment (`KOOKR_AGENT_ID`, `KOOKR_API_BASE_URL`), so there is nothing to look up or quote.

The report becomes an operational alert: broadcast to the dashboard live and appended to `operational-alerts.jsonl`. It is evidence for an operator, not a remediation trigger — see `POST /api/self-report` in [the API reference](api.md).

Exit codes: `0` recorded, `1` the server was unreachable or refused the report, `2` bad usage (missing detail, unknown `--kind`, or not running inside a Kookr session).

## `kookr signal`

Raise a non-blocking agent -> user signal for the current Kookr task:

```bash
kookr signal completion-ready
kookr signal completion-ready --note "tests green, PR opened"
kookr signal completion-ready --task-id <taskId>
```

The `completion-ready` signal tells Kookr that the agent believes the task is
ready for the user to complete. By default it does not complete or stop the task
by itself; the user still decides what to do in the dashboard.

**Exception — auto-close.** If the task was launched with the `autoCloseOnSignal`
policy (via `kookr spawn --auto-close-on-signal`, an `autoCloseOnSignal: true`
playbook, or inherited from a parent task), a `completion-ready` signal starts
the configured auto-close grace period (the **Auto-close delay** setting, default
30 minutes). If the task is still in progress after that,
Kookr completes it and frees its active slot. Only signal when work is truly
finished — under auto-close the task can close later without another prompt. See
[auto-close-on-signal](./auto-close-on-signal.md).

**Durability (issue #1541).** Every signal is write-behined to a local outbox
(`~/.kookr/playbook-state/signal-outbox/`) *before* the HTTP attempt, with a
client-generated `signalId` for server-side dedup. If the daemon is restarting
or unreachable the command still exits `0` (signal spooled); a background drain
delivers it after reconnect. See [signal-outbox](./signal-outbox.md).

Kinds:

- `completion-ready` - tell the user this task appears ready to complete.

Options:

- `--note <text>` - attach optional context. The server best-effort redacts
  secrets and visibly truncates over-limit notes.
- `--task-id <uuid>` - target a specific task. Defaults to `KOOKR_TASK_ID`,
  which Kookr injects into managed agent sessions.

Hook scripts can use the command after their own readiness checks:

```bash
if pnpm test; then
  kookr signal completion-ready --note "tests passed"
fi
```

Target selection uses the same local-server discovery as `kookr spawn`: first
`KOOKR_API_BASE_URL`, then `KOOKR_PORT`, then local ports `4800` and `4801`.

Exit behavior:

- `0` when the signal is raised **or** durably spooled because the daemon was
  unreachable (JSON envelope uses `code: "SPOOLED"` in the offline case).
- `2` for usage errors, including an unknown signal kind, a missing task id,
  bad flags, or an invalid `KOOKR_PORT`.
- `4` when the server permanently rejects the signal: unknown/terminal task id,
  missing post-task lesson decision (`lesson_decision_required`, issue #1538) or
  all hook logs missing (`lesson_decision_hooks_missing`, issue #1868),
  **or** merge authority with an open unmerged PR (`merge_required`, issue
  #1836). Permanent failures are dropped from the outbox. For the lesson gate
  the CLI prints the server hint and asks you to run `kb remember …` or
  `printf 'No generic KB lesson: %s\n' '<reason>'` before re-signaling; JSON
  mode reports `code: "LESSON_DECISION_REQUIRED"` or
  `"LESSON_DECISION_HOOKS_MISSING"`. For the merge gate: merge the
  PR (`gh pr merge` / `pnpm merge`, with `mergedAt` non-null) or
  `printf 'PR-BLOCKER: %s\n' '<reason>'`, then re-signal.

**Lesson decision (required before completion-ready).** Agents must leave either
a `kb remember` write or an explicit skip marker in the Bash hook trail before
signaling. See [lesson-decision-gate](./lesson-decision-gate.md).

**Merge required (when merge authority was granted).** Child tasks launched under
`mergeAfterImplementation=true` / the TERMINAL-STATE CONTRACT cannot raise
`completion_ready` after opening a PR unless the PR is verified merged or a
`PR-BLOCKER:` marker is in the hook trail. See
[merge-required-gate](./merge-required-gate.md).

## `kookr lesson`

Operator CLI for the durable lesson-write spool (issue #1519) and the lesson
yield metric (issue #1538):

```bash
kookr lesson status [--json] [--dir PATH]
kookr lesson drain  [--json] [--dir PATH] [--dry-run]
kookr lesson remember --title=<title> [--kb=agent-task-lessons] --stdin --yes
kookr lesson yield    [--json] [--days N] [--kookr-dir PATH]
```

- `status` / `drain` / `remember` — spool health, replay, and write-behind when
  KB is degraded. See [lesson-write-spool](./lesson-write-spool.md).
- `yield` — scan recent completed tasks' hook logs and print the lesson-yield
  rate (`(wrote-lesson + explicit-skip) / completed`). Same metric as
  `GET /api/diagnostics/lesson-yield?days=N` and the `lessonYield` block on
  `GET /api/health`. See [lesson-decision-gate](./lesson-decision-gate.md).

## `kookr effort-split`

Daily-report helper for the operator's 80/20 output split (issue #1718): measure
share of non-merge commits, merged PRs, and lines changed between a primary repo
(default `jeanibarz/lucy`) and a secondary repo (default `kookr-ai/kookr`).

```bash
kookr effort-split [--json] [--window-hours N] [--repo owner/name]...
                   [--primary owner/name] [--secondary owner/name]
                   [--min-share N] [--max-share N]
                   [--kookr-dir PATH] [--path PATH] [--no-persist] [--date YYYY-MM-DD]
```

- Data source is `gh` only (merged PRs via `gh pr list`, commits via
  `gh api repos/.../commits`). The contribution ledger is never read.
- Prints an "Effort split vs 80/20" section for the Discord daily report, with a
  prominent `DEVIATION` warning when the secondary share on any metric falls
  outside the band (default 5%–35%, i.e. 20% ± 15pt). Configurable via
  `--min-share` / `--max-share` or `KOOKR_EFFORT_SPLIT_MIN` /
  `KOOKR_EFFORT_SPLIT_MAX`.
- Persists one JSONL row per UTC day to `~/.kookr/effort-split.jsonl`; same-day
  re-run overwrites rather than appending a duplicate.

The Lucy daily-progress-report playbook should run this command in its gather
phase and paste the printed section into the digest.

## `kookr emission`

Drain-coupled issue-filing budget + mandatory dedupe (issues #1607, #1657,
#1703). Playbooks (idea-scout, architecture-health-check, reflection/retro)
call these verbs **before** any `gh issue create` so open backlog, drain rate,
and CI-blind-merge debt cap how many new issues a run may file. Pure budget /
dedupe math lives in `src/core/emission-budget.ts`; the CLI shells out to `gh`
for live counts and writes deferred-ideas JSONL under `~/.kookr`.

Repositories without an explicit zero-drain allowance default to `-1`
(unlimited). If `KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT=N` is configured, an unset
repository defaults to `N` instead. Explicit `0` keeps zero-drain emission off.

```bash
kookr emission plan    --repo owner/repo --requested N [OPTIONS]
kookr emission override --repo owner/repo --requested N --count N \
  --reason "Operator justification" --expires-at ISO --override-id UUID [OPTIONS]
kookr emission dedupe  --repo owner/repo --title "..." [OPTIONS]
kookr emission metrics --repo owner/repo [OPTIONS]
kookr emission defer   --repo owner/repo --title "..." --source <playbook> [OPTIONS]
kookr emission version [--repo-dir PATH] [OPTIONS]
```

| Verb | Purpose |
| --- | --- |
| **plan** | Resolve how many new issues this run may file given live open backlog, the target repo's drain rate (closed issues in the window, #1657), and the retro-verify / `ci_blind_debt` queue depth (#1703). |
| **override** | Run one authorized, single-use plan that may replace an explicit zero-drain cap of `0` with a bounded batch budget. It does not modify project settings or bypass other gates. |
| **dedupe** | Mandatory pre-filing duplicate check against open issues; always prints a log line. |
| **metrics** | Open backlog + 7-day `netBacklogDelta7d` + `ci_blind_debt` + budget snapshot (daily-report path). |
| **defer** | Append a candidate to the deferred-ideas JSONL instead of filing. |
| **version** | Report the running budget-logic schema version and warn if it lags `origin/main`. |

### Common flags

| Flag | Used by | Meaning |
| --- | --- | --- |
| `--repo <owner/repo>` | plan, override, dedupe, metrics, defer | Target GitHub repository (required). |
| `--requested <N>` | plan, override | How many issues this run wants to file. |
| `--count <N>` | override | Positive batch size, hard-capped at `10`. |
| `--reason <text>` | override, defer | Override justification (10-500 characters) or defer reason. Override reasons are recorded in the audit stream. |
| `--expires-at <ISO>` | override | Canonical UTC expiry in the future and no more than 15 minutes after invocation. |
| `--override-id <UUID>` | override, dedupe, defer | Required single-use invocation ID for the override; pass the same ID to every candidate's dedupe or defer call so the audit stream stays bound to the batch. |
| `--title <text>` | dedupe, defer | Candidate issue title. |
| `--source <name>` | defer | Emitting playbook id. |
| `--threshold <N>` | plan, override | Open-backlog threshold before the constrained budget applies. |
| `--constrained <N>` | plan, override | Budget when over the open-backlog threshold. |
| `--drain-window <N>` | plan, override | Drain-rate window in days. |
| `--drain-ratio <N>` | plan, override | New issues earned per drained issue. |
| `--drain-floor <N>` | plan, override | Compatibility option; must remain `-1`. Configure a repository's zero-drain allowance in Kookr project settings. |
| `--retro-verify-threshold <N>` | plan, override | Queue depth at/above which emission is withheld (default `0` = any pending debt). |
| `--no-retro-verify-coupling` | plan, override | Disable the `ci_blind_debt` gate (do not read the queue). |
| `--tolerance-blocker <type:scope>` | plan, override | Refuse emission when that external blocker already has a tolerance regime (#1702). |
| `--body-preview <text>` | defer | Optional body snippet stored on defer. |
| `--kookr-dir <PATH>` | plan, override, dedupe, defer | State root for project configuration, override audit, and deferred ideas (default `~/.kookr`). |
| `--retro-verify-dir <PATH>` | plan, metrics | Override retro-verify queue dir (default `~/.kookr/playbook-state/retro-verify-queue` or `KOOKR_RETRO_VERIFY_QUEUE_DIR`). |
| `--repo-dir <PATH>` | version | Local checkout to compare against `origin/main`. |
| `--json` | all | Machine-readable envelope on stdout. |
| `-h, --help` | all | Show usage. |

### Environment

| Variable | Role |
| --- | --- |
| `GH_TOKEN` / `gh auth` | Required for live GitHub counts (`plan` / `override` / `dedupe` / `metrics`). |
| `KOOKR_RETRO_VERIFY_QUEUE_DIR` | Override retro-verify queue path (also used by `kookr retro-verify` and documented in [environment variables](./environment-variables.md)). |
| `KOOKR_EMISSION_OVERRIDE_SECRET` | Configured capability secret (at least 16 characters). Keep it out of command-line arguments and audit text. |
| `KOOKR_EMISSION_OVERRIDE_AUTHORIZATION` | Command-scoped capability presented by the operator. Unattended callers without this value are refused. |

### Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Success. |
| `2` | User/policy error (bad flags, missing authorization, replay, expired or inapplicable override). |
| `4` | GitHub query or durable audit/state write failed. |

### Bounded zero-drain operator override

The ordinary `plan` command remains fail-closed for a repository whose explicit
`zeroDrainIssueLimit` is `0`. An operator can authorize one exceptional batch
without changing that persistent policy:

```bash
OVERRIDE_ID=$(node -p "require('node:crypto').randomUUID()")
EXPIRES_AT=$(node -p "new Date(Date.now() + 10 * 60 * 1000).toISOString()")
read -r -s -p "Emission override authorization: " KOOKR_EMISSION_OVERRIDE_AUTHORIZATION
export KOOKR_EMISSION_OVERRIDE_AUTHORIZATION
PLAN=$(kookr emission override --repo owner/repo --requested 10 --count 10 \
  --reason "File the operator-reviewed maintenance planning batch" \
  --expires-at "$EXPIRES_AT" --override-id "$OVERRIDE_ID" --json)
unset KOOKR_EMISSION_OVERRIDE_AUTHORIZATION
```

`KOOKR_EMISSION_OVERRIDE_SECRET` must already be exported into the CLI process
(for example by the operator's secure shell wrapper). The CLI compares the command-scoped authorization in constant time and
never persists either value. Automation cannot use `override` unless the
operator deliberately gives that invocation the capability.

The returned `allowedBudget` is at most the requested count, the override count
(`10` maximum), and the backlog-derived budget. The override applies only when
the live drain count is zero and the effective repository zero-drain limit is
exactly `0`; retro-verify debt and tolerance-regime refusals still force the
effective budget to zero.

Every candidate, including a likely duplicate, must run the existing dedupe
gate with the batch ID before filing:

```bash
kookr emission dedupe --repo owner/repo --title "Candidate title" \
  --override-id "$OVERRIDE_ID" --json
```

Override decisions, dedupe results, and deferred candidates append to
`~/.kookr/playbook-state/emission-metrics/emission-audit.jsonl`. The single-use
claim/result lives under `emission-metrics/operator-overrides/`. Claim creation
uses exclusive file creation, so concurrent or replayed commands with the same
UUID are refused. A live-query failure burns the claim; an audit-write failure
fails closed; and dedupe refuses a granted batch after its expiry.

Recovery is intentionally additive: inspect the audit and claim record, correct
the cause, then issue a new short-lived override with a new UUID and a reason
that explains the retry. Do not delete or edit the old record—its consumed or
refused state is the replay/audit evidence.

When `plan` withholds the budget because retro-verify depth exceeds the
threshold, the JSON envelope sets `emissionBudgetIfRequestedN.allowedBudget=0`
and `retroVerifyWithheld=true`, with a note pointing at
`kookr retro-verify drain`. Related metrics also appear on `GET /api/health`
(`ciBlindDebt` / `ci_blind_debt`) and `kookr status`.

## `kookr value-density`

Value-density governor for refactor-class / architecture-drift emission and
spawn (issue #1846). Caps cosmetic "share tinyHelper" consolidations so a
window of high PR count is not mostly vanity refactors while product-metric
work starves, and surfaces a composition metric the reflection can trend.

```bash
kookr value-density classify     --title "..." [--labels a,b] [--json]
kookr value-density admit        --title "..." --refactor-count N \
                                 [--drift-score-delta N] [--max-refactor N] \
                                 [--min-drift-delta N] [--json]
kookr value-density composition  --repo owner/repo [--window-hours N] \
                                 [--value-target N] [--no-persist] [--json]
kookr value-density decline      --repo owner/repo --title "..." \
                                 --source <playbook> --reason "..." \
                                 [--reason-code cosmetic_subthreshold] [--json]
```

- **classify** — map a title/labels to `workClass` + `cosmetic` +
  `productMetricBlocking` + `valueAdvancing`.
- **admit** — decide admit/decline for one candidate given the window's
  refactor-class admit count. Cosmetic consolidations without a
  `drift-score-delta` ≥ `--min-drift-delta` (default `1.0`) are declined;
  refactor-class admits are hard-capped at `--max-refactor` (default `4`) per
  window. Product-metric-blocking issues always admit.
- **composition** — classify merged PRs over the window via `gh`; print
  refactor share + value-advancing count. Persists one JSONL row per call under
  `~/.kookr/playbook-state/value-density/composition/` for trendability.
- **decline** — append a declined candidate to
  `~/.kookr/playbook-state/value-density/declined/<repo>.jsonl` so the next
  reflection can observe sub-threshold consolidations.

Architecture-health-check and orchestrators call `admit` before filing/spawning
refactor-class work, and `composition` from the daily workflow-reflection /
velocity gather phase. Pure math lives in `src/core/value-density-governor.ts`.

## `kookr queue-feeder`

Queue-feeder / umbrella auto-decomposer (issues #1845, #2044, #2069). When the
orchestration loop sees idle capacity with an empty queue (`free ≥ threshold`
**and** `pendingQueueDepth == 0` — the `idle_capacity` warn shape), it shreds
ONE eligible product umbrella into 3–5 spawnable leaf tasks (goal + acceptance
criteria + file/test hints). Umbrellas that already have **open** children are
skipped (idempotent — use those leaves first). **Closed children must not be
counted** in `openChildrenCount` (#2069); they do not permanently block
re-author when the product belt is empty. Product-metric-blocking umbrellas
rank above harness/internal ones so idle capacity flows to product outcomes.

When product umbrella leaves are exhausted but free slots remain:

1. **`invent-product-wave` (#2069)** — if `openProductMetricIssues=0` and an
   eligible product-metric umbrella has no open children and no curated plan,
   authorize a bounded next leaf batch (cap ≤3) under that umbrella. Prefer
   this over idea-scout residual so free slots refill the product belt.
2. **Secondary path (#2044)** — pull open, **unassigned** idea-scout /
   ready-labeled issues into the implementable set (cap ≤3 per fire; never
   auto-claim assignees).
3. Else shred a residual umbrella that still has a curated leaf plan (primary
   shred already covers plan-ready cases).
4. Only then `action=skip-invent` when no safe source exists.

Ledger rows carry `action` (`shred` | `invent-product-wave` | `emit-secondary` |
`skip-invent` | `not-triggered`) and `source` (`umbrella-shred` | `product-wave` |
`idea-scout` | `curated-umbrella` | null) for reflection audit.

```bash
kookr queue-feeder plan --input <file|-> [--free N] [--pending N] \
                        [--free-threshold N] [--emit] [--no-persist] [--json]
kookr queue-feeder leaves --umbrella owner/repo#N [--json]
```

- **plan** — read a capacity + umbrella snapshot, decide which ONE umbrella to
  decompose (or which ready issues to secondary-emit), and print the dry-run
  plan. The snapshot JSON is
  `{ "capacity": { "free": N, "pendingQueueDepth": N }, "candidates": [ { "repo":
  "owner/repo", "number": N, "title": "...", "labels": [...],
  "openChildrenCount": N } ], "readyIssues": [ { "repo", "number", "title",
  "labels", "assignees" } ], "openProductMetricIssues": N }` from
  `--input <file>` or `-` for stdin. Appends one observability row per call to
  `~/.kookr/playbook-state/queue-feeder/decisions.jsonl` (skip with
  `--no-persist`). **Dry-run by default** — `--emit` (opt-in) files leaf issues
  via `gh issue create` for `action=shred` only. **Idempotent by title** — a
  leaf whose title already exists as an OPEN or CLOSED issue in the umbrella
  repo is skipped, the existing ref reused and recorded in the ledger's
  `skipped[]`, so an already-landed leaf is not re-filed (#2120). Secondary
  ready-issue emit never creates issues (they already exist) and never claims
  assignees.
- **leaves** — print the rendered GitHub issue bodies (goal + acceptance
  criteria + hints + backref) for a curated umbrella's leaf plan.

Exit codes: `0` success · `2` bad flags / unparseable input · `4` `gh issue
create` failed during `--emit`. Pure decision logic lives in
`src/core/umbrella-decomposer.ts`; product-metric detection is shared with the
value-density governor.

## `kookr reflect`

Phase-1 instrumentation for the daily workflow-reflection loop (issue #1751).
The reflection is the harness's only self-steering instrument; before this
command it ran on ~18h-stale hand-assembled data (the daily-report markdown plus
manual `gh` queries). Two verbs replace those two stale/manual steps with a
single call each.

```bash
kookr reflect outcomes [--json] [--window 24h|7d|30d|all]
kookr reflect ideas    [--json] [--log PATH] [--runs N]
```

### `outcomes`

A live 24h task-outcome tally — ran / completed / terminated (≈failed) /
cancelled / active, plus completion rate, tasks-with-PR, verified count,
feedback, and known cost. It is a compact projection of the running server's
`/api/outcome-ledger` scoreboard (`window` maps straight through), so the
reflection no longer falls back to parsing the daily-report markdown.

- Server discovery matches `kookr status`: `KOOKR_API_BASE_URL`, else
  `KOOKR_PORT`, else auto-probe `4800, 4801`. Honors `KOOKR_API_TOKEN`.
- `terminated` is surfaced as the "failed" bucket — Kookr has no distinct
  `failed` status; a died/aborted run is `terminated`, a user-stopped run is
  `cancelled`.
- Exit `0` on success, `1` when no server responds or the fetch fails, `2` on a
  bad `--window`.

### `ideas`

Resolves each prior `ideasFiled` URL recorded by the reflection to its current
GitHub state and prints a compact filed→shipped table:

```
  kookr#1702             filed 2026-07-30  → shipped by PR #1705
  kookr#1751             filed 2026-07-31  → open

2 filed · 1 shipped · 0 closed(unshipped) · 1 open · 0 unknown · ship-rate 50%
```

- Reads the reflection log (default
  `~/.kookr/playbook-state/lucy/workflow-reflection/log.jsonl`), whose records
  are `{"date","directionVerdict","ideasFiled":[url…],"topFriction"}`.
- `--runs N` resolves URLs from the last N reflection runs (default `1`,
  de-duped keeping the earliest filed date). State is resolved via
  `gh api graphql` (`closedByPullRequestsReferences`): a merged closing PR ⇒
  `shipped-by-PR#`, closed without one ⇒ `closed (unshipped)`, else `open`.
- Cross-repo URLs (e.g. `jeanibarz/lucy`) resolve against their own repo. A
  missing log is treated as a first run (empty table, exit `0`), and individual
  unreachable issues degrade to `unknown` rather than failing the whole table.

The workflow-reflection playbook's Phase 1 should call `kookr reflect outcomes
--json` and `kookr reflect ideas --json` instead of the stale-markdown fallback
and per-run manual `gh` queries.

## `kookr retro-verify`

CI-blind-merge debt + retro-verify drain (issues #1689, #1703). Merges made
while CI was signal-absent (or only verified locally) are enqueued as durable
JSONL under the retro-verify queue. Queue depth is the first-class
`ci_blind_debt` metric: when it is non-zero, `kookr emission plan` withholds
new feature-issue filings until operators burst-drain the queue. Core queue
logic lives in `src/core/retro-verify-queue.ts`; debt aggregation is in
`src/core/ci-blind-debt.ts`.

```bash
kookr retro-verify status  [--json] [--dir PATH]
kookr retro-verify drain   [--json] [--dir PATH] [--limit N] [--dry-run] \
                           [--repo-dir PATH] [--verify-cmd <shell>]
kookr retro-verify enqueue --sha <sha> --repo owner/repo \
                           [--pr N] [--reason <text>] [--dir PATH] [--json]
```

| Verb | Purpose |
| --- | --- |
| **status** | Print the `ci_blind_debt` metric (blind-merge count + queue depth). Same signal as `GET /api/health` → `ciBlindDebt` and `kookr emission metrics`. |
| **drain** | Burst-drain the queue: re-verify each entry; on fail file a P1 issue via `gh issue create`. |
| **enqueue** | Record a merge made under a CI-signal-absent regime (or verified-locally). |

### Common flags

| Flag | Used by | Meaning |
| --- | --- | --- |
| `--dir PATH` | all | Queue directory (default `~/.kookr/playbook-state/retro-verify-queue` or `KOOKR_RETRO_VERIFY_QUEUE_DIR`). |
| `--sha <sha>` | enqueue | Commit SHA to enqueue. |
| `--repo <owner/repo>` | enqueue | Repository the commit belongs to (also labels P1s on drain failure). |
| `--pr <N>` | enqueue | PR number that merged the commit (`0` when unknown). |
| `--reason <text>` | enqueue | Enqueue reason (default `verified-locally`). |
| `--limit <N>` | drain | Max entries to attempt this drain (default: all). |
| `--dry-run` | drain | Drain without calling verify / `fileP1`; report what would run. |
| `--repo-dir PATH` | drain | Local checkout used by the default local-suite verify. |
| `--verify-cmd <cmd>` | drain | Shell command that exits `0` on pass (overrides `--repo-dir` suite). |
| `--json` | all | Machine-readable envelope on stdout. |
| `-h, --help` | all | Show usage. |

### Environment

| Variable | Role |
| --- | --- |
| `KOOKR_RETRO_VERIFY_QUEUE_DIR` | Override queue path (shared with `kookr emission`; see [environment variables](./environment-variables.md)). |
| `GH_TOKEN` / `gh auth` | Required for P1 filing when a re-verify fails during `drain`. |

### Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Success. |
| `2` | User error (bad flags / missing required args). |
| `4` | Drain completed with one or more verification failures (P1 filed or pending). |

### Operator loop

When emission is withheld for CI-blind debt, drain first, then re-plan:

```bash
kookr retro-verify status --json
kookr retro-verify drain --json
kookr emission plan --repo owner/repo --requested 10 --json
```

`status` is safe to call from daily-report / reflection gather phases; it is a
cheap JSONL read of the spool (soft-empty when the directory is missing).

## `kookr issue`

Claim, release, or inspect GitHub-issue ownership (RFC `rfc-issue-ownership-lock`; the server side is flag-gated behind `KOOKR_ISSUE_CLAIMS`).

```bash
kookr issue claim <number> [--repo <owner/repo>] [--force] [--json]
kookr issue release <number> [--repo <owner/repo>] [--json]
kookr issue owner <number> [--repo <owner/repo>] [--json]
kookr issue list [--json]
```

`--repo` is optional; the server resolves the issue's home repo from the caller's cwd (fork-aware — a fork checkout with no `--repo` fails closed). `--task-id` sets the claiming task id (default `KOOKR_TASK_ID`; required for claim/release). `--force` is an operator override that takes over a held claim. `KOOKR_AGENT_ID`, when set, is sent as the claiming session id.

Exit codes (specific to `kookr issue`): `0` you own it — also returned when the server does not support issue claims yet (HTTP 404: proceed as pre-lock); `2` user error; `3` no server reachable (fail closed — do not start work on the issue); `4` server rejected the request (unknown/terminal task, release by a non-owner); `6` claim held by another live task — pick a different issue, or `--force` as an operator.

## Server Discovery

`kookr spawn`, `kookr signal`, `kookr status`, `kookr ops`, and `kookr github` discover the active Kookr instance with this precedence:

1. `KOOKR_API_BASE_URL`
2. `KOOKR_PORT`
3. Probe local ports `4800` and `4801`

Ambiguity handling differs by command family: `kookr spawn` / `kookr signal` / `kookr ralph` exit with an ambiguity error when both default ports respond and no explicit target is set. `kookr status`, `kookr ops`, and `kookr github` pick the first healthy port (`4800`, then `4801`).

## JSON Output

`kookr spawn`, `kookr status`, `kookr ops digest`, `kookr ops timers`, `kookr ralph` (and their deprecated standalone aliases), and `kookr github` accept `--json`. JSON mode prints exactly one envelope to stdout and suppresses human-oriented output:

```json
{
  "ok": true,
  "code": "OK",
  "message": "Task created",
  "details": {}
}
```

The envelope fields are:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` for successful command outcomes, `false` for failures. |
| `code` | string | Stable symbolic result code, such as `OK`, `OK_DEGRADED`, `USER_ERROR`, `NO_SERVER`, `SERVER_ERROR`, or `DUPLICATE_BLOCKED`. |
| `message` | string | Short human-readable summary of the outcome. |
| `details` | object | Command-specific structured data. |

`kookr status` exits `1` for invalid ports, unreachable servers, and an unexpected `/api/health` response; in JSON mode its `code` distinguishes `USER_ERROR`, `NO_SERVER`, and `SERVER_ERROR` while preserving that numeric behavior. A slow, unreachable, or malformed `/api/snapshot` is non-fatal: without a failed `--require-ready` gate, the command exits `0` with `code: "OK_DEGRADED"` and a `details.degraded` block (issue #2848). When `kookr status --fail-on <severity>` finds an active finding at or above the threshold, it exits `5` and JSON mode returns `code: "FINDINGS_PRESENT"`. When `--require-ready` cannot confirm readiness, it instead exits `6` with `code: "READINESS_FAILED"`; degraded snapshot details remain available in that response.

`kookr status --json` always emits one complete JSON document. A size limit of 80 KiB is applied *before* serialization (override with `KOOKR_STATUS_JSON_MAX_BYTES`): large collections such as `details.agents` and `details.summary.findings` are shortened structurally, and `details.truncation` reports each shortened collection with `truncated`, `originalCount`, and `returnedCount`. Capacity, queue depth, outcome counts, and envelope metadata stay complete. Oversized strings are capped so a single field cannot make the document invalid. The serialized byte stream is never sliced. Human-readable `kookr status` preserves the existing report and adds a compact `Readiness:` line.

Examples:

```bash
kookr spawn --json --prompt-file /tmp/prompt.md
kookr status --json
kookr ops digest --json
kookr ops timers --json
kookr github status --json
kookr ralph status <taskId> --json
```

## Exit Codes

Exit codes are stable for scripts, but **not all verbs share one table**. Branch on the command family below — treating every `2` as “user error” is wrong for `kookr pr-checklist`.

### `kookr spawn` / `kookr ralph` (and deprecated aliases)

| Exit code | Name | Meaning | Commands |
| --- | --- | --- | --- |
| exit 0 | Success | The command completed successfully. | `kookr spawn`, `kookr ralph` |
| exit 2 | User error | Invalid arguments, missing required input, or another local usage error. | `kookr spawn`, `kookr ralph` |
| exit 3 | No server | No Kookr server was reachable, or default-port discovery found multiple possible instances. | `kookr spawn`, `kookr ralph` |
| exit 4 | Server error | The server rejected the request or returned an unexpected failure. | `kookr spawn`, `kookr ralph` |
| exit 5 | Duplicate blocked | Task creation was blocked by duplicate-prompt handling, such as `--dedupe=block` or non-interactive `--dedupe=warn`. | `kookr spawn` |
| exit 6 | Wait timeout | `kookr spawn --wait=<seconds>` timed out before the task reached `completion-ready` or a terminal state. | `kookr spawn` |

The deprecated `kookr-spawn` and `kookr-ralph` aliases return the same codes as their `kookr <subcommand>` forms.

### `kookr doctor`

| Exit code | Meaning |
| --- | --- |
| exit 0 | All required checks passed (`ok` may still include advisory `warn` checks unless `--strict`). |
| exit 1 | One or more required checks failed (`ok: false` in the JSON report), or `--strict` with any advisory `warn`. |
| exit 2 | Usage error (unknown flag). |

### `kookr logs`

| Exit code | Meaning |
| --- | --- |
| exit 0 | Records printed, or the task exists but has no hook activity yet. |
| exit 1 | Argument matches neither a known task nor an existing hook log. |
| exit 2 | Usage error (unknown option, non-positive `--lines`, missing/extra args). |

### `kookr maintenance` (`prune` / `backup`)

| Exit code | Meaning |
| --- | --- |
| exit 0 | Prune or backup succeeded. |
| exit 1 | Operation failed (e.g. data directory unreadable, backup archive already exists). |
| exit 2 | Usage error (unknown flag, missing verb, invalid option values). |

### `kookr pr-checklist` (sysexits-style — **do not reuse the spawn/ralph meaning of 2**)

| Exit code | Meaning |
| --- | --- |
| exit 0 | Pass (verify succeeded, or doctor completed). |
| exit **2** | **Verification failure** (checklist findings or fail-closed repo-input error) — **not** a usage error. |
| exit 64 | Usage error (bad arguments, unknown subcommand). |
| exit 70 | Kookr-internal fault (the only class a local hook may treat as fail-open). |

Callers that wire `kookr pr-checklist verify` into CI must treat exit `2` as “gate failed — fix the PR”, not “retry with better args”.

### `kookr github`

| Exit code | Meaning |
| --- | --- |
| exit 0 | Success — scanner status printed (human line or JSON envelope). |
| exit 2 | User error (unknown flag / unknown verb / missing verb / invalid `KOOKR_PORT`). |
| exit 3 | No Kookr server reachable. |
| exit 4 | Server rejected the request or returned an unexpected `/api/github/status` payload. |

## `kookr status`

Print a read-only snapshot of the running Kookr instance:

```bash
kookr status
kookr status --fail-on critical
kookr status --require-ready
kookr status --json
pnpm status
```

The command requires `/api/health` and reads both the readiness verdict `/api/ready` and the full event snapshot `/api/snapshot` when available, then reports readiness, server uptime, build version, and per-agent severity counts. Human output prints a compact readiness line; `--json` includes `details.readiness` with `status` (`ready`, `not-ready`, or `unavailable`), the HTTP status, and the endpoint's check map when available. Readiness is observational by default so existing scripts keep their exit behavior; `--require-ready` opts into a fail-closed readiness gate for not-ready, unavailable, or malformed readiness responses. If the full event snapshot is slow, unreachable, or malformed, the command **degrades to a bounded fast path** built from `/api/health` plus the compact task list (`/api/tasks?view=compact`): it stays `ok` unless `--require-ready` fails, emits `code: "OK_DEGRADED"`, reports task-outcome counts and cost in place of per-agent/finding detail, marks findings unavailable, and adds a `details.degraded` block naming each omitted/stale source with its status, reason, last-good freshness, and returned/original counts (issue #2848). Capacity, utilization, queue depth, pause state, and server freshness come from `/api/health`, so they remain present on the degraded path. It also surfaces health-derived operator lines when present: `SAFE MODE`, `CI-blind debt`, — when the issue belt is starved — one `Pipeline starvation: <repo> blockedEmpty=<n>` line per elevated repo (mirroring `/api/health` → `pipelineStarvation`), — when host-wide process leaks are elevated — one `Stale processes: dtach=<n> rss=<human>` line (and/or `relayServer=…`) mirroring `/api/health` → `staleProcesses` (issue #2209), always-on `Payload diet: tracked=<n> terminal=<n> snapshot=<human|none>` when `/api/health` publishes `payloadDiet` (issue #2220), — when non-zero — one `Hook replay checkpoints: sessions=<n> file=<human>` line mirroring `/api/health` → `hookReplayCheckpoints` (issue #2281), always-on `Startup recovery: relaunched=<n>  skipped=<n>  failed=<n>  crashLoop=<n>` when `/api/health` publishes `startupRecovery` (issue #2351), and — when capacity pressure is elevated (phantoms, a large util gap, or high nominal utilization) — one `Capacity: active=<n>/<max> free=<n> … effectiveWorking=… phantom=…` line with byClass counters mirroring `/api/health` → `capacity` (issue #2234). Slim summaries land under `details.pipelineStarvation` / `details.staleProcesses` / `details.capacity` in `--json` only when elevated; `details.payloadDiet` is always present when the health block exists; `details.hookReplayCheckpoints` is present when health publishes a non-null object (including zeros); `details.startupRecovery` is present when health publishes the block (including zeros); zero/absent elevated gauges stay quiet on the human path.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--json` | none | false | Print one complete machine-readable JSON envelope to stdout. Large fleets are bounded structurally at 80 KiB (see JSON Output). |
| `--fail-on` | `critical`, `warning`, `info`, or `none` | `none` | Exit `5` when active findings meet or exceed the requested severity. `critical` fails only on critical findings; `warning` fails on warning or critical; `info` fails on any known active finding. |
| `--require-ready` | none | false | Exit `6` with `code: "READINESS_FAILED"` unless `/api/ready` returns a valid ready verdict. This gate takes precedence when combined with `--fail-on`; finding details remain in the output. |
| `-h`, `--help` | none | false | Print command help and exit. |

Exit behavior:

- `0` when the status snapshot is read successfully, no `--fail-on` threshold is met, and any `--require-ready` gate passes. This includes the degraded fast path (`code: "OK_DEGRADED"`) when `/api/health` is reachable but the full event snapshot is slow, unreachable, or malformed; on that path `--fail-on` cannot evaluate findings, so the gate does not fire and JSON reports `findingsEvaluated: false`.
- `1` for invalid `KOOKR_PORT`, unreachable servers, or an unexpected `/api/health` response (a bad `/api/snapshot` is non-fatal — see the degraded path above).
- `2` for usage errors such as an unknown argument or invalid `--fail-on` value.
- `5` when `--fail-on` is set and active findings meet or exceed the requested severity.
- `6` when `--require-ready` is set and readiness is not confirmed (not-ready, unavailable, or malformed response).

## `kookr ops digest`

Pasteable one-pager of top unattended failure signals for remote diagnosis (Discord/Lucy) — issue #2347. Complements the offline recovery card by turning the same field set into a single CLI.

```bash
kookr ops digest
kookr ops digest --json
kookr ops digest --offline
```

The command GETs [`/api/ready`](./api.md) and [`/api/health`](./api.md), then prints ready status plus up to five elevated warnings with field paths operators can re-query:

| Signal | Field path | When shown |
| --- | --- | --- |
| SAFE MODE engaged | `safeMode.engaged` | `true` |
| Host pressure while watchdog off | `resourceWatchdog.pressureWhileDisabled` | `true` |
| Phantom active capacity | `capacity.phantomActive` | `> 0` |
| Hung residual | `capacity.byClass.hungSuspect` | `> 0` |
| Helper-LLM provider paused / storms suppressed | `helperLlm.paused` or `helperLlm.stormsSuppressed` | a helper-LLM provider is in the auth cool-down, or the process-wide attempt budget has refused attempts (issue #2641) |
| Overdue or never-fired hourly timer | `timerHealth.overdue` | `timerHealth.overdue >= 1`, or an hourly loop has `lastFiredAt=null` and server uptime already exceeds that loop's own interval (issue #2637). Prefer `GET /api/health.timerHealth` when `overdue >= 1` or `loops[]` is present. A slim `{ overdue, neverFired }` summary is not enough — `neverFired` includes 24h prune — so digest fetches [`GET /api/diagnostics/timer-health`](./api.md) with a 2-second timeout |
| Hook-ingestion p95 lag | `hookIngestion.p95LagMs` | p95 strictly above 10 seconds (`HOOK_INGESTION_P95_WARN_MS`) |
| Fail-closed paused schedule | `schedules.schedulesPausedByFailure` | any paused row (`count >= 1`, not only when three are paused) |
| Pipeline starvation | `pipelineStarvation.repos.<repo>.consecutiveBlockedEmpty` | elevated repos |
| systemd watchdog not armed | `systemdNotifier.watchdogArmed` | `systemdNotifier.arming` is `absent` (no `NOTIFY_SOCKET`) or `notifier-only` (readiness armed, watchdog heartbeat not) — process-level watchdog integration is disabled, so a wedged service will not be externally restarted (issue #2853). The warning states that external unit status is unknown; when armed, a quiet `systemdNotifier.arming=watchdog-armed` line is printed instead |
| Low data-dir disk | `dataDirectory.diskFreePercent` (or legacy host/sampler aliases) | cached free percent is known and ≤15%; an explicit `dataDirectory.status: "unknown"` stays quiet |

Human output is ≤20 lines. With `--json`, stdout is one envelope (`code: "OK"` when ready, `code: "READY_FAIL"` when not) whose `details` holds the full snapshot (warnings, signals, failing critical checks).

### Offline degrade (`--offline`, issue #2495)

After each successful `/api/health` assembly the server mirrors a redacted, size-capped (≤32 KiB) copy of the body to `<kookrDir>/last-good-health.json` (rotate-by-overwrite, owner-only mode `0o600`, throttled to ~5s / on a gauge edge). When the HTTP surface is dark — a wedged loop, a bound-but-unresponsive port, or an operator reachable only over the relay — that file is the remote surface that still works.

`kookr ops digest --offline` skips HTTP entirely and reads that snapshot, printing how stale it is (`last-good: <age> stale  captured=<iso>`) plus the same warning set the live digest would surface, derived from the cached body. The live path *also* auto-degrades to the snapshot when the server is unreachable (`NO_SERVER` / `SERVER_ERROR`): the failing exit code is preserved, but the human output and `details.offline` still carry the cached body so a wedged box stays diagnosable.

The snapshot is located by `KOOKR_DIR` when set (authoritative), else the `KOOKR_PORT`-derived state dir (`~/.kookr` for `4800`, `~/.kookr-<port>` otherwise), else the newest of the two default-port dirs.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--json` | none | false | Print one machine-readable JSON envelope to stdout. |
| `--offline` | none | false | Skip HTTP and read the last-good `/api/health` snapshot from disk (issue #2495), reporting how stale it is. |
| `-h`, `--help` | none | false | Print command help and exit. |

Environment (server discovery — same precedence as [Server Discovery](#server-discovery)):

| Variable | Meaning |
| --- | --- |
| `KOOKR_API_BASE_URL` | Base URL of a running Kookr server (overrides auto-detect). |
| `KOOKR_PORT` | Specific port on `127.0.0.1` (overrides auto-detect). |
| `KOOKR_API_TOKEN` | Bearer token for non-loopback servers. |
| `KOOKR_DIR` | State dir holding `last-good-health.json` for the `--offline` path (authoritative when set). |

Exit behavior:

- `0` Ready (engine safe to supervise) — or, with `--offline`, the last-good snapshot was printed (`code: "OFFLINE_SNAPSHOT"`).
- `1` Ready failed (critical not-ready / HTTP 503).
- `2` User error (bad flags / unknown verb / invalid `KOOKR_PORT`).
- `3` No Kookr server reachable (with `details.offline` when a snapshot exists).
- `4` Server rejected `/api/health` or returned an unexpected payload (with `details.offline` when a snapshot exists).
- `6` `--offline` requested but no last-good snapshot exists on disk (`code: "NO_SNAPSHOT"`).

Related: [`kookr status`](#kookr-status) for agent-finding snapshots; [offline recovery card](./offline-recovery-card.md) and [unattended recovery runbook](./unattended-recovery-runbook.md) for the same field map in prose.

## `kookr ops timers`

Pasteable table of lifecycle-timer last-fired times and overdue flags (issue #2639). Complements [`kookr ops digest`](#kookr-ops-digest): digest answers "is the box ready?"; timers answers "did prune/save/watchdog actually tick?" without a second `curl` + `jq` of [`GET /api/diagnostics/timer-health`](./api.md).

```bash
kookr ops timers
kookr ops timers --json
```

The command prints every **registered** loop the server reported — name, last-fired ISO timestamp or `never`, expected interval in milliseconds, and `overdue` true/false. It does not invent names for loops the process did not start. `--offline` is digest-only: last-good health keeps the four-field `timerHealth` counts (issue #2636) but not the per-loop last-fired table this command prints. If no server is reachable the command exits `3` immediately. If a server is selected but `GET /api/diagnostics/timer-health` hangs, the fetch aborts after 5 seconds and also exits `3`.

Human output looks like:

```text
timers  loops=2  overdue=1  generated=2026-08-18T12:00:00.000Z
maintenancePrune  last=never  interval=3600000ms  overdue=true
save  last=2026-08-18T11:59:00.000Z  interval=30000ms  overdue=false
```

With `--json`, stdout is one envelope (`code: "OK"`) whose `details` holds the timer-health document (`schemaVersion`, `generatedAt`, `loops`), a computed `overdue` name list, and the resolved `baseUrl`.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--json` | none | false | Print one machine-readable JSON envelope to stdout. |
| `-h`, `--help` | none | false | Print command help and exit. |

Environment (server discovery — same precedence as [Server Discovery](#server-discovery)):

| Variable | Meaning |
| --- | --- |
| `KOOKR_API_BASE_URL` | Base URL of a running Kookr server (overrides auto-detect). |
| `KOOKR_PORT` | Specific port on `127.0.0.1` (overrides auto-detect). |
| `KOOKR_API_TOKEN` | Bearer token for non-loopback servers. |

Exit behavior:

- `0` Timer-health printed.
- `2` User error (bad flags / unknown verb / `--offline` / invalid `KOOKR_PORT`).
- `3` No Kookr server reachable, or the 5-second fetch timed out.
- `4` Server rejected `/api/diagnostics/timer-health` or returned an unexpected payload.

Related: [`kookr ops digest`](#kookr-ops-digest); [`GET /api/diagnostics/timer-health`](./api.md).

## `kookr github`

Print GitHub scanner liveness, remaining rate-limit backoff, and tracked-ref count — a thin terminal read-side for operators and spawned agents that need scanner health without opening the dashboard.

```bash
kookr github status
kookr github status --json
```

The command calls [`GET /api/github/status`](./api.md) (see the GitHub section there) and reports:

| Field | Meaning |
| --- | --- |
| `active` | Whether the GitHub scanner is currently live. |
| `stateFetchBackoffMs` | Remaining state-fetch rate-limit backoff in milliseconds. |
| `repoHealthBackoffMs` | Remaining repo-health rate-limit backoff in milliseconds. |
| `trackedRefCount` | Number of PR/issue refs currently tracked. |

Human output is one line:

```text
github scanner: active  state-fetch-backoff=0ms  repo-health-backoff=0ms  tracked-refs=12
```

With `--json`, stdout is one envelope whose `details` object holds the four fields above (`code: "OK"` on success; `USER_ERROR` / `NO_SERVER` / `SERVER_ERROR` on failure).

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--json` | none | false | Print one machine-readable JSON envelope to stdout. |
| `-h`, `--help` | none | false | Print command help and exit. |

Environment (server discovery — same precedence as [Server Discovery](#server-discovery)):

| Variable | Meaning |
| --- | --- |
| `KOOKR_API_BASE_URL` | Base URL of a running Kookr server (overrides auto-detect). |
| `KOOKR_PORT` | Specific port on `127.0.0.1` (overrides auto-detect). |
| `KOOKR_API_TOKEN` | Bearer token for non-loopback servers. |

Exit behavior (consistent with `GITHUB_HELP_TEXT` and the exit constants in `src/cli/kookr-github.ts`):

- `0` Success.
- `2` User error (bad flags / unknown verb / missing verb / invalid `KOOKR_PORT`).
- `3` No Kookr server reachable.
- `4` Server rejected the request (non-200 or unexpected payload).

Related: the advisory `github.scanner-backoff` check in [`kookr doctor`](#kookr-doctor) probes the same endpoint when an API base is configured.

## `kookr doctor`

Run launch preflight checks covering runtime tools, the `runtime.persistence` data-dir writability check (`access(KOOKR_DIR or ~/.kookr, W_OK)`, parity with the server's critical `/api/ready` persistence probe), the advisory `runtime.settings-mode` check (POSIX owner-only permissions on `settings.json`, which holds `automationKillSwitch`; warns when `mode & 0o077 != 0`), `gh` auth, the `kb` launch dependency, agent binary resolution, the advisory `agent.grok-auth` check (launch-scoped Grok `auth.json` when `grok` is on `PATH` or `KOOKR_GROK_BIN` is set; required fail when `KOOKR_GROK_BIN` is set), the advisory `github.scanner-backoff` check (live `GET /api/github/status` `stateFetchBackoffMs` when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server), the advisory `ops.http-latency` check (timed `GET /api/ready` at 500ms and `GET /api/health` at 2s when an API base is configured — timeout / over-budget / 5xx warn; health is skipped if ready already timed out), the advisory `ops.systemd-unit` check (Linux only; `systemctl --user is-active kookr.service`, warns when the shipped user unit is not active so an unattended crash is not left unsupervised), the advisory `ops.resource-watchdog` check (`KOOKR_RESOURCE_WATCHDOG` / live `resourceWatchdog.enabled`), the advisory `ops.hung-reclaim` check (live `GET /api/health` `capacity.byClass.hungSuspect` + `hungSuspectTtlReclaim` when residual is open_pr_failsafe-dominated), the advisory `ops.schedules-paused-by-failure` check (live `GET /api/health` `schedules.schedulesPausedByFailure` when any schedule is consecutive-failure paused), the advisory `hooks.ingestion-lag` check (live `GET /api/diagnostics/hook-ingestion` `notableLagCount` when an API base is configured), the advisory `ops.host-stale-dtach` check (live `GET /api/health` `staleProcesses.dtach` vs `sessionReaper` orphan gauges when an API base is configured — code `host_stale_dtach_mismatch`), the advisory `hooks.replay-checkpoints` check (live `GET /api/health` `hookReplayCheckpoints` sessionCount/fileBytes soft bounds when an API base is configured — code `hook_replay_checkpoints_oversize`), the advisory `ops.prod-smoke-tick` check (durable `{dataDir}/prod-smoke-tick-alert.json` consecutive-failure streak), and the advisory `ops.maintenance-prune` check (`KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS` / optional timer-health `lastFiredAt`). Default output is a human-readable table of each check (status, summary, recommended actions). Pass `--json` for the machine-readable report used by scripts and CI. Pass `--strict` to exit non-zero when any advisory WARN is present.

This is complementary to `pnpm doctor` (`scripts/doctor.sh`), which covers env/build preflight (ports, docker, node-pty). The two check sets are not identical — `kookr doctor` is the launch-dependency path (see [Related Commands](#related-commands)).

```bash
kookr doctor
kookr doctor --json
kookr doctor --strict
kookr doctor --json --strict
```

Without `--json`, prints aligned status rows for each check plus any recommended actions, then an overall status line. With `--json`, prints the JSON envelope below (shape is stable for scripts).

JSON envelope shape:

```json
{
  "ok": true,
  "status": "ok",
  "generatedAt": "2026-06-21T07:30:00.000Z",
  "checks": [
    {
      "id": "runtime.node",
      "label": "Node.js",
      "category": "runtime",
      "status": "ok",
      "required": true,
      "summary": "v24.11.1 satisfies >= 22"
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` when no required check has `status: "fail"`. Advisory `warn` checks still allow `ok: true`. |
| `status` | `"ok"` \| `"warn"` \| `"fail"` | Aggregate severity across all checks (`fail` > `warn` > `ok`). |
| `generatedAt` | ISO-8601 string | Report timestamp. |
| `checks` | array | Individual checks (see table below). |

Each check object has `id`, `label`, `category`, `status` (`ok` / `warn` / `fail`), `required`, `summary`, and optional `detail` / `recommendedAction`.

### Check ids

Stable `checks[].id` values on a healthy machine:

| Check id | Category | Required | What it verifies |
| --- | --- | --- | --- |
| `runtime.node` | runtime | yes | Node.js ≥ 22 on `PATH` |
| `runtime.pnpm` | runtime | yes | pnpm ≥ 10 on `PATH` |
| `runtime.git` | runtime | yes | `git` available |
| `runtime.dtach` | runtime | yes | Vendored `vendor/dtach/dtach` executable, or system `dtach` on `PATH` |
| `runtime.persistence` | runtime | yes when the dir exists but is unwritable / uncreatable; else advisory | Kookr data dir (`KOOKR_DIR` or `~/.kookr`) is writable (`access(dir, W_OK)`) — parity with the server's critical `/api/ready` persistence check. `ok` when writable; required **FAIL** surfacing the errno (`EACCES`, `EROFS`, …) when the dir exists but is not writable, or is missing and cannot be created (no writable ancestor). Because doctor is a *pre-launch* preflight and the server creates the dir lazily at startup (`mkdirSync` recursive), a missing-but-creatable dir (`ENOENT` where the nearest existing ancestor is writable) is an advisory **WARN**, not a fresh-install false failure. |
| `runtime.settings-mode` | runtime | no | On-disk `settings.json` is owner-only. Path resolves to `KOOKR_SETTINGS_PATH` when set, else `settings.json` in the **port-derived** data dir (`~/.kookr` on 4800, `~/.kookr-<port>` otherwise — the same derivation the server uses; deliberately not the doctor-only `KOOKR_DIR` override, which the server ignores for its data dir). Advisory warn when `mode & 0o077 != 0` (group/other-accessible) — `settings.json` holds `automationKillSwitch` (SAFE MODE), and `saveSettings` writes 0o600 but a later umask copy, restore, or hand edit can widen it. Recommended action: `chmod 600 <path>`. Under `KOOKR_PORT=auto` the default `~/.kookr` may not be the auto-launched instance's dir, so the summary appends a caveat pointing to `KOOKR_SETTINGS_PATH`. Skips (no row) when the file is missing, or off POSIX (`platform` not `linux`/`darwin`). Never required; `--strict` exits non-zero on the warn. |
| `ops.systemd-unit` | ops | no | Linux only. This host is supervised by the shipped `kookr.service` systemd **user** unit (`systemctl --user is-active kookr.service` == `active`). Advisory warn when the unit is inactive/not-loaded — an unattended crash stays down until someone notices — with the install snippet (`mkdir -p ~/.config/systemd/user`; `cp deploy/server/kookr.service …`; `systemctl --user daemon-reload`; `enable --now`). Skips (no row) off Linux (systemd is Linux-only) or when `systemctl` is absent (hosts that deliberately run the pid-file path). Never required, never auto-enables the unit; `--strict` exits non-zero on the warn. |
| `github.gh-auth` | github | no | `gh auth status` succeeds (advisory warn when not configured) |
| `github.scanner-backoff` | github | no | Live `GET /api/github/status` state-fetch rate-limit backoff when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server. Advisory warn when `stateFetchBackoffMs` ≥ 30s (remaining backoff + `trackedRefCount`). OK with "probe skipped" when no API base or the probe is unreachable (hermetic offline stays green). |
| `launch.kb` | launch-dependency | no | `kb doctor --format=json` and a smoke `kb search` both succeed |
| `agent.claude` | agent | yes if `KOOKR_AGENT_BIN` set; else advisory | Claude Code binary (`KOOKR_AGENT_BIN` or `claude`) |
| `agent.codex` | agent | yes if `KOOKR_CODEX_BIN` set; else advisory | Codex CLI binary (`KOOKR_CODEX_BIN` or `codex`) |
| `agent.codex-plugin-dir` | agent | no | Codex advertises `--plugin-dir` (only emitted when `agent.codex` is `ok`) |
| `agent.grok-auth` | agent | yes if `KOOKR_GROK_BIN` set; else advisory | Launch-scoped Grok `auth.json` via `inspectGrokAuthFile` (only emitted when `grok` is on `PATH` or `KOOKR_GROK_BIN` is set). Missing / invalid / expired credentials WARN unless `KOOKR_GROK_BIN` is set, then required FAIL. Recommended action: `grok login --device-code`. Omitted when the binary is absent and not configured. |
| `ops.http-latency` | ops | no | Timed `GET /api/ready` (500ms abort and WARN budget) then `GET /api/health` (2s abort and WARN budget) when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server. Advisory warn on timeout, elapsed over budget, or 5xx, with elapsed ms. Health is skipped when ready already timed out so doctor does not hang twice on a wedged server. OK when both are under budget, or the probe is skipped (hermetic offline / no API base). Never required — sibling probes that skip on timeout are not a clean bill of health. |
| `ops.resource-watchdog` | ops | no | Host-pressure auto-investigation enabled (`KOOKR_RESOURCE_WATCHDOG`, or live `GET /api/health` `resourceWatchdog.enabled` when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server). Advisory warn when disabled (default). |
| `ops.hung-reclaim` | ops | no | Live `GET /api/health` hungSuspect residual + `hungSuspectTtlReclaim` when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server. Advisory warn only when `capacity.byClass.hungSuspect` > 0, `reclaimedTotal` = 0, and the last reclaim pass is open_pr_failsafe-dominated (plurality of `lastOutcomes`). OK when reclaim is healthy, residual is under-TTL / not failsafe-dominated, or the probe is skipped (hermetic offline). Does not weaken open-PR fail-safes. |
| `ops.schedules-paused-by-failure` | ops | no | Live `GET /api/health` `schedules.schedulesPausedByFailure` when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server. Advisory warn when ≥1 schedule is consecutive-failure paused, naming the count and at least one schedule. OK when the array is empty/absent, or the probe is skipped (hermetic offline). Never required; does not auto-resume pauses. Remediation: `kookr schedule enable --held-by cascade` (batch-recover all cascade holds), or `kookr schedule enable <id>` one at a time. `--strict` exits non-zero on the warn. |
| `hooks.ingestion-lag` | ops | no | Live `GET /api/diagnostics/hook-ingestion` lag gauges when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server. Advisory warn when `notableLagCount` > 0 (sessions with lag over `lagWarningThresholdMs`). OK when notable lag is zero, or the probe is skipped (hermetic offline / server unreachable). Never required — doctor stays non-blocking. |
| `ops.host-stale-dtach` | ops | no | Live `GET /api/health` host-stale dtach mismatch when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server. Advisory warn (code `host_stale_dtach_mismatch`) when `staleProcesses.dtach.count − (sessionReaper.lastOrphanCount + lastTerminalLeakCount)` is ≥ the dtach pressure soft bound (default 20) — host-stale masters outside TaskStore that the session reaper cannot see. OK when host excess is below the bound, or the probe is skipped (hermetic offline / either health block absent). Never required; does not enable kill/spawn paths. |
| `hooks.replay-checkpoints` | ops | no | Live `GET /api/health` `hookReplayCheckpoints` gauges when `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server. Advisory warn (code `hook_replay_checkpoints_oversize`) when `sessionCount` ≥ 2000 or `fileBytes` ≥ 5 MiB (soft bounds; injectable via probe for tests). OK when under bounds, the block is null/disabled, or the probe is skipped (hermetic offline). Never required — doctor does not drop checkpoint entries. |
| `ops.prod-smoke-tick` | ops | no | Hourly prod smoke tick alert artifact (`{KOOKR_DIR or ~/.kookr}/prod-smoke-tick-alert.json`). Advisory warn when `status=alert`, summarizing `consecutiveFailures` and `failingChecks`. No warn when the artifact is missing or `status=ok`. |
| `ops.maintenance-prune` | ops | no | Scheduled data-dir prune enabled (`KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS` > 0). Advisory warn when unset/0 (default). When enabled and `KOOKR_API_BASE_URL` / `KOOKR_PORT` points at a server, optional `GET /api/diagnostics/timer-health` `maintenancePrune.lastFiredAt` enriches the OK summary. |

When the KB path fails, the single KB row is replaced by a more specific id:

| Check id | When it appears |
| --- | --- |
| `launch.kb-doctor` | `kb doctor --format=json` failed or is unavailable |
| `launch.kb-search` | `kb doctor` passed but the smoke search failed |

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--json` | none | false | Print one machine-readable JSON report to stdout. Without this flag, prints a human-readable table. |
| `--strict` | none | false | Exit `1` when any advisory `warn` is present (in addition to required failures). Default keeps advisory WARNs as exit `0` so scripts only gate on hard failures. |
| `-h`, `--help` | none | false | Print command help and exit `0`. |

Exit behavior:

- `0` when all required checks pass (`ok: true`; advisory warnings allowed unless `--strict`).
- `1` when one or more required checks fail (`ok: false`), or when `--strict` is set and the aggregate status is `warn`.
- `2` for usage errors (unknown argument).

## `kookr logs`

Tail a task's recent hook-event activity from the shell — the read-side
counterpart to the hook *write* path (`bin/kookr-hook-writer.js`) and the
*replay* path (`scripts/replay-hooks.ts`). It answers "what is this task doing?"
without opening the dashboard or booting a server:

```bash
kookr logs <taskId>
kookr logs <taskId> -n 50
kookr logs <taskId> --json
kookr logs <taskId> --dir ~/.kookr-4801
```

`kookr logs` operates directly on the on-disk data directory (like
`kookr maintenance`). It resolves the data directory the same way, looks the
task up in `tasks.json`, reads each of its sessions' persisted hook JSONL under
`<dataDir>/hooks/<session>.jsonl` — including any rotated `<session>.jsonl.N`
generations the writer's size cap split off (issue #1433), stitched in
chronological order — parses records with the same framing parser the production
ingestion route uses, and prints the most recent records (newest last). Known secret formats in event payloads are redacted on the read
path, since output may be pasted into bug reports.

`<taskId>` is a Kookr task id (from the dashboard, or the `task_id=` line printed
by `kookr spawn`). A session / hook-log id (e.g. `kookr-020f33cb`) is also
accepted as a direct fallback when it does not match a known task.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `-n`, `--lines` | positive integer | `20` | Show the last N records across the task's sessions. |
| `--json` | none | false | Print one machine-readable JSON envelope (`taskId`, `dataDir`, `hookLogs`, `totalRecords`, `records[]`) instead of the human summary. |
| `--dir` | path | resolved from `KOOKR_PORT` | Read from an explicit data directory (e.g. a dev instance's `~/.kookr-4801`). |
| `-h`, `--help` | none | false | Print command help and exit. |

Exit behavior:

- `0` when records are printed, or the task exists but has no hook activity yet.
- `1` when the argument matches neither a known task nor an existing hook log.
- `2` for usage errors such as an unknown option or a non-positive `--lines`.

## `kookr command outcome`

Inspect recorded local and remote outcomes for terminal commands:

```bash
kookr command outcome
kookr command outcome <commandId>
```

The command reads local interaction logs and the remote command journal from the
Kookr data directory, then prints one JSON object per line. Without an argument,
it prints every recorded outcome in timestamp order. With a `commandId`, it
prints only matching records.

Output records include fields such as `source`, `commandId`, `action`,
`outcome`, `timestamp`, `agentId`, and `taskId` when those values are available.
If a specific `commandId` has no local or remote records, the command prints:

```json
{"commandId":"<commandId>","outcome":"unknown-never-seen"}
```

Exit behavior:

- `0` when the query completes, including the `unknown-never-seen` case.

## `kookr ralph`

Inspect or control a Ralph loop:

```bash
kookr ralph status <taskId> [--json]
kookr ralph pause <taskId> [--json]
kookr ralph resume <taskId> [--json]
kookr ralph cancel <taskId> [--json]
```

If a loop appears stopped after a crash, relaunching the same playbook may show a duplicate-loop conflict or a **Replace with new** recovery dialog. See [Ralph Loop Stopped Or Shows "Replace With New"](../troubleshooting.md#ralph-loop-stopped-or-shows-replace-with-new) before editing local state by hand.

## `kookr schedule`

List, trigger, enable, or disable schedules from the shell — the same operations the dashboard's Schedules panel performs, for headless/SSH boxes with no browser. Thin HTTP client over the server's `/api/schedules` routes.

```bash
kookr schedule list [--json]
kookr schedule run <id> [--json]
kookr schedule enable <id> [--json]
kookr schedule enable --held-by cascade [--json]
kookr schedule enable --stop-reason consecutive_failures [--held-before <ISO>] [--json]
kookr schedule disable <id> [--json]
```

- `list` renders one line per schedule — `<id>  <enabled|disabled>  <name>  cron="<cron>"  next=<nextRunAt|->` plus `triggers=<remaining>/<max>` when a trigger cap is set. Pass `--json` for the raw `{schedules, status}` payload so scripts don't parse the human format.
- `run <id>` fires the schedule once now and prints the spawned task id. `(queued)` means the server accepted the fire but is at capacity, so the task waits until a slot frees; `(parked — launch dependency degraded)` means required dependency admission preserved the task without consuming a worker. JSON output distinguishes these with `queued`, `parked`, `outcome: "parked_dependency"`, and `reasonCode: "dependency_degraded"`.
- `enable <id>` / `disable <id>` toggle the schedule without editing its definition.
- `enable --held-by cascade` batch-re-enables **every** schedule the fail-closed auto-pause parked (`enabled=false` and `stopReason=consecutive_failures`, issue #2353) in one idempotent command (issue #2531) — collapsing a `consecutive_failures` cascade recovery from N `enable <id>` calls to one. It **never** flips a genuine operator `disable` (that hold carries no `consecutive_failures` stopReason), prints exactly what it re-enabled, and is a no-op on a clean fleet. `consecutive-failures` is an accepted alias for `cascade`. `--held-by` is only valid with `enable` and cannot be combined with an `<id>` (or with `--stop-reason` / `--held-before` — pick one selector). With `--json`, the `details` envelope lists `{heldBy, total, reenabled[], failed[]}`; a partial failure exits `4`. Safe because issue #2517 removed the false-increment source, so a re-enabled schedule will not immediately re-trip on a phantom streak.
- `enable --stop-reason consecutive_failures` (issue #2520) is the watermark-scoped form of the same cascade recovery: it bulk re-enables **every** schedule parked by the fail-closed consecutive-failures auto-pause in one action — the recovery for a bug-induced cascade that disabled a whole fleet (see the [fail-closed schedule pauses](unattended-recovery-runbook.md) runbook). Give either a schedule `<id>` **or** `--stop-reason`, not both. Optionally add `--held-before <ISO>` to recover only holds established before a fix-commit / deploy time (holds set after it — real, still-failing loops — stay parked). Legacy holds without a recorded timestamp are treated as old and included. Prints the recovered schedules; any that could not be re-enabled (e.g. trigger-limit exhausted) are listed on stderr as skipped. On post-deploy start the daemon also logs the consecutive-failures holds that predate the running build, so operators know which dark schedules a just-deployed fix may have cleared.

The server is discovered the same way as `kookr spawn` (`KOOKR_API_BASE_URL`, then `KOOKR_PORT`, then a probe of `4800`/`4801`); `KOOKR_API_TOKEN` is forwarded to non-loopback servers.

Exit codes (specific to `kookr schedule`): `0` success; `2` user error (bad flags, missing schedule id); `3` no server reachable (fail closed); `4` server rejected the request (unknown id, capacity/drain, validation, or scheduling not configured).

## `kookr drain` / `kookr resume`

Control operator drain mode on a running local Kookr instance:

```bash
kookr drain
kookr drain status
kookr resume
```

Drain mode refuses new task launches while already-running agents continue. Use it before maintenance restarts or deploys when you want the current work to settle without accepting more launches. `kookr resume` re-opens launches after the maintenance window.

`kookr drain status` is read-only. `kookr drain` and `kookr resume` POST to the server admin endpoints and print the resulting state, including the number of running tasks when the server reports it.

Pass `--json` to any of these (`kookr drain --json`, `kookr resume --json`, `kookr drain status --json`) to emit a single machine-readable envelope instead of human text — useful for scripting a maintenance restart. On success:

```json
{ "ok": true, "draining": true, "since": "2026-05-29T12:00:00.000Z", "runningTasks": 3, "changed": true }
```

`since` is `null` when not draining, and `changed` is `null` for the read-only `drain status` query. On failure (server unreachable, admin auth rejected, bad `KOOKR_PORT`, etc.) it emits an error envelope mirroring `kookr status --json`, so scripts can branch on `ok`:

```json
{ "ok": false, "code": "FORBIDDEN", "message": "Forbidden: admin auth required. …" }
```

Exit codes are identical to the default text mode in both cases.

Target selection:

- `KOOKR_PORT=<port>` targets a specific local instance on `127.0.0.1`.
- When `KOOKR_PORT` is unset, Kookr probes ports `4800` then `4801`.
- If `KOOKR_ADMIN_TOKEN` is set, the CLI forwards it in the admin-token header.

Exit behavior:

- `0` when the request succeeds, including an already-draining or already-accepting state.
- `1` when the target server cannot be reached, rejects admin auth, or returns another non-2xx response.
- `2` for usage errors such as an unknown drain verb.

Routine `pnpm prod:restart` / `pnpm prod:update` already best-effort enter drain
before SIGTERM; drain is in-memory and cleared when the process exits, so a
successful restart does **not** require `kookr resume`. See
[Redeploy resilience](#redeploy-resilience) and the
[low-downtime redeploy runbook](../runbooks/low-downtime-redeploy.md).

## `kookr orchestration`

Pause or resume the autonomous fleet on a running local Kookr instance. This is
a named surface over SAFE MODE (the `automationKillSwitch` setting): pausing
stops new autonomous launches (implementers, scouts, queue-feeder) while letting
already-running agents finish, and records the pause under
`~/.kookr/playbook-state/orchestrator/quota-pause.json`. Unlike `kookr drain`, it
does **not** refuse the merge-review children an in-flight implementer still
needs. Use it when a provider's weekly quota is nearly exhausted and you want the
fleet to coast to a stop until the window resets.

```bash
kookr orchestration status
kookr orchestration pause  [--reason "quota reset window"] [--by jean]
kookr orchestration resume [--by jean]
```

- `status` (read-only) prints whether orchestration is paused, and — when a
  record exists — the source, since, reason, and who; plus the default agent's
  quota sample and the soft-quota recommendation when a signal is available.
  The JSON form also separates the current lifecycle from the trailing
  24-hour known overlap and lists unresolved records whose duration is unknown.
- `pause` engages SAFE MODE and writes the pause record. Defaults to a **human**
  pause, which is sticky against auto-resume — `kookr orchestration resume --auto`
  will not lift it. An explicit `kookr orchestration resume` (without `--auto`)
  clears it, and so does turning the automation kill switch off when the pause
  record was created by that switch.
- `resume` disengages SAFE MODE and closes the current record while retaining it
  in the provenance ledger. `--auto` still refuses to lift a human pause.

A **soft-quota** pause (the orchestrator's own response to near-exhausted quota)
is distinct: `--source soft-quota` on `pause`, and `--auto` on `resume`. A
soft-quota `--auto` resume auto-lifts only a soft-quota pause (with hysteresis:
at or below 80% utilization, or after the window resets); it declines to lift a
human pause or a SAFE MODE engaged outside this wrapper.

Target selection mirrors `kookr status`: `KOOKR_API_BASE_URL` or `KOOKR_PORT`
overrides auto-detect; otherwise Kookr probes ports `4800` then `4801`.
`KOOKR_API_TOKEN` is forwarded as a bearer token for non-loopback servers. Pass
`--json` to any verb for one machine-readable envelope.

Exit codes: `0` success, `2` usage error (bad flags / unknown verb), `3` no
server reachable, `4` server rejected the request.

## `kookr migrate`

Continue **interrupted** tasks under a **different** agent — e.g. move stalled
Grok Build tasks to Claude Code when a provider's weekly quota is exhausted. A
thin HTTP client against the running server's `/api/tasks/migratable` +
`/api/tasks/migrate` routes.

```bash
kookr migrate --to <agent> --all [--from <agent>] [OPTIONS]   # batch
kookr migrate --to <agent> <taskId...> [OPTIONS]              # explicit ids
```

Migration creates a **linked continuation task** under the target agent (in the
interrupted task's checkout) rather than forking the original — the source task
keeps its own agent and is linked to its successor, so cost/outcome ledgers stay
truthful. Cross-vendor conversation state is not portable, so the continuation
gets a reconstructed brief (the task's intent + progress digest + current
working-tree state), not a conversation transplant.

| Flag | Meaning |
|---|---|
| `--to <agent>` | Target agent: `claude-code`, `codex-cli`, `grok-build` (required) |
| `--from <agent>` | Source-agent filter (only meaningful with `--all`) |
| `--all` | Migrate every migratable task (optionally filtered by `--from`) |
| `--include-cancelled` | Also consider user-cancelled tasks (batch scope; naming an id already opts it in) |
| `--set-default` | On success, set `<agent>` as the server's default agent for new launches |
| `--only-isolated` | Only tasks whose checkout is a dedicated worktree (not a shared checkout) |
| `--effort <level>` | Reasoning effort for the continuation task (re-validated against the target agent) |
| `--dry-run` | Print the plan and exit without launching |
| `--yes`, `-y` | Skip the confirmation prompt |

Exit codes: `0` migrated/queued (or dry-run found candidates), `1` declined at
the prompt, `2` bad flags, `3` no server found, `4` server error, `5` every
candidate blocked.

```bash
# Move all interrupted Grok tasks to Claude Code and make Claude the new default
kookr migrate --to claude-code --from grok-build --all --set-default --dry-run
kookr migrate --to claude-code --from grok-build --all --set-default --yes
```

## Redeploy resilience

How CLI and related client surfaces behave across an intentional production
restart. Full operator procedure, clocks, and residual same-port blackout:
[Low-downtime redeploy](../runbooks/low-downtime-redeploy.md).

| Surface | During redeploy | Agent policy |
| --- | --- | --- |
| **`kookr spawn`** | **503** + `code: "draining"` while drain is on; connection errors during the same-port blackout (ideal &lt;1s / max &lt;5s API gap) | Retry with backoff ≤**60s**; use idempotency keys; do **not** open outage issues for a single refused launch in a known deploy window. See [spawn contract](./spawn-contract.md). |
| **`kookr signal`** | Durable outbox write-behind; offline/restart exits **0** (spooled); server drains after boot | Treat spool as success. See [signal-outbox](./signal-outbox.md). |
| **Drain 503 / ready** | Launches and schedule fires refuse while draining; `/api/ready` 503 when draining or `startup-in-progress` | Expected cordon — not an incident by itself. |
| **Dashboard** | WS reconnect; banner may say **Redeploying** during deploy-triggered blackout | Expected; wait for reconnect. |
| **Schedules** | Tick records **`skipped_draining`** while drain is on | One skipped fire during redeploy is intentional. |

**M2 note:** `pnpm prod:restart` may wait a long time on `/api/ready` (recovery)
after `/api/health` is already 200. Long script wall clock ≠ long API blackout.

## `kookr maintenance prune`

Prune aged completed-task artifacts (hook logs, activity ledgers, rotated `server.log.N`, and `playbook-state` run directories) from a Kookr data directory:

```bash
kookr maintenance prune --dry-run
kookr maintenance prune --max-age-days 14 --dir ~/.kookr-4801
kookr maintenance prune --playbook-keep-last 5
kookr maintenance prune --json
```

The command operates directly on disk and does not require the Kookr server to be running. By default it targets `~/.kookr`, or `~/.kookr-<port>` when `KOOKR_PORT` is set to a non-default numeric port. Pass `--dir` to target a specific data directory, especially for instances launched with `KOOKR_PORT=auto`.

Options:

- `--dry-run` - print the prune plan without deleting files.
- `--max-age-days <n>` - prune eligible artifacts older than `n` days; the default is 30.
- `--playbook-max-age-days <n>` - age threshold (days) for `playbook-state` run directories; defaults to `--max-age-days`.
- `--playbook-keep-last <k>` - always keep the newest `k` runs per playbook regardless of age; the default is 0 (age-only).
- `--atomic-temp-max-age-days <n>` - age threshold for recognized root-level atomic-write temporary files; the default is 7 days.
- `--dir <path>` - use an explicit Kookr data directory.
- `--json` - print the prune result as JSON.

The prune is intentionally conservative. It removes hook-event logs under `<dataDir>/hooks/*.jsonl` — including rotated `<session>.jsonl.N` generations (issue #1433) — activity ledgers under `<dataDir>/activity/*.jsonl(.1)`, and `playbook-state/<playbook>/<runKey>` run directories, in every case only for terminal tasks older than the age threshold plus aged orphans, plus aged numbered `server.log.N` generations. It also sweeps only the explicit root-level atomic-write allowlist documented in [data-directory.md](data-directory.md#maintenance-prune) after the separate seven-day default threshold. A fresh temp file or one held open by a live process is preserved; if open-file verification cannot complete, the sweep fails closed. The check is repeated immediately before each deletion to narrow the check/delete race, which is still inherently possible if a process opens the path after that check. Human and JSON reports include the temp sweep's examined, planned, removed, skipped, and byte totals; dry-run reports reclaimable bytes without deleting. A file that disappears before unlink is not counted as removed or reclaimed. A live/in-progress session's artifacts and an active task's playbook run are never eligible. It preserves task history, crash-recovery data, interaction logs, contribution history, and other stores whose mapping or audit value is ambiguous. Bare `.tmp-write` and `.tmp-prune` names are excluded from the root allowlist because those suffixes belong to nested marker files. The same sweep can run automatically on a server-side timer via `KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS` (off by default).

Kookr's operational disk-pressure alert points operators here when the
filesystem containing the data directory stays below the configured free-space
floors. Run `kookr maintenance prune --dry-run --dir <dataDir>` first to inspect
what Kookr can safely remove. The alert does not auto-prune, throttle writes, or
create a separate persistence store; if filesystem statistics are unavailable
or unreadable, the sampled disk fields are reported as absent and the alert rule
waits for readable samples.

Exit behavior:

- `0` when planning or pruning succeeds.
- `1` when the prune fails, for example because the target data directory cannot be read.
- `2` for usage errors such as an unknown flag, missing `prune` verb, or invalid `--max-age-days`.

## `kookr maintenance backup`

Create a timestamped gzip-compressed tarball of a Kookr data directory:

```bash
kookr maintenance backup
kookr maintenance backup --dir ~/.kookr-4801 --out ~/kookr-backups
kookr maintenance backup --json
```

The command operates directly on disk and does not require the Kookr server to
be running. By default it targets `~/.kookr`, or `~/.kookr-<port>` when
`KOOKR_PORT` is set to a non-default numeric port. Pass `--dir` for an explicit
data directory, especially for instances launched with `KOOKR_PORT=auto`.

By default backups are written under `~/kookr-backups`. Pass `--out <path>` to
choose another output directory. The file name is
`kookr-backup-<UTC_TIMESTAMP>.tar.gz`, for example
`kookr-backup-20260613T140506Z.tar.gz`.

Archive layout:

- `kookr-backup-manifest.json` - schema version, creation time, source data
  directory, crash-consistency contract, entry list, total source bytes, and
  exclusions.
- `data/` - the backed-up data directory contents, preserving regular files,
  directories, and symlinks.

If the output directory is inside the data directory, it is excluded from the
archive so older backup tarballs are not recursively backed up. Unsupported
special files, such as sockets or device nodes, are skipped and listed in the
manifest exclusions.

Crash-consistency contract: a backup taken while Kookr is running is
crash-consistent, not a cross-store transaction. Restoring it is equivalent to
recovering after `kill -9` while the server was writing: Kookr's per-store
atomic-write and boot-repair logic must recover each store, but files are not
guaranteed to share one exact timestamp boundary. For a byte-stable copy of a
quiet data directory, drain or stop Kookr before running the backup.

Restore remains manual: stop Kookr, extract the tarball, and copy `data/.` into
the target data directory before restarting. Do not restore over a running
server.

Options:

- `--dir <path>` - use an explicit Kookr data directory.
- `--out <path>` - write the timestamped tarball to this output directory.
- `--json` - print the backup result and manifest as JSON.

Exit behavior:

- `0` when the backup succeeds.
- `1` when the backup fails, for example because the target data directory
  cannot be read or the output archive already exists.
- `2` for usage errors such as an unknown flag or missing `--out` path.

## `kookr pr-checklist`

Machine-verify a repository's anti-drift PR checklist against the working-tree
diff. Deterministic and AI-free — the local pre-`gh pr create` gate and a
CI-friendly verifier for the same contract. See
[PR Checklist Contract](../rfc/rfc-pr-checklist-contract.md).

```bash
kookr pr-checklist verify [--pr-body <file|->] [--base <ref>] [--json]
kookr pr-checklist verify --from-command <raw gh pr create …> [--run-commands none]
kookr pr-checklist verify --explain
kookr pr-checklist doctor [--json]
```

### `verify`

Collect changed paths against `--base` (default `main`) and check structural
rules plus optional PR-body attestation boxes.

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--pr-body` | path or `-` | unset | PR body to check attestation boxes against (`-` reads stdin). Omit for structural checks only (typical local preflight; CI supplies the body). Mutually exclusive with `--from-command`. |
| `--from-command` | raw shell string | unset | Derive body + base from a raw `gh pr create …` command (used by the local hook). A `--fill` / `$(…)` / stdin body is unverifiable — attestation is skipped locally and CI stays authoritative (never a silent pass). |
| `--run-commands` | `none` or `ci` | `none` | `none` runs no repo commands. `ci` is reserved and currently rejected. |
| `--base` | git ref | `main` | Diff base branch (`--from-command`'s base wins when present). |
| `--json` | none | false | Emit one machine-readable JSON report to stdout. |
| `--explain` | none | false | Print the resolved built-in checklist rules as JSON and exit `0`. |
| `-h`, `--help` | none | false | Print command help and exit `0`. |

### `doctor`

Report the local hook's recent fail-open / degrade rate from the on-disk degrade
log. Use this when you need to know whether the anti-drift PR gate has silently
stopped gating (fail-open history), not for launch preflight — that is
[`kookr doctor --json`](#kookr-doctor).

```bash
kookr pr-checklist doctor
kookr pr-checklist doctor --json
```

With `--json`, prints a summary object (`status`, `logPath`, `total`, `last24h`,
`last7d`, `malformedLines`, `recent`). Without `--json`, prints a short human
report. Exit is always `0` when the log can be read (including “no events”);
unreadable log path → `70`.

### Exit codes

Sysexits-style — **not** the spawn/ralph table. Exit `2` means **verification
failed**, not bad arguments:

| Exit code | Meaning |
| --- | --- |
| `0` | Pass |
| `2` | Verification failure (findings, or a fail-closed repo-input error) |
| `64` | Usage error |
| `70` | Kookr-internal fault (only this class may be treated as fail-open by a hook) |

## `kookr context-pack`

Build a spawn-time **context pack** from a JSON spec — a warm-start digest of an
issue (title/body/acceptance criteria), candidate file hints, base ref, and
pre-digested skill excerpts that a spawned issue-implementation task can open
with instead of re-retrieving the repo cold. Used by the parallel-issue-batch
playbook to cut cold-retrieval cost for child tasks.

```bash
kookr context-pack --spec spec.json --out pack.md
kookr context-pack --spec spec.json --out pack.md --review-out review.md
```

The compiled CLI is loaded with a `dist`→`src` fallback, so the verb works from
an `npm`/`npx` install and a source checkout alike. The historical by-path form
(`node "$KOOKR_REPO/bin/kookr-context-pack.js" …`) keeps working unchanged.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--spec` | `<path>` | — | JSON spec describing the issue, candidate files, base branch/commit, and optionally skills + a staged-diff file. Required. |
| `--out` | `<path>` | — | Write the child-task context pack (markdown) here. Required. |
| `--review-out` | `<path>` | none | Also write a pre-PR review pack (pack + staged diff). Requires `"stagedDiffFile"` in the spec. |
| `--plugin-dir` | `<path>` | auto | Override the `kookr-toolkit` plugin dir (skill source root). |
| `--cache-dir` | `<path>` | auto | Override the skill-digest cache dir. |
| `--json` | none | false | Emit one machine-readable JSON envelope on stdout. |
| `-h`, `--help` | none | false | Print command help (including the full spec shape) and exit. |

The pack is a **floor, not a ceiling**: `candidateFiles` are non-exhaustive
hints and packed facts can be stale, so a child must verify and explore beyond
it. Exit `0` on success; `2` on any failure — a usage error (missing
`--spec`/`--out`), a malformed spec, or a failed write of the output pack.

## `kookr signal-emit`

Spool an **operator signal** into the delivery outbox (issue #1716). Scheduled
monitors call this to turn a status reading or a liveness check into a signal
file that the in-server delivery bridge then pushes to Discord / Telegram. See
[Operator Signal Delivery](./environment-variables.md#operator-signal-delivery)
for the channel configuration.

```bash
# deploy-lag / prod-smoke transitions (fire on ok→alert, clear on alert→ok):
kookr signal-emit transition --source deploy-lag --status alert --detail "7 commits / 9.5h behind"
# liveness registry (stale/missing artifact → one signal, re-emit ≤ once per 6h):
kookr signal-emit liveness --registry liveness.json
```

The compiled CLI is loaded with a `dist`→`src` fallback, so the verb works from
an `npm`/`npx` install and a source checkout alike; the by-path form
(`node "$KOOKR_REPO/bin/kookr-signal-emit.js" …`) keeps working unchanged.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `transition --source` | `<name>` | — | Monitor name (e.g. `deploy-lag`, `prod-smoke`). Required for `transition`. |
| `transition --status` | `ok`\|`alert`\|`unknown` | — | Current status; a transition vs the persisted last-known status emits a fire/clear signal. Required for `transition`. |
| `transition --detail` | `<text>` | none | Human summary included in the notification. |
| `liveness --registry` | `<path.json>` | — | JSON array of `{name,maxAgeMs,path?,enabled?}` entries checked against artifact mtimes. Required for `liveness`. |
| `liveness --now` | `<iso>` | now | Override the current time (testing / replay). |
| `--dir` | `<path>` | `$KOOKR_OPERATOR_SIGNAL_DIR` or `~/.kookr/playbook-state/operator-signals` | Override the operator-signal outbox directory. |
| `-h`, `--help` | none | false | Print command help and exit. |

Exit `0` whether or not a signal was emitted; `2` on a usage error (missing
`--source`/`--status`/`--registry`, invalid `--status`, or an unreadable
registry).

## `kookr push test`

Send a synthetic relay push notification to a registered device:

```bash
KOOKR_RELAY_URL=http://127.0.0.1:8080 kookr push test device-local-dev
```

Use this when validating relay push configuration for a device that already has a push subscription. The command POSTs to the relay's admin push-test endpoint with the supplied `deviceId`.

Environment:

- `KOOKR_RELAY_URL` - required relay base URL.
- `KOOKR_RELAY_ADMIN_TOKEN` - optional bearer token for relays that require admin auth.

Exit behavior:

- `0` when the relay accepts the test request; the CLI prints the relay result and any returned status code or error string.
- `1` when the relay returns a non-2xx response or the request fails.
- `2` for usage errors, including missing `KOOKR_RELAY_URL` or a missing/extra argument.

## `kookr`

The `kookr` binary is the package entry point. Most local development still uses `pnpm dev`, `pnpm start`, or the focused helper commands above.

## Replay Hook Events

`scripts/replay-hooks.ts` feeds a recorded hook-event JSONL file — a captured real session or a crafted fixture — into a running dev instance so you can deterministically reproduce a detector firing without spinning up a real agent and recreating conditions by hand.

```bash
# Replay a captured session's hook log into the running dev instance
node --import tsx scripts/replay-hooks.ts ~/.kookr/hooks/kookr-task-abc.jsonl

# Replay a fixture into a named session, pacing 50ms between records
node --import tsx scripts/replay-hooks.ts fixture.jsonl --session repro-660 --delay-ms 50

# Parse + classify records without sending anything
node --import tsx scripts/replay-hooks.ts fixture.jsonl --dry-run
```

It parses the JSONL with the same `splitHookRequestBody` the production HTTP route uses and pushes each record through `POST /api/hook-event/:sessionId`. Every record is replayed against a dedicated **synthetic** session whose id starts with `kookr-replay-` (the prefix is prepended automatically). Ingestion derives `origin: 'replay'` from that prefix, so replayed records are tagged replay-not-live and are scoped to a session that can never be mistaken for — or collide with — a live agent's state.

### Built-in scenario catalog

For detector development you usually don't need a captured log — a curated set of named scenarios maps a detector case to a fixture, the path it exercises, and the anomaly to expect. The catalog lives in `src/__fixtures__/replay-scenarios.json`.

```bash
# List every built-in scenario (name, fixture, purpose, expected finding)
node --import tsx scripts/replay-hooks.ts --list-scenarios

# Replay a named scenario instead of a file path
node --import tsx scripts/replay-hooks.ts --scenario billing-stop

# Dry-run a scenario (parses without a running instance — CI-friendly)
node --import tsx scripts/replay-hooks.ts --scenario tool-failure --dry-run
```

Scenarios include `idle-prompt`, `permission-request`, `tool-failure`, `billing-stop`, `task-notification`, and `codex-mcp-startup`. To add one, drop a fixture in `src/__fixtures__/` and append an entry (`name`, `fixture`, `purpose`, `expected`) to the manifest; `scripts/replay-hooks.test.ts` validates the manifest and dry-runs every scenario in CI without a server.

Options:

- `--scenario <name>` — replay a named built-in scenario (see `--list-scenarios`); mutually exclusive with a file argument
- `--list-scenarios` — print the built-in scenario catalog and exit
- `--session <id>` — target session id (forced into a `kookr-replay-` session)
- `--base-url <url>` — target instance; defaults to `KOOKR_API_BASE_URL`, then `KOOKR_PORT`, then a probe of ports `4800`/`4801`
- `--delay-ms <n>` — fixed delay between records (default `0`)
- `--limit <n>` — replay only the first N records
- `--dry-run` — parse and classify records (`parsed`/`unknown`/`malformed`) and print a summary without POSTing

## Related Commands

```bash
pnpm dev             # backend on 4801 and Vite frontend on 5173
pnpm prod:update     # update, build, restart, and health-check ../kookr-prod
pnpm prod:restart    # restart the production-style instance without rebuilding
pnpm doctor          # human-readable shell report (scripts/doctor.sh) — env/build preflight
kookr doctor         # human-readable launch preflight (gh/kb/agent binaries + agent.grok-auth + github.scanner-backoff + ops.http-latency + ops.systemd-unit + ops.resource-watchdog + ops.hung-reclaim + ops.schedules-paused-by-failure + hooks.ingestion-lag + ops.host-stale-dtach + hooks.replay-checkpoints + ops.prod-smoke-tick + ops.maintenance-prune)
kookr doctor --json  # same launch preflight as JSON (CI/bootstrap) — see `kookr doctor`
kookr doctor --strict # fail exit on advisory WARNs (e.g. sustained smoke-tick streak)
kookr ops digest     # one-pager of top unattended failure signals (GET /api/ready + /api/health)
kookr ops digest --json  # same digest as one JSON envelope (exit 1 on ready fail)
kookr ops timers     # lifecycle-timer lastFiredAt + overdue (GET /api/diagnostics/timer-health)
kookr ops timers --json  # same timer table as one JSON envelope (includes overdue list)
kookr github status  # GitHub scanner liveness, backoff, and tracked-ref count (GET /api/github/status)
kookr github status --json  # same scanner status as one JSON envelope
```
