---
name: agent-safety
group: agent-automation
keywords: prompt injection, untrusted content, sandbox, permissions, secrets, pre-tool hook, monitor, test tampering, dry run, destructive action
related: claude-code-permissions, hook-driven-workflow-enforcement, shell-subprocess-safety, git-commit-discipline, asking-the-operator
description: >
  Agent safety for tool-using and coding agents: prompt injection through issues, web pages, tool/MCP
  output, memory and third-party skills; containing unsafe actions with no attacker (sandboxes, secret
  brokers, permission policies, pre-tool gates, monitors, test tampering); and predicting before
  hard-to-undo actions (dry runs, verifying effects, when lookahead pays). Use when granting tools or
  credentials, installing a skill or MCP server, choosing a guard, sandbox or monitor, or about to run a
  destructive or outward-facing command.
---

# Agent Safety

Evidence-based rules, each with its paper citation and a list of what the evidence does not show, for
keeping tool-using agents from doing harm. Read only the guide that matches the decision in front of you
(several if the task spans them).

| Decision you face | Read |
|---|---|
| An agent reads issues, PRs, web pages, tool/MCP output or memory that may carry injected instructions; you are installing a skill or MCP server, storing lessons, hardening a CI agent workflow, choosing between a guard model and a structural control, or passing untrusted content and credentials between lead and worker agents | [references/untrusted-content-defense.md](references/untrusted-content-defense.md) |
| Giving an agent a shell or credentials with no attacker involved: choosing a harness, sandbox or permission policy, brokering secrets, writing a pre-tool gate, adding a monitor, or stopping test or grader tampering | [references/agent-action-containment.md](references/agent-action-containment.md) |
| About to delete, force-push, kill, send, merge or change shared state; deciding whether a dry run can be trusted; or building lookahead, simulation or tree search into an agent loop | [references/predict-before-acting.md](references/predict-before-acting.md) |

Related skills: `claude-code-permissions` (permission modes and rules), `hook-driven-workflow-enforcement`
(building PreToolUse gates), `shell-subprocess-safety` (spawning commands safely), `git-commit-discipline`
(secret scanning, history safety, checkpoint before live-state operations), `asking-the-operator`.
