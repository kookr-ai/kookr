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
| `KOOKR_OPENCODE_HOOKS_DIR`, `KOOKR_OPENCODE_BIN_DIR` | Override where the nb hook scripts / bin scripts are found. |
| `KOOKR_OPENCODE_DATA_DIR`, `KOOKR_OPENCODE_DATA_MAX_AGE_DAYS`, `KOOKR_OPENCODE_DATA_MAX_MB`, `KOOKR_OPENCODE_DATA_DONE_TTL_HOURS` | Persistent per-task data root and its retention caps; see [Resume](#resume). |
| `KOOKR_OPENCODE_PLUGIN_DEBUG` | File to append one JSON line per emitted hook. |

## Launching a worker

```sh
kookr spawn --agent opencode "Fix #123: ..."
kookr spawn --agent opencode --model deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017 "..."
```

`--agent opencode` is accepted by `kookr spawn`, and `agentType: "opencode"` by
`POST /api/tasks`. `--model` takes a `provider/model` id for opencode (the
fixed model allowlists of the other agents do not apply).

## Hooks and memory

The generated opencode plugin runs Claude-shaped hooks with Claude semantics
(`SessionStart` stdout becomes context; `Stop` exit 2 re-prompts the worker,
at most 4 times):

1. `SessionStart`: `nb-inject.sh` injects the Agent Notebook index.
2. `Stop`, in this order:
   1. `nb-retro.sh`: the one-time notebook retrospective (vote, prune, add at
      most one lesson).
   2. `kookr-stop-nudge.js`: the once-per-task completion-ready reminder (its
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
  with a freshly composed session directory (plugin, hooks env,
  `AGENTS.md`, shelf lessons) pointing at the same data. Like the Claude
  adapter, it delivers no initial prompt: the conversation already contains it.
  Send the next instruction with `POST /api/agents/:id/message`.
- **Fallback.** If the task's database or session cannot be found (for example
  the data was already cleaned up, or a non-resume relaunch) the adapter logs a
  warning and launches fresh with the prompt, discarding stale data of that
  task id. A fresh launch always starts from an empty data dir.
- **Cleanup and caps.** Disk use is bounded by a retention sweep that runs
  at the first launch after boot, on every launch (at most once a minute) and
  after every stop (immediately and again 5 s later, which catches a delete
  or complete that caused the stop). It removes a task's data when the task no
  longer exists, `KOOKR_OPENCODE_DATA_DONE_TTL_HOURS` (24) after the task was
  completed or cancelled (so a reopen can still resume), when it has been
  unused for `KOOKR_OPENCODE_DATA_MAX_AGE_DAYS` (14), and least-recently-used
  first while the total exceeds `KOOKR_OPENCODE_DATA_MAX_MB` (1024). A
  `terminated` task (crash, abort the operator may reopen) is kept until
  those caps. Dirs of live sessions are never swept. There is no task-status
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
a scoped-fix task, peak process-tree RSS was 556/599 MB with the cap vs
798/798 MB without it, with the task succeeding in all four runs. The task is
small (about 15 s); a long task that really needs a larger heap may want
`0` or a higher value.

## Shelf memory

When the adapter is configured with notebook shelves (`OpenCodeAdapterOptions.profile.shelves`),
the adapter runs `nb show <shelf>` for each shelf at launch (session `NB_DIR`,
4 s timeout each, fail-open, at most about 6 KB per shelf and 16 KB total,
truncated with a marker) and appends a `## Lessons from your shelves` section
to the session's `AGENTS.md`. The notebook index that `nb-inject.sh` injects at
SessionStart stays intentionally global (shelf names and descriptions only), so
a worker can still discover other shelves, but only the configured shelves'
lesson text is preloaded.

## Limits

- The TUI takes about 22 s to paint on first boot, so launches are slow and
  the ready timeout is 60 s.
- Expect roughly 0.6-0.8 GB resident memory per worker (about 1.2 GB on long tasks, uncapped); size concurrency
  accordingly.
- Resume needs the task's persistent data (see [Resume](#resume)); once it has been swept, a reopen starts fresh.
- One pinned opencode release (1.19.5); other versions are refused.
- `permission: ask` stalls an unattended worker; the default is `allow`.
