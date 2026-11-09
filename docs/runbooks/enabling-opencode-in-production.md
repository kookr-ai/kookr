# Enabling opencode in production

Operator runbook for turning on the opt-in `opencode` agent type (cheap, fast
workers for small, well-scoped jobs) on a running Kookr. Reference for the
feature itself: [opencode agent](../reference/opencode-agent.md); design and
measurements: [RFC](../rfc/rfc-opencode-agent-integration.md).

**Nothing here runs by itself.** The agent is off unless
`KOOKR_OPENCODE_ENABLED=1` is set where the server runs, and enabling it needs a
server restart. Running agent terminal sessions keep running across a restart
and are re-attached, but the API is briefly unavailable, so do it in a quiet
moment (see [low-downtime redeploy](low-downtime-redeploy.md)). Disabling is the
reverse and equally needs a restart.

## 1. Prerequisites

| What | Value |
| --- | --- |
| Merged code | Kookr at or after the opencode PRs (#3520 core, #3521 runtime, #3522 profiles); `docs/reference/opencode-agent.md` exists in your checkout |
| Pinned binary | `opencode-ai@1.19.5` (the 1.x and 2.x plugin APIs are incompatible: do not use `latest`, npm `latest` lags GitHub and v2 rejects the plugin shape Kookr generates) |
| Provider key | `OPENAI_API_KEY` set in the **server's** environment, holding the DeepInfra key (the adapter writes only an `{env:OPENAI_API_KEY}` reference into per-session config, never the key). Careful: if that variable already holds a real OpenAI key the adapter would send it to `api.deepinfra.com` |
| Network | outbound HTTPS to `api.deepinfra.com`, and to the npm registry once (first launch builds the config seed) |
| Disk | ~420 MB for the tool dir and seed template, plus per-task data (capped at 1024 MB by default) |
| RAM | see section 5 |

### Install and verify the pinned binary

```sh
npm install --prefix ~/.kookr/tools/opencode-1.19.5 opencode-ai@1.19.5
~/.kookr/tools/opencode-1.19.5/node_modules/.bin/opencode --version   # must print 1.19.5
```

Integrity (published by npm for the release you are pinning; compare with
`npm view opencode-ai@1.19.5 dist.shasum dist.integrity`):

- `opencode-ai@1.19.5` tarball: shasum `4fb49717dfc8ca5fa97ab9823dadf4be3e244e82`, integrity `sha512-tEqMvQahfhdDj8vceYpXtoIrvjPXm5XRfetWnPN5YISueU7adNx9JcUA3zZ+2GKuDVgDpGdQe1ZLtCZDjqodvA==`
- `opencode-linux-x64@1.19.5` (the native binary package it installs): shasum `f72482d72266ae10728f55c81faea723c9899635`
- sha256 of the installed Linux x64 binary as measured on the reference host: `7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c` (`sha256sum ~/.kookr/tools/opencode-1.19.5/node_modules/opencode-linux-x64/bin/opencode`; other platforms/architectures install a different native package, record your own hash).

Kookr's preflight also refuses any other `--version` unless
`KOOKR_OPENCODE_ALLOW_ANY_VERSION=1` (unsupported).

## 2. Environment variables

Set in the environment of the Kookr **server** process (service unit, env file or
shell that launches it). Full table: `docs/reference/environment-variables.md`.

| Variable | Set to | Why |
| --- | --- | --- |
| `KOOKR_OPENCODE_ENABLED` | `1` | the opt-in switch (nothing is constructed or probed without it) |
| `OPENAI_API_KEY` | DeepInfra key | provider credential, see prerequisites |
| `KOOKR_OPENCODE_BIN` | path (optional) | only if the binary is not at `~/.kookr/tools/opencode-1.19.5/node_modules/.bin/opencode` |
| `KOOKR_OPENCODE_RAM_LIMIT_MB` | default `512` (leave) | caps the TUI JS heap, about 25-30 % lower peak RSS in tests; `0` turns it off |
| `KOOKR_OPENCODE_SEED`, `KOOKR_OPENCODE_SEED_DIR` | default (leave) | boot seed: ~5 s boot instead of ~11 s |
| `KOOKR_PR_LINT_CMD` | optional | PR-body lint command used by the `scoped-fix` gate (`{pr_body}` placeholder) |
| `KOOKR_OPENCODE_DATA_DIR` | optional, **absolute path to a dedicated directory** | persistent per-task data root (resume); a relative value is ignored. Kookr only deletes dirs carrying its ownership marker, but never point it at a directory with other data |

Do not set `KOOKR_OPENCODE_FAST_BOOT` (it only works with a terminal attached).

## 3. Verify with a canary (after the restart)

Opencode never joins round-robin or rotation; it is used only when selected.

1. Startup log shows the adapter registered, and no `[startup] warning:
   opencode ...` line. If it was skipped the warning names the reason (binary
   missing, wrong version).
2. `kookr spawn --agent opencode "Create a file CANARY.txt containing ok, then
   reply DONE."` from a scratch git repository with **no remote** (not a real
   project). An unprofiled launch still gets Kookr's generic worktree/PR
   guidance, so the worker may create a worktree instead of writing the file in
   the cwd; the profiled canary below avoids that.
3. Watch the task: it must reach `inProgress`, show hook activity (SessionStart,
   UserPromptSubmit, PreToolUse/PostToolUse, Stop) in the dashboard or
   `~/.kookr/hooks/<session>.jsonl`, create the file, and end waiting for
   input or completion. `kookr peek <task>` shows the pane; send a follow-up with
   `POST /api/agents/<id>/message`.
4. After `abort` or complete, the task's token usage and cost are recorded.
5. Clean up: delete the canary task and the scratch repo.

To prove the whole delivery path before real work, run a profiled canary on a
throwaway repo with a failing test: `kookr spawn --agent opencode --profile
scoped-fix ...`. Expect the deliverable gate to block the first stop until a
commit and an honest `PR_BODY.md` exist.

## 4. Using it

```sh
kookr spawn --agent opencode --profile scoped-fix "Fix #123: <well-specified bug with a reproduction>"
kookr spawn --agent opencode --profile reviewer  "Review the diff of PR #456 for real defects"
kookr spawn --agent opencode --profile test-auditor "Audit tests for src/foo/bar.ts"
```

- Aim it at small, well-scoped work with a clear acceptance test. It is not a
  replacement for Claude Code on large or ambiguous tasks.
- The profile defines the deliverable and the gate: `scoped-fix` = one local
  commit (never a push) + `PR_BODY.md` (all enforced by the gate); `reviewer` =
  `REVIEW.md`; `test-auditor` = `AUDIT.md`. For the last two the gate only
  enforces that the file exists and is non-empty; "no source edits" (reviewer)
  and "new tests that pass on the current code" (test-auditor) are profile
  instructions, so check the diff.
- Prepare the checkout yourself (a profiled launch skips the generic
  worktree/PR preamble). Give the issue number with `issue` (`POST /api/tasks`)
  so the gate can require `Closes #N`.
- Memory: the worker gets the Agent Notebook index at session start plus the
  lessons of the profile's own shelves, runs the retrospective once at the end
  (vote, prune, at most one new lesson).

## 5. Resource expectations

Measured on the reference host (16 cores, shared with other agents; n small):

- One worker (interactive TUI as Kookr runs it): ~650 MB RSS for the opencode
  process **with the default 512 MB RAM cap**, 1.2-1.45 GB without it, plus
  whatever the task runs (test suites: +0.6 GB small repos, +3-5 GB large ones).
- Concurrency, same small task repeated: uncapped, 4 workers peaked at 4.4 GB
  summed PSS and 8 workers at 8.1 GB PSS (11 GB RSS); re-run on the final code
  **with the cap and seeded boot**: 4/4 delivered at 3.3 GB PSS, 8/8 delivered at
  6.4 GB PSS (9.5 GB RSS), wall 184-300 s, no API throttling observed. The
  capped re-run is recorded in the parity report, not yet in the RFC. About 12
  live workers per 16 GB is a sensible ceiling for real tasks.
- Cost: roughly $0.01-0.05 per small task on DeepSeek-V4.1-Flash via DeepInfra.
- Option for memory pressure (not enabled by default): one shared
  `opencode serve` with attached TUIs costs ~300-360 MB per worker but is capped
  at 6-8 workers per server and shares a crash domain; see the RFC.

## 6. Rollback

1. Unset `KOOKR_OPENCODE_ENABLED` (or set it to anything but `1`) and restart
   the server. The agent type disappears from the picker; default behaviour is
   exactly as before.
2. Abort running opencode tasks **before** the restart (`kookr status`, then
   `kookr abort <taskId>`): their terminal sessions survive the restart, but
   with the agent type unregistered Kookr can no longer stop them or send them
   input (`Unknown agent type: opencode`).
3. Optional disk cleanup: delete `<kookr data dir>/opencode-data` and
   `~/.kookr/tools/opencode-1.19.5`. Nothing else is written outside per-task
   directories.

## 7. Known limitations

- Pinned to opencode 1.19.5; upgrading to 2.x needs a new plugin and a fresh
  evaluation (the plugin API changed incompatibly).
- One provider (DeepInfra): a model pin naming another provider fails on the
  first turn.
- The worker occasionally ends a turn with a malformed tool call or a degenerate
  loop and produces no output (about 2 of 13 review-pilot runs in the bake-off);
  re-run the task.
- Raw delivery depends on honest PR checklists; the gate (max 3 blocks) fixes
  most failures but reference-test correctness is not guaranteed: always review
  the diff.
- `kb search` needs an initialised knowledge-base index and an embedding
  provider; where it is unavailable the profiles tell the worker to continue
  without it.
- Follow-up hardening is tracked in issues #3523-#3529 (replay paths dropping
  profile/issue, gate base fallbacks, data-dir races, flag-off UI rows).
