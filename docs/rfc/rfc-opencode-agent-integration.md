# RFC: opencode Agent Integration (lightweight scoped-work worker)

**Status:** Draft v1 (evidence-backed, pre-implementation)
**Date:** 2026-11-09
**Author:** Jean Ibarz (with Claude Code)

---

## Summary

Kookr should add [opencode](https://github.com/anomalyco/opencode) (MIT) as a
fourth managed agent type (`opencode`) through a dedicated `OpenCodeAdapter`,
modelled on `GrokBuildAdapter`. Its job is **not** end-to-end SDLC work. It is a
cheap, fast, low-memory worker for **small, well-scoped, well-specified units
of work** (a bug fix with a reproduction, a coverage-gap audit, a PR review, a
mutation-test pass), supervised by Kookr exactly like Claude Code tasks:
start / stop / monitor / send instructions / completion signals / memory.

The first slice reuses the existing machinery: an interactive TUI session in a
dtach terminal, per-session hook emission into `kookr-hook-writer`, the adapter
registry, prompt delivery by bracketed paste, `kb` spool shim on `PATH`. No new
transport is introduced. `opencode serve` / ACP stay later options.

## Evidence (agent bake-off, 2026-11-08/09)

Same model everywhere (DeepSeek-V4.1-Flash via DeepInfra), 10 replayed issues,
opencode / qwen-code / pi / Hermes, graded against the merged reference PR's
tests. Full data: `~/hermes-sandbox/shadow-run/bakeoff/REPORT*.md` (restored
after an incident; regenerated numbers are marked as such there).

- opencode was the fastest and cheapest (~0.5k s avg vs ~1.2k s Hermes;
  ~$0.02-0.03 per case) with tight diffs, correctness at least equal to the
  others on cases with unambiguous tests.
- Raw delivery is dominated by **PR-checklist honesty**, not code. A
  lint-feedback continuation ("deliver-or-continue", max 2 nudges) lifted
  opencode from ~5/10 to 10/10 delivered without changing any code.
- Verified on a host terminal session (this RFC's POC, below): opencode 1.19.5
  runs in a terminal multiplexer session, accepts a bracketed-paste prompt, and
  a plugin loaded from `OPENCODE_CONFIG_DIR/plugins/` receives
  `tool.execute.before` (with the bash command), `tool.execute.after`,
  `session.created`, `session.status`, `session.idle`.
- `nb` and `kb` CLIs run inside opencode sessions (nb read+write verified).
- Memory: idle `opencode serve` ~80-190 MB; ~1 GB container peak while working
  (spawns an `opencode serve --stdio` child). See the Memory section of the
  bake-off report for method and caveats.
- Caveats that shape the design: the plugin API changed incompatibly between
  1.19.x (named-export plugins, `tool.execute.*`) and v2.2.x
  (`Plugin.define`, `experimental.idle`, `ctx.session.synthetic`); npm `latest`
  lags GitHub releases; ~2 of 13 review-pilot runs ended with malformed
  tool-call markup / a degenerate loop and produced no output.

## Goals

1. `opencode` selectable as an agent type for a Kookr task; Kookr can start,
   stop, tail, send instructions, and gate completion like Claude tasks.
2. Hook trail parity for the events Kookr consumes (status machine, hung-suspect
   TTL, lesson-decision gate, token accounting).
3. Memory integration: `nb` index injected at session start, `nb` retro at the
   end, `kb` available with the spool shim, instructions that depend on the
   **profile** (role) the task runs under.
4. Per-session isolation (config, data/DB, plugins), no mutation of the
   operator's real `~/.config/opencode` or `~/.local/share/opencode`.
5. Deliver-or-continue: a bounded, deterministic nudge loop when the worker
   idles before its deliverable gate passes.
6. Scale: many concurrent workers with a measured, bounded RAM cost.

## Non-goals

- Replacing Claude Code for large/ambiguous work. Replacing Hermes' A2A gateway.
- A Kookr-native agent loop. Forking opencode.
- Supporting both plugin API generations in the first slice (pin one).
- ACP / `opencode serve` control plane in the first slice.

## Design

### 1. Binary identity and pinning
Kookr pins opencode by **release version + sha256** (never npm `latest`). First
slice pins `opencode-ai@1.19.5` (installed under `~/.kookr/tools/`, preflight
checks `--version`). Upgrading is an explicit change that re-runs the plugin
contract test (the 1.x and 2.x plugin shapes are incompatible).

### 2. Adapter
`OpenCodeAdapter implements AgentAdapter`, registered in
`create-agent-runtime.ts` only when `preflight()` is ok (like Codex/Grok). It
launches `opencode <cwd>` in the dtach session with a per-session environment:

- `OPENCODE_CONFIG=<sessionDir>/opencode.json` (provider/model/permissions)
- `OPENCODE_CONFIG_DIR=<sessionDir>/cfg` (plugins, skills, agents, commands)
- `XDG_DATA_HOME=<sessionDir>/data` (per-session sqlite DB for usage scanning)
- the standard Kookr launch env (`KOOKR_TASK_ID`, ..., PATH with `kb` shim)
- the model API key from the Kookr-managed secret source, never from argv.

The prompt is delivered with the existing `deliverInitialPromptToSession`
(bracketed paste + submit confirmation); busy-pane detection needs an
opencode-specific matcher.

### 3. Per-session composer (profiles)
`opencode-home-composer.ts` (analogue of `grok-home-composer.ts`) writes the
session dir: `opencode.json`, `cfg/plugins/kookr.js` (hook emitter),
`cfg/AGENTS.md` (profile instructions), and the skills/commands for the profile.
A **profile** is a named bundle (instruction text, enabled skills, model/effort
tier, permission posture, memory shelves, deliverable gate). Profiles are data
(`plugin/opencode-profiles/*.md|json`), selected per task.

### 4. Hook emitter (plugin) and event mapping
The generated plugin shells the existing `kookr-hook-writer.js` with
**Claude-shaped payloads**, so `HookIngestion`, the status machine, hung-suspect
TTL and the lesson-decision gate need no changes:

| opencode event | Kookr hook event | payload notes |
|---|---|---|
| plugin load / `session.created` | `SessionStart` | `source: startup` |
| `chat.message` (user part) | `UserPromptSubmit` | prompt text |
| `tool.execute.before` | `PreToolUse` | `tool_name` mapped (`bash` -> `Bash`), `tool_input.command` for Bash (**required** by the lesson-decision gate) |
| `tool.execute.after` | `PostToolUse` | |
| `permission.ask` | `PermissionRequest` | only if permissions not preset to allow |
| `session.idle` | `Stop` | |
| `session.error` | `StopFailure` | |
| process exit | `SessionEnd` | via adapter |

Contract test: a recorded opencode event stream -> expected hook JSONL ->
`HookIngestion` -> expected `AgentEvent`s.

### 5. Completion and the lesson gate
`kookr signal completion-ready` keeps its gates (#1538 lesson decision scanned
from PreToolUse Bash commands; merge-required gate). The profile instructions
tell the agent the exact sequence, and a Stop-equivalent nudge (below) reminds
once, as `kookr-stop-nudge.js` does for Claude.

### 6. Deliver-or-continue
A plugin `session.idle` handler runs the profile's **deliverable gate**
(e.g. commit present + `pr-body-lint`; or "REVIEW.md exists") and, if it fails,
re-prompts the session with the gate output, at most N times (default 2). On
1.19.x this uses the SDK client `session.prompt`; on v2.x
`ctx.session.hook('experimental.idle')` + `ctx.session.synthetic` (verified in a
toy run in the bake-off). The counter lives in the session dir. Every nudge is
written to the hook trail so it is visible and auditable.

### 7. Memory (nb / kb)
- `kb`: already on `PATH` via the launch-context shim (spool when degraded).
- `nb`: a `SessionStart`-time index injection into `AGENTS.md` (profile-aware
  shelf list), the same index Claude sessions get; a retro step at the end
  (`nb vote/rm/add`) driven by the same idle-gate mechanism as the nudge.
- Profile decides which shelves are advertised and the instruction text
  ("check `nb show <shelf>` before X, `nb add` at most one lesson").
- Tested with a scripted agent (deterministic) and with real runs (nb read+write
  verified in the bake-off, 3 harnesses).

### 8. Sessions, usage, cost
`opencode-usage-scanner.ts` reads the per-session `opencode.db` (messages carry
`tokens` and `cost`) into Kookr's token accounting; the Claude transcript token
processor skips `opencode` (as it skips `grok-build`). Version-gate the DB
schema (1.x vs 2.x differ).

### 9. Process family and resources
`resource-watchdog-sampler.ts` / `resource-watchdog-eval.ts` learn the opencode
process family (`opencode`, `opencode serve --stdio`). Per-worker RSS and cgroup
numbers feed the scale limits in the rollout thresholds.

### 10. Permission posture
Host-side, same posture as Claude workers in Kookr (`permission: allow` for
edit/bash/external_directory inside the worktree). No remote credentials in the
worker env beyond what the task needs. A container/sandbox mode is a later
option (the bake-off ran in containers).

## Files expected to change
`src/shared/contracts/agent-types.ts` (+ per-agent switches), `src/adapters/`
(`opencode-adapter.ts`, `opencode-preflight.ts`, `opencode-home-composer.ts`,
`opencode-instrumentation/`, `opencode-usage-scanner.ts`, tests),
`src/server/bootstrap/create-agent-runtime.ts`, `routing-agent-adapter` (no
change expected), `token-accounting-processor.ts` (skip), watchdog sampler/eval,
`frontend/presentation.ts`, `cli/kookr-completion.ts`, docs, profiles under
`plugin/opencode-profiles/`.

## Rollout and acceptance

- **Phase 0 (done):** bake-off evidence; host POC (TUI + plugin hooks).
- **Phase 1:** instrumentation + adapter behind preflight, contract tests, one
  supervised session end-to-end (start, tail, send input, stop, hook trail,
  lesson gate pass, completion signal).
- **Phase 2:** profiles + memory integration + deliver-or-continue; usage
  scanner; frontend selector.
- **Phase 3:** dogfood on real scoped tasks (target 20-30), measured vs Claude
  and Hermes baselines.
- **Phase 4:** scale test (N concurrent), upgrade path to v2.x plugin API.

Quantitative thresholds before "default for scoped work": delivered-and-correct
rate within 10 points of the Claude baseline on scoped tasks; <= 1.2 GB
cgroup peak per worker and measured N=8 concurrent workers on 16 GB without OOM;
empty-output/garbled-run rate < 5% with one wrapper retry; zero hook-trail gaps
that trip the hung-suspect TTL on a 70-minute silent test run.

## Riskiest unknowns (each with a cheap test)

1. **Plugin API churn** — idle-nudge plugin on the pinned version, 10 runs on a
   case that always fails lint first; success = 10/10 delivered after <= 2
   nudges, no infinite loop.
2. **Watchdog interaction** — 70-minute silent tool call with vs without the
   heartbeat; confirm hung-suspect behaviour.
3. **Garbled/empty runs** — 30 identical short tasks; count and test a one-shot
   fresh-session retry.
4. **Checklist honesty without a nudge** — sample 20 delivered PR bodies, diff
   ticked boxes against patches; target <= 1 false tick.
5. **RAM at concurrency** — 8 concurrent workers on one 16 GB host; watch
   cgroup peaks, OOM kills, wall times.

## Test isolation (safety facts)

The live harnesses never touch the production Kookr (port 4800, `~/.kookr`,
`~/git/kookr-prod`). Verified from the scripts:

- `scripts/opencode-kookr-e2e.ts` starts a Kookr server from the checkout with a
  **hermetic environment** (`env` rebuilt from scratch: temp `HOME`, so the data
  dir is `<tmp>/home/.kookr-<port>`; loopback; a free random port; no relay,
  Telegram, STT/TTS; no inherited `KOOKR_*` variable). It kills only the PID it
  spawned (never `pkill` by name) and removes its own temp dirs.
- `scripts/opencode-live-e2e.ts` uses its own `LocalDtachBackend` instance id and
  socket dir (`/tmp/oclive-<pid>`), a temp git repo, a temp hooks dir and a temp
  `NB_DIR`; it terminates only the sessions it created.
- Sessions are namespaced by Kookr port / dtach instance id, so a test server on
  port N never attaches to production sessions on 4800.
- Known residual: process-family counts in the resource watchdog are host-wide
  (they include other opencode processes on the machine); per-session temp dirs
  use the prefix `kookr-opencode-kookr-*` under `$TMPDIR` (read-only scans in the
  script, no deletion of unknown dirs).
- Incident (honest record): the first isolated-server start in the E3 run
  inherited the operator shell's `KOOKR_*` variables (`KOOKR_STT=true`, Telegram,
  relay) and began starting STT containers; it was killed within seconds and the
  harness now rebuilds the environment from scratch. The operator's `kookr-stt`
  containers were verified healthy afterwards.
- Disk: the admission gate needs `KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT=1` on a
  nearly-full `/tmp`; the harness sets it only for its own server.

## Scaling architecture (measured)

Measurements on this host (16 cores; shared and sometimes loaded by other agents;
n=1..3 per cell; tiny-to-small tasks unless noted):

| architecture | per-worker memory | evidence |
|---|---|---|
| standalone TUI in dtach (default, implemented) | ~1.0 GB PSS / 1.2-1.5 GB RSS live under Kookr (lab: ~650 MB RSS at rest) | Kookr-driven runs: 8 concurrent workers = 8.1 GB PSS, 11 GB RSS, 8/8 delivered, no 429s, 0 launch failures; heavy repos add test-runner children (+3-5 GB) |
| shared `opencode serve` + attached TUIs (`opencode attach URL --dir <repo>`) | ~290-360 MB marginal (server 240 MB idle + ~220-250 MB per client) | identical interactive TUI; one server core saturates as clients are added (sequential prompts 8-12 s at N=8 vs ~3 s at N=1); shared crash domain |
| `opencode run --attach` CLI clients on a shared server | ~350-400 MB peak | earlier study, no TUI |
| direct HTTP/SDK client | ~75-100 MB | earlier study; needs a Kookr-native adapter |
| (reference) Hermes container | ~2.0-2.6 GB cgroup peak (3 GB cap) | read-only sampling of one run |

Decision: keep the **standalone TUI as the default** (isolation, simplest
supervision, ~12 workers per 16 GB on live tasks). Offer **shared server +
attached TUIs as an opt-in mode** only when memory binds, capped at 6-8 workers
per server, launches staggered ~10 s apart, several servers if needed. For
20+ workers a direct HTTP/SDK adapter is the better path. Boot: seed the plugin
`node_modules` into both config dirs (fresh config dirs otherwise trigger an
in-process `npm install` taking 6-7 s each; seeded boot ~4.5 s, ~2.2 s with
`OPENCODE_FAST_BOOT=1`).

Attach-mode facts needed if it is implemented: the plugin is instantiated once
per `--dir` with `ctx.directory` = the worker dir, hook events carry `sessionID`
(verified no cross-attribution at N=8); `client.session.promptAsync` on
`session.idle` reaches the right attached TUI; the bash tool inherits the
**server's** env, so per-task env (`KOOKR_TASK_ID`, `NB_DIR`,
`KOOKR_OPENCODE_ISSUE`, PATH shims) must be set from `ctx.directory` in a
`shell.env` hook; per-worker `AGENTS.md`/`opencode.json` live in the worktree;
killing a client leaves the turn running (resume with `attach -s <sid>`), killing
the server orphans in-flight bash children and interrupts every worker's turn.

## Open questions

- Does bracketed-paste prompt delivery need a longer submit-confirm window for
  opencode's TUI under load?
- Can opencode's `chat.message` hook expose the exact user prompt for
  `UserPromptSubmit` on 1.19.x?
- Where should the model API key live for host workers (Kookr secret store vs
  per-profile env)?
