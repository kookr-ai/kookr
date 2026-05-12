# LinkedIn Post — Demo v3

## Main post

> I measured my terminal-switches for a week.
> ~40 per hour when running 5 AI coding agents in parallel.
>
> The "10x productivity" story turned out to be a "10x context-switching" story.
>
> So I built Kookr — an open-source attention router for parallel Claude Code and Codex CLI agents. One dashboard, one queue, the agent that needs you first floats to the top.
>
> What it does:
>
> • Detects permission prompts, repeated errors, merge conflicts, idle agents — ranked alerts, not toast spam.
> • Tracks GitHub PRs + CI; failures land in the same queue as agent anomalies.
> • Playbooks: parameterized task templates ("Implement issue X", "Security review") so you stop re-typing prompts.
> • Pre-push hook: a deterministic gate that blocks `git push` until reviewer subagents have run. The agent can't "forget" to review — the hook enforces it.
> • Drafts replies, snoozes the non-urgent, tracks per-agent cost so the parallelism doesn't quietly bankrupt you.
>
> Three pieces worth flagging:
>
> Multi-project. The sidebar groups agents by project with per-project PR limits + budgets.
>
> Both runtimes. Claude Code AND Codex CLI in the same dashboard, via a maintained Codex fork that adds the hooks Claude users rely on.
>
> Bundled skills. The kookr-toolkit Claude Code plugin ships battle-tested workflows. Standout: RFC iterative review — drafts an RFC in a worktree, runs parallel critic subagents, incorporates feedback over rounds before any code is written. Network feedback: "a game changer."
>
> Local-first. No telemetry, state under ~/.kookr/. Apache 2.0.
>
> Repo + install in the comments.

## Hashtags (append below body)

> #AIAgents #DeveloperTools #ClaudeCode #CodexCLI #OpenSource

## First comment

> Links + install:
>
> Repo: https://github.com/kookr-ai/kookr
> Demo (1080p + 4K): https://github.com/kookr-ai/kookr/releases/tag/demo-v3
> Codex CLI fork: https://github.com/jeanibarz/codex/tree/feat/claude-compat
> Codex setup guide: https://github.com/kookr-ai/kookr/blob/main/docs/codex-cli-setup.md
>
> Install (production-style supervisor instance):
> ```
> git clone https://github.com/kookr-ai/kookr.git
> cd kookr
> pnpm install
> pnpm prod:setup
> pnpm prod:update
> ```
> (Or `pnpm dev` for a hot-reloading dev instance.)

## Video attachment

`kookr-demo-4k.mp4` from the `demo-v3` GitHub Release (3840×2160 H.264 + AAC, 25 MB, 1:48, captions burned in).
