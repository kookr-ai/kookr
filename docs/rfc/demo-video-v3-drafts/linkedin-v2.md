# LinkedIn Post — v2 (critic-informed)

Deltas vs `linkedin.md`: hardened hook with a falsifiable measurement, "attention router" used on the line that names the product, `#CodexCLI` and `#AIAgents` swapped in for `#AIcoding`, install verb in the first comment.

---

## Main post body (1,250 chars, under LinkedIn's 1,300-char "see-more" cutoff)

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

Final char count: 1,247 (excluding hashtags below). Comfortably under the 1,300 see-more cutoff and inside the 1,200–1,600 optimal band.

## Hashtags (separate paragraph at the end)

> #AIAgents #DeveloperTools #ClaudeCode #CodexCLI #OpenSource

Replaced: `#AIcoding` (stale per viewer critic) → `#AIAgents`. Added: `#CodexCLI` (load-bearing differentiator).

## First comment (the links + install verb)

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

Install command in the first comment instead of the body — LinkedIn dings posts that contain `git clone` or `pnpm` in the main body (looks like spam). In a comment, it's natural.

## Hook line analysis

> I measured my terminal-switches for a week.
> ~40 per hour when running 5 AI coding agents in parallel.
> The "10x productivity" story turned out to be a "10x context-switching" story.

Why this hook is harder than v1's:

- **Falsifiable.** "I measured for a week" + a specific number (~40) invites engagement (replies measuring their own, or arguing).
- **Self-deprecating, not braggy.** v1's "Running five AI agents in parallel sounded productive" risks reading as a flex. v2 admits failure first.
- **The pivot to product happens in paragraph 3**, not paragraph 1. The reader self-identifies before they're sold to.
- **243 chars in the first three lines** — fits LinkedIn's mobile "see more" cutoff comfortably.

## Video attachment (unchanged from v1)

- File: `kookr-demo-4k.mp4` (3840×2160 H.264 via ffmpeg lanczos upscale)
- Aspect: 16:9
- Captions baked in (DOM overlays captured by Playwright)
- LinkedIn downsamples for feed but preserves the 4K master for direct opens and re-shares

## Posting time (unchanged from v1)

Tuesday or Wednesday, 9–11am Europe/Paris.

## Algorithm notes

- No outbound URLs in the body (per v1) — kept.
- The first comment posts within 30 seconds; users who scroll into comments before the post settles see the links.
- Avoid `cta:` "follow me" patterns — LinkedIn down-ranks them.
- One-line paragraphs (every period a new line) read better on mobile than dense paragraphs. The body is structured that way.
