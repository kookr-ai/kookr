# opencode agent

Kookr can run [opencode](https://opencode.ai) as an agent type (`opencode`)
next to Claude Code, Codex CLI and Grok Build. It drives the interactive
opencode TUI in a managed terminal session and is aimed at cheap, scoped
worker tasks on an OpenAI-compatible provider (DeepInfra by default). Design
background: [RFC opencode agent integration](../rfc/rfc-opencode-agent-integration.md).

## Enabling it

opencode is opt-in and never blocks server startup. Set
`KOOKR_OPENCODE_ENABLED=1` where the server runs; without it the adapter is not
even constructed (no preflight probe, one debug line) and default Kookr
behaviour is unchanged. When enabled, the adapter registers only when the
pinned binary is present; otherwise `opencode` is simply absent from the agent
picker and round-robin.

1. Install the pinned release (1.19.5; the 1.x and 2.x plugin APIs are
   incompatible) under `~/.kookr/tools`:

   ```sh
   npm install --prefix ~/.kookr/tools/opencode-1.19.5 opencode-ai@1.19.5
   ```

   Kookr finds `~/.kookr/tools/opencode-1.19.5/node_modules/.bin/opencode`
   automatically, or you can point `KOOKR_OPENCODE_BIN` at another binary.
2. Export the provider key where the Kookr server runs. The adapter reads
   `OPENAI_API_KEY` (the DeepInfra key) from its own environment and only ever
   writes an `{env:OPENAI_API_KEY}` reference into the per-session config,
   never the key itself.
3. Restart the server. A startup warning explains why `opencode` was skipped
   if the binary is missing or on the wrong version.

Defaults: provider `deepinfra`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`,
permissions `allow` (unattended workers must not stall on prompts).

A per-task model pin is routed to this single configured provider: use `<model id>` or `deepinfra/<model id>`. A pin that names a different provider (for example `openrouter/...`) passes validation but fails on the first turn with a model-not-found error, because the adapter composes exactly one provider.

| Variable | Purpose |
| --- | --- |
| `KOOKR_OPENCODE_ENABLED` | `1` to enable the agent (default off). |
| `KOOKR_OPENCODE_SEED`, `KOOKR_OPENCODE_SEED_DIR` | Config seed switch (`0` = off) and template location; see [Boot time](#boot-time-and-memory). |
| `KOOKR_OPENCODE_RAM_LIMIT_MB` | TUI heap cap (`BUN_JSC_forceRAMSize`); see [Boot time](#boot-time-and-memory). |
| `KOOKR_OPENCODE_BIN` | Binary path/command override. |
| `KOOKR_OPENCODE_ALLOW_ANY_VERSION` | Skip the pinned-version check (unsupported). |
| `KOOKR_OPENCODE_PROFILES_DIR` | Directory of profile files (default `plugin/opencode-profiles`). |
| `KOOKR_OPENCODE_HOOKS_DIR`, `KOOKR_OPENCODE_BIN_DIR` | Override where the nb hook scripts / bin scripts are found. |
| `KOOKR_OPENCODE_ISSUE` | Issue number `N`; the `scoped-fix` gate then requires `Closes #N` in the commit message. |
| `KOOKR_PR_LINT_CMD` | PR-body lint command run by the gate; `{pr_body}` is replaced by the quoted `PR_BODY.md` path. |
| `KOOKR_OPENCODE_DATA_DIR`, `KOOKR_OPENCODE_DATA_MAX_AGE_DAYS`, `KOOKR_OPENCODE_DATA_MAX_MB`, `KOOKR_OPENCODE_DATA_DONE_TTL_HOURS` | Persistent per-task data root and its retention caps; see [Resume](#resume). |
| `KOOKR_OPENCODE_PLUGIN_DEBUG` | File to append one JSON line per emitted hook. |

## Launching a worker

```sh
kookr spawn --agent opencode "Fix #123: ..."
kookr spawn --agent opencode --profile scoped-fix "Fix #123: ..."
kookr spawn --agent opencode --model deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017 "..."
```

`--profile` requires `--agent opencode`. The same field is `profile` on
`POST /api/tasks`; an unknown id or a non-opencode agent is a `400` with code
`invalid_profile`. The chosen id is stored on the task as
`metadata.opencodeProfile`, so queued promotion and relaunch paths launch with
the same profile.

`POST /api/tasks` also takes `issue` (a positive safe integer, 1 to 9007199254740991; `400 invalid_issue`
otherwise, so a value such as `1e21` that would stringify as `1e+21` is refused, and `400 invalid_profile` for a non-opencode agent). It is stored as `metadata.opencodeIssue` and
exported to the worker's hooks as `KOOKR_OPENCODE_ISSUE`, so the deliverable
gate requires `Closes #<issue>` per task (it wins over a server-wide
`KOOKR_OPENCODE_ISSUE`). Profile and issue are part of the launch identity: the
same prompt with a different profile or issue is a different task, not a
duplicate. A replay of a persisted launch (a provider-transient retry, or
a resume after a provider rate-limit pause) carries the stored `profile` and
`issue` forward, so the replayed worker keeps its profile and gate.

A launch with a `profile` does not get the generic Kookr worktree/delivery
preamble ("create a fresh worktree, push, open and merge a PR"): the caller
prepares the checkout, and the profile plus its deliverable gate define
delivery (a local commit, never a push).

## Profiles

A profile is a Markdown file in `plugin/opencode-profiles/`: a small
frontmatter block, then the worker instructions (written to the session's
`AGENTS.md`).

```markdown
---
id: scoped-fix
description: One-line summary.
permission: allow            # allow | ask
deliverable: commit-and-pr-body   # none | commit-and-pr-body | file:<NAME>
shelves: [patch-author]      # Agent Notebook shelves the worker should open
model: provider/model        # optional pin (a per-task --model wins)
---
Instructions...
```

Only single-line `key: value` entries and one-line `[a, b]` lists are
supported; unknown keys, a bad id, or an empty body fail loudly with the file
name in the message.

| Profile | Deliverable | Use |
| --- | --- | --- |
| `scoped-fix` | one commit + `PR_BODY.md` | Implement one small, well-specified fix with a regression test. |
| `reviewer` | `REVIEW.md` | Read-only review of a diff or merged PR. |
| `test-auditor` | `AUDIT.md` | Find the most valuable untested behaviours in one module and add passing tests. |

Without a profile the worker still gets the default hook set (below) but no
deliverable gate and no extra instructions.

## Hooks, gates and memory

The generated opencode plugin runs Claude-shaped hooks with Claude semantics
(`SessionStart` stdout becomes context; `Stop` exit 2 re-prompts the worker,
at most 4 times):

1. `SessionStart`: `nb-inject.sh` injects the Agent Notebook index.
2. `Stop`, in this order:
   1. **Deliverable gate** (`bin/kookr-opencode-gate.js`, only when the profile
      declares a deliverable). `file:X` requires `X` to exist and be non-empty.
      `commit-and-pr-body` requires no uncommitted tracked changes, at least
      one commit ahead of the launch HEAD (`KOOKR_OPENCODE_GATE_BASE`, injected
      by the adapter; if that commit no longer resolves in the repo the gate falls
      back to the merge-base with `origin/main`/`main`, and says so when none is
      found), `Closes #N` when `KOOKR_OPENCODE_ISSUE` is set,
      `PR_BODY.md`, and a passing PR lint when one is configured. A failure
      exits 2 and tells the worker exactly what is missing. After 3 blocks per
      session the gate lets the worker stop, so it can never trap it.
   2. `nb-retro.sh`: the one-time notebook retrospective (vote, prune, add at
      most one lesson).
   3. `kookr-stop-nudge.js`: the once-per-task completion-ready reminder (its
      45 s task-age gate is disabled for opencode workers, which routinely
      finish faster than that).

The order is deliberate: the worker finishes the work, then reflects, then
signals completion. A `completion_ready` signal is cleared when the turn
resumes, so the signal must come after the retrospective re-prompt, never
before it. A block by one of these Kookr hooks does not mark the next Stop as a
stop-hook re-entry, so the later hooks still run.

When the session is stopped, Kookr sums the tokens and cost from the task's
opencode database into the task's token usage (best effort; a missing database
leaves usage unset). After a resume the database holds the whole conversation,
so the usage is the cumulative total, not just the resumed part.

## Resume

Reopening a task, or crash recovery relaunching it, passes the previous session
to `launch(..., resume)`. For opencode that now continues the same opencode
conversation instead of starting over.

- **Persistent data per task.** opencode keeps its conversation in a sqlite
  database under `XDG_DATA_HOME`. The adapter points `XDG_DATA_HOME` at
  `<data dir>/opencode-data/<taskId>/data` instead of the throwaway session
  directory, so the database survives `stop`. Everything else (config, plugin,
  `AGENTS.md`, hook files) stays in the per-session directory and is deleted
  on stop as before. `KOOKR_OPENCODE_DATA_DIR` moves the root.
- **Which session.** On stop the adapter reads the newest root session
  (`ses_...`) from that database and stores it as `metadata.opencodeSessionId`
  on the task (visible in the task JSON). Kookr's own `claudeSessionId` for an
  opencode task is the terminal session name, not opencode's id, so resume
  looks the real id up in the database (preferring `metadata.opencodeSessionId`
  while that row exists).
- **Relaunch.** A resumed launch runs `opencode --session <ses_id> <cwd>`
  with a freshly composed session directory (plugin, hooks env, profile
  `AGENTS.md`, shelf lessons) pointing at the same data. Like the Claude
  adapter, it delivers no initial prompt: the conversation already contains it.
  Send the next instruction with `POST /api/agents/:id/message`. The
  deliverable gate keeps counting commits from the HEAD recorded at the first
  launch (stored beside the database), not the current HEAD. The same base is kept
  for a non-resume relaunch of the same task (for example crash recovery after
  the worker already committed) while it still exists in the repo; a new base
  is recorded only when none is stored or the stored one is gone.
- **Fallback.** If the task's database or session cannot be found (for example
  the data was already cleaned up, or a non-resume relaunch) the adapter logs a
  warning and launches fresh with the prompt, discarding stale data of that
  task id. A fresh launch always starts from an empty data dir.
