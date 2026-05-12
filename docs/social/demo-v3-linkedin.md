# LinkedIn Post — Demo v3

## Main post

> I measured my terminal-switches for a week.
> ~40 per hour when running 5 AI coding agents in parallel.
>
> The "10x productivity" story turned out to be a "10x context-switching" story.
>
> So I built Kookr — an open-source attention router for developers running Claude Code and Codex CLI agents side by side.
>
> One dashboard. One queue. The agent that needs you first floats to the top.
>
> What it does:
>
> • Detects permission prompts, repeated errors, merge conflicts, idle agents — surfaces them as ranked alerts, not toast spam.
> • Tracks GitHub PRs and CI runs your agents open — failures land in the same queue as agent anomalies.
> • Drafts replies with AI suggestions, lets you snooze the non-urgent ones, and shows per-agent cost so the parallelism doesn't quietly bankrupt you.
>
> Two pieces worth flagging:
>
> Multi-project. The sidebar groups agents by project with per-project PR limits and budgets — three webapp agents and two API-service agents stay legible instead of blurring into one feed.
>
> Both runtimes. Claude Code AND Codex CLI in the same dashboard, via a maintained Codex fork that adds the PermissionRequest, Notification, SubagentStart/Stop, and SessionEnd hooks Claude users already rely on.
>
> Local-first. No telemetry, no cloud, state under ~/.kookr/. Apache 2.0.
>
> Repo, demo, Codex setup, and the install one-liner in the comments.

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

`kookr-demo-4k.mp4` from the `demo-v3` GitHub Release (3840×2160 H.264 + Opus, 25 MB, 1:38, captions burned in).
