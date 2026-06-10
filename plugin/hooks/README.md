# Kookr Toolkit Hooks

Plugin hooks are registered through `plugin/hooks/hooks.json`, not through the
plugin manifest. Claude Code loads these hooks when the toolkit is supplied via
`--plugin-dir`.

## Registered Hooks

`reflect-memory-frontmatter-gate.sh` blocks unsafe memory writes from reflection
workflows when the frontmatter marks the entry as behavioral feedback. It is
registered for `Write`, `Edit`, and `MultiEdit` events.

## Skill Load Counter

`skill-load-counter.sh` is an append-only telemetry hook registered for
`PreToolUse` with matcher `Skill`. On every skill invocation it appends
`{"skill": "<name>", "ts": "<utc>"}` to `~/.claude/kookr-skill-load-log.jsonl`
(override the path with `KOOKR_SKILL_LOAD_LOG`; disable with
`KOOKR_SKILL_LOAD_COUNTER_SKIP=1`). It never blocks the invocation: every
failure path (missing jq, malformed payload, unwritable log) exits 0 silently.
The data informs which skills actually get used when scoping quality passes
(RFC plugin-skill-improvements, Phases 2-3).

## Placement Gate

`placement-gate.sh` is an advisory `PreToolUse` hook for new skills and agents.
It performs deterministic path checks only:

- In the Kookr repo, new `.claude/skills/<name>/` files warn unless `<name>`
  starts with `kookr-`.
- New `plugin/skills/kookr-*/` files are allowed for Kookr-runtime skills that
  agents need outside the Kookr repo.
- New `.claude/skills/<name>/` files warn when `plugin/skills/<name>/` already
  exists.
- New `plugin/agents/kookr-*.md` files are allowed for distributed Kookr-domain
  agents.
- In the Kookr repo, new `.claude/agents/<name>.md` files warn unless `<name>`
  starts with `kookr-`.

The gate ignores `node_modules/`, `dist/`, `build/`, `target/`, `.next/`,
`.svelte-kit/`, and Kookr-managed `.claude/worktrees/` paths.

By default the hook warns and allows the tool call. To make warnings block in a
repo, create `.kookr-placement-gate-strict` at the main checkout root. The hook
resolves this marker through `git rev-parse --git-common-dir`, so one marker
covers linked worktrees. For a deliberate one-off bypass, set
`KOOKR_PLACEMENT_GATE_SKIP=1` on the tool call environment.

For Bash tool calls, the hook inspects only literal writes using `cat >`,
`cat >>`, `printf ... >`, `echo ... >`, `tee`, `tee -a`, `cp`, and `mv`. It
does not try to evaluate variables, interpreter-internal writes, `dd of=`, or
Codex `apply_patch`. The push-time `hooks/skill-placement-gate.sh` remains the
cross-runtime final catch-net for the Kookr repo.

As of PoC 008, Claude Code loads plugin hooks via `--plugin-dir`; Kookr's Codex
fork discovers plugin skills through `--plugin-dir` but does not yet load plugin
hooks from that path.