- **Unreadable database.** Absent, zero-byte or session-less databases mean
  "nothing to resume" and fall back as above. A database that exists but
  cannot be read (locked, schema drift, native addon failure) is not treated
  as empty: the resume launch fails with `OpenCodeSessionUnreadableError`
  (code `opencode_session_unreadable`), the data is kept untouched, and the
  operator can retry once the database is readable.
- **Aborted and timed-out launches.** A launch aborted at any point (including
  before the session is created) releases its session directory and
  bookkeeping. The task-data directory carries a per-launch token in its
  ownership marker; a failed launch's late cleanup only removes a directory
  carrying its own token, so a retry of the same task that recreated the
  directory keeps it. Sweeps and fresh-launch resets match on the task id only.
- **Cleanup and caps.** Disk use is bounded by a retention sweep that runs
  at the first launch after boot, on every launch (at most once a minute) and
  after every stop (immediately and again 5 s later, which catches a delete
  or complete that caused the stop). It removes a task's data when the task no
  longer exists, `KOOKR_OPENCODE_DATA_DONE_TTL_HOURS` (24) after the task was
  completed or cancelled (so a reopen can still resume), when it has been
  unused for `KOOKR_OPENCODE_DATA_MAX_AGE_DAYS` (14), and least-recently-used
  first while the total exceeds `KOOKR_OPENCODE_DATA_MAX_MB` (1024). A
  `terminated` task (crash, abort the operator may reopen) is kept until
  those caps. Dirs of live sessions are never swept: a session of this process, a launch in flight, and any task that is still `open`/`pending`/`inProgress` in the task store (a terminal session can outlive a Kookr restart) are exempt from every cap. There is no task-status
  event to hook, so cleanup is lazy: deleting an idle task with no live
  session leaves its data until the next sweep (any opencode launch or stop).
  To purge by hand, delete `<data dir>/opencode-data/<taskId>`.

