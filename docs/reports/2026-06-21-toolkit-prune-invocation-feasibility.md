# Toolkit Invocation Capture And Prune Feasibility

Date: 2026-06-21
Issue: #1091

## Summary

The falsification test did not falsify automated toolkit invocation counting.
Kookr hook JSONL already records skill and agent invocation identities under
`permission_mode: bypassPermissions`, so `KOOKR_BYPASS_ALL_PERMISSIONS` sessions
are capturable from Kookr-owned hooks.

The right mechanism is to aggregate Kookr hook events from `~/.kookr/hooks/*.jsonl`
and count successful `PostToolUse` records:

- Skills: `tool_name == "Skill"`, identity from `tool_input.skill` with
  `tool_response.commandName` as confirmation.
- Agents: `tool_name == "Agent"` or `tool_name == "spawn_agent"`, identity from
  `tool_input.subagent_type`, `tool_input.agent_type`, or event-level
  `agent_type`.

Do not prune from this one-time sample. It proves the data path, but it is not a
controlled 90-day disuse window and does not cover normal non-bypass sessions in
this local archive. The evidence-backed prune list for this pass is therefore
empty.

## Evidence From Local Hook Data

Commands were run from a clean worktree based on `origin/main`.

Hook archive:

```bash
find ~/.kookr/hooks -maxdepth 1 -type f -name '*.jsonl' -printf '%p\n' | wc -l
# 1398

find ~/.kookr/hooks -maxdepth 1 -type f -name '*.jsonl' -printf '%p\n' \
  | xargs -r jq -r 'select(type=="object") | 1' | wc -l
# 410717
```

Skill identity capture:

```bash
find ~/.kookr/hooks -maxdepth 1 -type f -name '*.jsonl' -printf '%p\n' \
  | xargs -r jq -r '
      select(type=="object"
        and .hook_event_name=="PostToolUse"
        and .tool_name=="Skill") | 1' | wc -l
# 101

find ~/.kookr/hooks -maxdepth 1 -type f -name '*.jsonl' -printf '%p\n' \
  | xargs -r jq -r '
      select(type=="object"
        and .hook_event_name=="PostToolUse"
        and .tool_name=="Skill"
        and ((.tool_input.skill // .tool_response.commandName // "") == "")) | 1' | wc -l
# 0

find ~/.kookr/hooks -maxdepth 1 -type f -name '*.jsonl' -printf '%p\n' \
  | xargs -r jq -r '
      select(type=="object"
        and .hook_event_name=="PostToolUse"
        and .tool_name=="Skill") | .permission_mode // "<missing>"' \
  | sort | uniq -c
#     101 bypassPermissions
```

Observed skill identities included:

```text
32 kookr-toolkit:pre-pr-review
19 kookr-toolkit:self-continuation-task
10 kookr-toolkit:rfc-iterative-review
7 pre-pr-review
5 kookr-toolkit:task-snapshot-reflect
3 kookr-toolkit:ui-mockup-variants
3 kookr-toolkit:github-issue-workflow
2 kookr-toolkit:task-feedback-reflect
2 kookr-toolkit:self-reflect
2 kookr-toolkit:architecture-drift-signals
1 kookr-toolkit:domain-driven-design
1 kookr-toolkit:claude-code-hooks
```

Agent identity capture:

```bash
find ~/.kookr/hooks -maxdepth 1 -type f -name '*.jsonl' -printf '%p\n' \
  | xargs -r jq -r '
      select(type=="object"
        and .hook_event_name=="PostToolUse"
        and (.tool_name=="Agent" or .tool_name=="spawn_agent")) | 1' | wc -l
# 2825

find ~/.kookr/hooks -maxdepth 1 -type f -name '*.jsonl' -printf '%p\n' \
  | xargs -r jq -r '
      select(type=="object"
        and .hook_event_name=="PostToolUse"
        and (.tool_name=="Agent" or .tool_name=="spawn_agent")) |
      .permission_mode // "<missing>"' \
  | sort | uniq -c
#    2825 bypassPermissions
```

Some generic agent invocations have identities such as `default`,
`general-purpose`, or `explorer`; these are not toolkit-specific and should be
excluded from toolkit pruning decisions. Qualified toolkit agent identities are
capturable, for example:

```text
53 kookr-toolkit:failure-mode-analyst
24 kookr-toolkit:design-minimalist
19 kookr-toolkit:socratic-challenger
19 kookr-toolkit:boundary-critic
18 kookr-toolkit:delivery-pragmatist
16 kookr-toolkit:ambition-amplifier
14 kookr-toolkit:test-quality-reviewer
8 kookr-toolkit:operability-reviewer
5 kookr-toolkit:design-experimenter
3 kookr-toolkit:module-interface-auditor
3 kookr-toolkit:dependency-graph-analyzer
2 kookr-toolkit:architecture-smell-scanner
1 kookr-toolkit:architecture-drift-detector
```

## Canonical Inventory

The inventory below is from the canonical plugin tree only. Worktree duplicates
are intentionally excluded.

```bash
find plugin/skills -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | wc -l
# 57

find plugin/agents -mindepth 1 -maxdepth 1 -type f -name '*.md' -printf '%f\n' | sort | wc -l
# 18

find plugin/reviewer-specialists -mindepth 1 -maxdepth 1 -type f -name '*.md' -printf '%f\n' | sort | wc -l
# 5
```

Current canonical totals:

- 57 plugin skills.
- 18 plugin agents in `plugin/agents/`.
- 5 reviewer specialists in `plugin/reviewer-specialists/`.
- 23 agent-like markdown files if agents and reviewer specialists are counted
  together.

## Prune Decision

Prune list: none.

Reason:

- The hook data proves automated invocation counting is feasible for bypass
  sessions.
- The archive is an opportunistic local sample, not a committed observation
  window.
- Normal non-bypass sessions are not represented in the observed successful
  `Skill`, `Agent`, or `spawn_agent` samples.
- Several toolkit items have no observed invocation in this sample, but absence
  from an under-sampled archive is not evidence of disuse.

## Acceptance Criterion For Future Pruning

Before retiring any toolkit skill or agent on usage grounds, collect a fresh
observation window with this acceptance criterion:

- A daily job aggregates `~/.kookr/hooks/*.jsonl`.
- It records successful invocations keyed by canonical toolkit identity.
- It includes both bypass and normal Kookr-spawned sessions.
- It excludes non-canonical worktree copies and generic agent identities.
- It runs for at least 90 days, matching the existing manual disuse convention.

Only after that window should a retire/archive PR be opened, and only for items
with zero observed invocation plus a human-readable recovery path.
