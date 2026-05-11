# LinkedIn Post Draft

## Body (~1290 characters, fits LinkedIn's optimal length)

> Running five AI coding agents in parallel sounded productive.
> In practice, I spent more time switching between terminals than reviewing code.
>
> So I built Kookr — an open-source attention router for developers running Claude Code and Codex CLI agents side by side.
>
> One dashboard. One queue. The agent that needs you first floats to the top.
>
> What it does:
>
> • Detects permission prompts, repeated errors, merge conflicts, and idle agents — surfaces them as ranked findings, not toast spam.
> • Tracks GitHub PRs and CI runs your agents open — failures land in the same queue as agent anomalies.
> • Drafts replies with AI suggestions, lets you snooze the non-urgent ones, and shows per-agent cost so the parallelism doesn't quietly bankrupt you.
>
> Two pieces I want to flag specifically:
>
> Multi-project. The sidebar groups agents by project with per-project PR limits and daily budgets, so running three webapp agents and two API-service agents doesn't blur into one chaotic feed.
>
> Both runtimes. Kookr handles Claude Code and Codex CLI in the same dashboard — via a maintained Codex fork that adds the PermissionRequest, Notification, SubagentStart/Stop, and SessionEnd hooks Claude users already rely on.
>
> Local-first. No telemetry, no cloud, state under ~/.kookr/. Apache 2.0.
>
> Repo, demo, and Codex setup docs in the comments.

Character count (excluding hashtags below, including the demo-video line break breaks): **~1290 chars**. LinkedIn's optimal post length sits between 1200 and 1600 characters; this lands in the lower-middle, leaving room for the algorithm to favour completion rate.

## First comment (the links)

LinkedIn's algorithm down-ranks posts with outbound links in the body. All URLs live in the first comment, posted within seconds of the main post:

> Links:
> - Repo: https://github.com/kookr-ai/kookr
> - Demo release (1080p + 4K): https://github.com/kookr-ai/kookr/releases/tag/demo-v3
> - Codex CLI fork: https://github.com/jeanibarz/codex/tree/feat/claude-compat
> - Codex setup guide: https://github.com/kookr-ai/kookr/blob/main/docs/codex-cli-setup.md

## Hashtags (end of main post body)

> #AIcoding #DeveloperTools #ClaudeCode #OpenSource #DevProductivity

Five hashtags. LinkedIn's current guidance favours 3–5 relevant tags; more triggers spam heuristics.

## Hook line analysis

The first 2 lines decide whether viewers expand the "see more" cutoff. The hook here is:

> Running five AI coding agents in parallel sounded productive.
> In practice, I spent more time switching between terminals than reviewing code.

The hook works because:
- **Concrete numeric anchor** ("five") instead of "many" or "multiple."
- **Pain point in the second line** matches the audience's actual experience.
- **No product mention before the pain point.** The pivot to Kookr happens in line 3, after the reader has self-identified.
- **Conversational register, no jargon.** "Terminals," not "agent sessions" or "parallel workspaces."

## Video attachment

Attach `kookr-demo-4k.mp4` (the 3840×2160 H.264 upscale). LinkedIn auto-downsamples for the feed but preserves resolution for users who open the video directly. The 4K file is also what gets re-shared with quality intact when others repost.

Aspect ratio: 16:9. LinkedIn natively supports 16:9; vertical re-crops are an optional follow-up if mobile engagement underperforms.

Captions: burned into the video (the recording pipeline produces them as DOM overlays captured by Playwright). LinkedIn's auto-captions are unreliable on technical jargon; baked-in captions side-step the issue.

## Posting time

Recommend Tuesday or Wednesday, 9–11am the user's local timezone (Europe/Paris) — LinkedIn engagement for dev-tools content peaks in mid-week European morning when both EU and US developers are at desks.