## Boot time and memory

Every fresh `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME/opencode` makes opencode
run an in-process `npm install @opencode-ai/plugin@1.19.5` (64 MB, 6-7 s each;
with no network the TUI never becomes ready). Kookr builds a seed template once
(`prepareOpenCodeSeed`: runs the pinned opencode with a throwaway config dir,
under a lock, atomically, into `~/.kookr/tools/opencode-<ver>/seed` or
`KOOKR_OPENCODE_SEED_DIR`) and hardlinks it into both locations of every
session (copy fallback across devices, no extra disk). Seeded sessions also get
`OPENCODE_FAST_BOOT=1`; unseeded ones never do (it lost the first prompt
without the seed). If the seed cannot be built, a warning is logged and sessions
boot unseeded.

`FAST_BOOT`: `KOOKR_OPENCODE_FAST_BOOT=1` additionally sets `OPENCODE_FAST_BOOT=1`
on seeded sessions. It is off by default: with no terminal attached to the
session (the normal case) the TUI never painted the composer in live tests
(0/3 prompts delivered), so only enable it where a terminal is attached.
Measured live (3 runs each, launch to prompt acknowledged): unseeded median
10.8 s, seeded median 5.3 s.

RAM cap: `KOOKR_OPENCODE_RAM_LIMIT_MB` (default 512, `0` = off) sets
`BUN_JSC_forceRAMSize` for the TUI. On the fixture fix-a-failing-test task with
the `scoped-fix` profile, peak process-tree RSS was 556/599 MB with the cap vs
798/798 MB without it, with the task succeeding in all four runs. The task is
small (about 15 s); a long task that really needs a larger heap may want
`0` or a higher value.

## Profile memory

`shelves: [...]` in a profile's frontmatter scopes the notebook content: at
launch the adapter runs `nb show <shelf>` for each of the profile's shelves
(session `NB_DIR`, 4 s timeout each, fail-open, at most about 6 KB per shelf and
16 KB total, truncated with a marker) and appends a `## Lessons from your
shelves` section to the session's `AGENTS.md`. The notebook index that
`nb-inject.sh` injects at SessionStart stays intentionally global (shelf names
and descriptions only), so a worker can still discover other shelves, but only
its own shelves' lesson text is preloaded. The profiles also carry a short `kb`
usage block (one focused `kb search "<question>" --kb=<name>`, tolerate
failure: `kb search` needs an embedding provider and an initialised index).

## Limits

- The Settings dialog lists opencode (effort row, blacklist checkbox) and the
  launch pickers offer it only when the server registered it, that is when
  `KOOKR_OPENCODE_ENABLED` is set.

- The TUI takes about 22 s to paint on first boot, so launches are slow and
  the ready timeout is 60 s.
- Expect roughly 0.6-0.8 GB resident memory per worker (about 1.2 GB on long tasks, uncapped); size concurrency
  accordingly.
- Resume needs the task's persistent data (see [Resume](#resume)); once it has been swept, a reopen starts fresh.
- One pinned opencode release (1.19.5); other versions are refused.
- Profile `permission: ask` stalls an unattended worker; the shipped profiles
  all use `allow`.
