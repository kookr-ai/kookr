---
name: agent-efficiency-retrofit
description: Analyze recent Claude Code and Codex CLI conversations for repeated inefficient tool calls, token waste, retry loops, avoidable errors, and recurring setup friction; rank improvements by benefit/ease, then implement the smallest durable guardrail after user approval.
keywords: efficiency, token waste, tool calls, reduce tool calls, reduce tokens, Claude Code, Codex CLI, conversations, transcripts, sessions, history, retry loops, repeated errors, inefficient calls, hooks, skills, CLAUDE.md, playbook, self reflection, subagents
related: token-efficiency, self-reflect, placement-picker
---

# Agent Efficiency Retrofit

Use this skill when the user asks to analyze recent agent conversations,
transcripts, or session history to reduce tool calls, token consumption, repeated
errors, retry loops, or setup friction. This is the discoverable entrypoint; do
not rely on a playbook file being found by chance.

## Goal

Turn observed agent waste into a durable, visible improvement:

1. Sample recent Claude Code and Codex CLI sessions.
2. Identify repeated inefficient patterns with concrete examples.
3. Rank fixes by expected benefit and implementation ease.
4. Present up to 10 options, with a short recommendation.
5. After explicit user approval, implement the smallest durable fix in the right
   surface: hook, skill, concise agent instruction, script, or project docs.

## Fast Workflow

### 1. Bound the Analysis

Prefer a bounded, recent sample over a broad transcript dump:

- Claude Code: inspect recent `~/.claude` project/session data, stats cache, and
  history where available.
- Codex CLI: inspect recent `~/.codex/sessions` and `~/.codex/history.jsonl`
  where available.
- If the user requests subagents, split the sample into batches and ask each
  subagent for repeated patterns, not exhaustive summaries.

Use cheap metadata first: command names, output sizes, retries, repeated file
reads, repeated status/diff calls, failed commands, sleeps/polling, and hook
blocks. Open full transcripts only for representative examples.

### 2. Classify Waste Patterns

Look for patterns that can be prevented next time:

- Repeated broad reads where a targeted `rg`, `sed`, or parser would suffice.
- Repeated failed commands before discovering the right setup command, env var,
  worktree rule, dependency install, or PR workflow.
- Long command outputs that could have been capped, summarized, or redirected.
- Sleep/poll loops where an event, status endpoint, or bounded retry helper
  would reduce calls.
- Skill or instruction misses where the needed rule existed but was not loaded.
- Boilerplate repeated across tasks that belongs in a script or helper.
- Hook failures whose remediation could be shown before the blocked action.

### 3. Rank Fixes

Score each candidate on:

- **Benefit:** repeated frequency, token/tool-call savings, and severity of
  avoided errors.
- **Ease:** small, testable change; low blast radius; fits existing mechanisms.
- **Visibility:** future agents will actually encounter it.

Prefer this order for behavioral prevention:

1. Deterministic hook when the bad action is mechanically detectable.
2. Skill frontmatter/body when the trigger is semantic or workflow-shaped.
3. Concise `CLAUDE.md`/`AGENTS.md` instruction when every agent must see it.
4. Script/helper when the problem is repeated command boilerplate.
5. Playbook or docs only as supporting detail, not the primary trigger surface.

Do not use memory as the primary fix for behavioral rules in mixed Claude/Codex
workflows; Codex agents will not reliably see it.

### 4. Report Before Editing

Present the highest-value ideas first. For each, include:

- pattern observed
- likely fix surface
- implementation ease
- expected benefit
- why future agents would see it

If the user asks for more detail, expand the top options and choose the easiest
high-benefit starting point.

### 5. Implement After Approval

After the user says to proceed:

1. Use `placement-picker` to confirm the right surface.
2. If tracked files will change, follow the repository's worktree and branch
   rules before editing.
3. Keep the first implementation narrow and testable.
4. If editing bundled plugin content under `plugin/**` except
   `plugin/.claude-plugin/plugin.json` itself, bump
   `plugin/.claude-plugin/plugin.json#version`. Some repositories enforce this
   for skills, agents, hooks, playbooks, reviewer specialists, README files, and
   other distributed plugin content.
5. Run the focused validation for the changed surface.
6. Commit and follow the repository's push/PR workflow.

## Relationship to Playbooks

If a repository ships a deeper self-reflection or efficiency-retrofit playbook,
use it as the detailed procedure after this skill has triggered. The skill is the
entrypoint that makes the workflow discoverable; the playbook is supporting
detail.
