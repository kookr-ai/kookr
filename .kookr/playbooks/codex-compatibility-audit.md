---
name: Codex CLI Compatibility Audit
description: Analyze Claude Code vs Codex CLI feature gaps and maintain candidate contribution issues in jeanibarz/codex fork
cwd: /home/jean/git/codex
checklist:
  - Fetched current candidate issues from jeanibarz/codex
  - Checked recent changes in anthropics/claude-code (new features, closed issues)
  - Checked recent changes in openai/codex (new features, closed issues)
  - Closed issues for features Codex has now implemented upstream
  - Updated existing issues with new information where relevant
  - Created new candidate issues for newly discovered gaps
  - Verified no duplicate issues exist
  - Verified impact labels are accurate (high/medium/low)
  - Final issue count and summary reported
---

## Objective

Maintain a curated set of candidate contribution issues in the `jeanibarz/codex` GitHub fork. Each issue represents a feature gap where Codex CLI could be made more compatible with Claude Code, benefiting users of both tools.

## Context

- **Fork**: `jeanibarz/codex` (forked from `openai/codex`)
- **Labels**: `compatibility`, `candidate`, `high-impact`, `medium-impact`, `low-impact`

## Phase 1: Survey current state

1. List all open candidate issues:
   ```bash
   gh issue list -R jeanibarz/codex --label "candidate" --state open --limit 100 --json number,title,labels,updatedAt
   ```

2. Check recent Claude Code activity (features shipped, new feature requests):
   ```bash
   gh issue list -R anthropics/claude-code --state closed --limit 50 --json number,title,closedAt,labels
   gh issue list -R anthropics/claude-code --state open --limit 100 --json number,title,labels
   gh api repos/anthropics/claude-code/contents/README.md -q '.content' | base64 -d | head -200
   ```

3. Check recent Codex CLI activity (features they've added, community requests):
   ```bash
   gh issue list -R openai/codex --state closed --limit 50 --json number,title,closedAt,labels
   gh issue list -R openai/codex --state open --limit 100 --json number,title,labels
   gh api repos/openai/codex/contents/codex-rs/core -q '.[].name'
   ```

## Phase 2: Analyze and act

For each existing candidate issue:
- If Codex CLI now implements the feature upstream: **close** the issue with a comment explaining what changed
- If there's new relevant information (Claude Code changed the feature, Codex added partial support): **update** the issue with a dated comment
- If the impact assessment has changed: **relabel** appropriately

For newly discovered gaps:
- Verify the gap is real (check Codex source/docs, not just absence from issue tracker)
- Verify no existing candidate issue already covers it
- Create a new issue using the template below

### Key comparison areas

| Area | Claude Code | Codex CLI |
|------|-------------|-----------|
| Instruction files | `CLAUDE.md` (hierarchical) | `AGENTS.md` + `project_doc_fallback_filenames` |
| Hook events | 12+ events (SessionStart/End, Pre/PostToolUse, Stop, StopFailure, PermissionRequest, InstructionsLoaded, TaskCreated/Completed, CwdChanged, FileChanged, PostCompact, Elicitation) | 5 events (SessionStart, PreToolUse, PostToolUse, Stop, UserPromptSubmit) |
| Hook payloads | JSON with session_id, tool_name, tool_input | JSON with session_id, cwd, client, hook_event discriminated union |
| MCP config | `.mcp.json` project file | `config.toml` [mcp_servers] section |
| Conditional rules | `.claude/rules/*.md` with `paths:` glob frontmatter | No equivalent |
| Worktree isolation | EnterWorktree/ExitWorktree tools, `--worktree` flag | Ghost commits, no explicit worktree tools |
| Slash commands | `.claude/commands/*.md` with frontmatter | Skills-based, different format |
| Plan mode | `/plan`, EnterPlanMode/ExitPlanMode, structured review | May vary |
| Plugin format | `.claude-plugin/plugin.json` directory structure | Own plugin format |
| Context mgmt | `/context` command, auto-compaction with circuit breaker | Auto-compaction |
| Memory format | Markdown files (human-readable, git-friendly) | SQLite 2-phase pipeline |
| Deferred tools | ToolSearch pattern | May vary |
| @-file refs | `@` autocomplete in prompt | May vary |
| Cron/loop | `/loop`, CronCreate/Delete/List | May vary |
| Status line | Custom scripts receiving JSON | May vary |

### Issue creation template

```bash
gh issue create -R jeanibarz/codex \
  --title "Brief description of the compatibility feature" \
  --label "compatibility,candidate,{high-impact|medium-impact|low-impact}" \
  --assignee jeanibarz \
  --body "$(cat <<'EOF'
## Context

What Claude Code has and what Codex CLI lacks (or does differently).

## Proposal

Concrete change to make in Codex CLI.

## Why this matters

- User-facing benefit
- Ecosystem benefit
- Implementation feasibility

## Implementation notes

- Key files/crates to modify
- Dependencies on other changes
- Risks or trade-offs
EOF
)"
```

### Updating an existing issue

```bash
gh api repos/jeanibarz/codex/issues/{number}/comments -X POST -f body="**Update ({date})**: {what changed}"
```

### Closing an issue

```bash
gh issue close -R jeanibarz/codex {number} -c "Closed: {reason}"
```

### Relabeling impact

```bash
gh api repos/jeanibarz/codex/issues/{number}/labels -X PUT --input - <<'EOF'
{"labels":["compatibility","candidate","high-impact"]}
EOF
```

## Phase 3: Verify consistency

```bash
# Count by impact
gh issue list -R jeanibarz/codex --label "high-impact" --state open --json number | jq length
gh issue list -R jeanibarz/codex --label "medium-impact" --state open --json number | jq length
gh issue list -R jeanibarz/codex --label "low-impact" --state open --json number | jq length

# List all open candidates
gh issue list -R jeanibarz/codex --label "candidate" --state open --json number,title,labels
```

Verify:
- No duplicate issues
- All issues have both `candidate` and an impact label
- All issues are assigned to `jeanibarz`
- Report the final state: total open issues, breakdown by impact

## Idempotency Rules (Ralph Wiggum Loop)

This playbook is designed for repeated execution. Each run must be safe:

1. **Don't create duplicate issues.** Always check existing issues before creating new ones.
2. **Don't update issues that haven't changed.** Only comment/update when there's new information.
3. **Converge, don't diverge.** Each run should refine the issue set, not grow it unboundedly.
4. **Check upstream first.** Before creating an issue, verify Codex hasn't already implemented it.
5. **Date-stamp comments.** When adding update comments, include the date for tracking.
6. **Respect existing triage.** If the user has manually relabeled or modified an issue, don't override their changes.

## Quality Criteria for Candidate Issues

A good candidate issue should be:

- **Feasible**: Can be implemented in a single PR (or a small series)
- **Valuable**: Benefits Codex CLI users, not just Claude Code compatibility for its own sake
- **Specific**: Clear proposal with implementation pointers, not vague "add feature X"
- **Upstream-friendly**: Likely to be accepted by openai/codex maintainers
- **Non-duplicative**: Not already requested in openai/codex issues

## Anti-Patterns

- Don't propose changes that break Codex's existing behavior or philosophy
- Don't suggest copying proprietary Claude Code features — focus on interoperability
- Don't create issues for trivial differences (config format, naming conventions)
- Don't propose changes that only benefit Claude Code users at the expense of Codex users
- Don't create massive "umbrella" issues — keep each issue focused and implementable
