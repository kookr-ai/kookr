# POC — Cross-Agent Task Migration (empirical validation)

**Date:** 2026-08-12
**Script:** `docs/poc/rfc-cross-agent-task-migration-poc.mjs` (read-only; no
launches, no store mutation, git invoked read-only only).

## What it validates

1. Interrupted/migratable tasks exist in real local stores.
2. Migratability is classifiable from persisted state alone.
3. A cross-agent continuation brief is constructible from **portable** state
   (intent + git worktree progress) with **no vendor transcript**.

## Run 1 — `--to claude-code` (all source agents)

Scanned 8 stores (`~/.kookr`, `~/.kookr-4801`, … `~/.kookr-4911`):

```
tasks scanned: 833
migratable to claude-code: 117

By source agent:
  grok-build   total=806 migratable=117  [completed:666 terminated:89 cancelled:39 inProgress:11 open:1]
  claude-code  total=25  migratable=0    [completed:23 terminated:2]
  codex-cli    total=2   migratable=0    [terminated:1 completed:1]

Not-migratable reasons:
  status_not_migratable        690   (completed / no dead-session interruption)
  workflow_owner_unsupported   23    (Ralph loops)
  cwd_gone                     3     (worktree removed)
```

**The scenario is real and dominant.** The overwhelming majority of local tasks
(806/833) ran under Grok Build; 117 are interrupted (`terminated`/`cancelled`)
with an intact worktree and reconstructable intent — exactly the backlog the
user wants to move to Claude Code when Grok quota is exhausted. `cwd_gone` (3)
confirms `missing_cwd`/`cwd_gone` must be a first-class blocked reason, and
`workflow_owner_unsupported` (23) confirms Ralph loops must be excluded.

## Run 2 — continuation brief reconstruction (`--show-brief --git`)

For a real interrupted Grok task (`623714ea`, a Codex-fork sync task) the brief
rebuilt the full original intent verbatim plus handoff framing. For `4a4ebf50`
the git summary surfaced the actual recent commits the interrupted agent left on
disk:

```
Work already on disk (from the interrupted grok-build session):
  - recent commits:
    99a2504d feat(control-room): shared empty/degraded state CTA pattern ...
    64ad48a6 feat(control-room): mission board top-N urgency rows ...
    ...
```

**Confirmed:** the new agent can be told what the old agent already did from
ground truth on disk, without touching any Grok transcript. The portable-state
hypothesis holds.

## Caveats (POC vs production)

- The POC's "live session" check is a heuristic on persisted `lastStatus`; the
  production classifier must probe the dtach backend for real liveness (as the
  restore service does).
- `includeCancelled` is not modeled in the POC (it counts `cancelled` as
  migratable); production gates `cancelled` behind an explicit opt-in.
- The POC does not exercise backpressure, attempt state, or the default-agent
  write — those are design elements validated by tests, not this scan.
