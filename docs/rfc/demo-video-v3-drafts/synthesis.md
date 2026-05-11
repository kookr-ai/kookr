# Critic Synthesis — Demo Video v3

Three critic subagents reviewed `rfc.md`, `script.md`, `linkedin.md`, `twitter.md`:

- **`critique-viewer.md`** — first-time LinkedIn viewer, muted auto-play, one-agent SWE.
- **`critique-competitive.md`** — viewer comparing to tmux, aider, crewAI, Cursor, OpenDevin.
- **`critique-productivity.md`** — productivity coach asking "is the gain quantified?"

## Converging findings (all three critics agreed)

| # | Issue | Severity |
|---|---|---|
| 1 | **Anomaly detection is claimed but never shown.** Acts 0 and 2 are visually indistinguishable from a tmux pane grid with a toast. No on-screen inference step. | Blocking |
| 2 | **"Finding" is undefined jargon.** Security-scanner connotation. Viewer never learns what it means. | High |
| 3 | **The "before" pain is implied, never visible.** Act 0 shows Kookr's calm dashboard with no contrast to the 5-terminal alt-tab tax. The productivity story has no anchor. | High |
| 4 | **Codex fork caption (`jeanibarz/codex#feat/claude-compat`) reads as a security flag.** Random GitHub user + "compat" branch in big text = "this is a hack." | High |
| 5 | **No falsifiable productivity number.** Cost is shown ($0.42) but time-saved-vs-manual-polling is never quantified. | High |
| 6 | **Closing CTA has no verb.** Repo URL alone — no install command. Low conversion. | Medium |
| 7 | **"Multi-agent" collides with crewAI/autogen.** Need the on-screen phrase "attention router" — unowned competitively, already in LinkedIn copy but never on screen. | Medium |
| 8 | **AI suggestions in Act 3 will read as fixtures** without a model stamp or brief generation shimmer. | Medium |
| 9 | **Hashtag `#AIcoding` is stale; `#CodexCLI` is missing.** | Low |
| 10 | **Audience framing presumes 3+ agents from frame 1.** Excludes the larger "considering parallel agents" + "runs one agent, wants GitHub awareness" segments. | Low |

## Decisions (proposed — user approves in next step)

### Script changes

| Act | Change |
|---|---|
| **0** | Open with a 2-second **split-screen cold open**: left half a fake tmux grid showing 4 chaotic terminal panes (one waiting on prompt, one looping a test, two scrolling output); right half blank. After 2s, the right half fills with the Kookr dashboard. Caption: `5 terminals → 1 dashboard.` Then transition to the existing Act 0 frame. Total: +3s, pushes hard cap to 2:33. |
| **0** | Rename caption: `5 AI agents working. One needs you.` → `5 AI agents. Kookr tells you which one needs you.` Naming the product on screen is fine in the hook. |
| **1** | Change caption 3 from `Codex via jeanibarz/codex#feat/claude-compat` (44 chars, reads as a hack) → `Codex CLI — patched for missing hooks.` (38 chars). The tooltip on hover still shows the fork URL + branch, but the BIG caption stays calm. |
| **2** | Add a 0.6s overlay on the agent row at the moment it pulses: small label `permission-block detected (rule: F2.4)` fades in for ~400ms then out. Proves an inference happened, not just a toast. |
| **2** | Replace `Permission blocked. Kookr surfaces it instantly.` → `Permission blocked. Kookr surfaces it — attention routed.` (54 chars). Plants the "attention router" phrase. |
| **3** | When AI suggestion panel slides in, the first item briefly shows a "drafting…" shimmer (~600ms) before the text resolves. Tiny model stamp under each: `via Claude haiku-4-5`. Avoids the fixture look. |
| **3** | Add overlay on the snoozed row after the snooze pick: small badge `~14 min reclaimed` fades in for 1s. First falsifiable productivity number. |
| **5** | Add a row to the completion digest: `Manual supervision avoided: ~8 min (≈ 16 checks at 30s cadence)`. Math: 8m 12s task ÷ 30s polling cadence = 16 checks ≈ 8 min of context-switching time avoided. Footnoted as an explicit calculation, not a measurement. |
| **5** | **Do NOT mark Act 5 as "first to cut."** Productivity payoff lives here. If overruns, trim Act 4 GitHub by 5s instead. |
| **6** | Add install verb to closing card: a third sub-line under the repo URL: `Start: git clone … && pnpm install && pnpm dev`. |
| **6** | Replace `Local-first. Multi-agent. Multi-project.` pills → `Local-first. Attention router. Multi-project.` The middle pill carries the differentiating phrase. |

### Terminology

- **In on-screen captions:** use "alert" or "needs-attention" instead of "finding" (e.g., `2 alerts in the queue` instead of `Two findings`).
- **In narration + RFC + code:** keep `finding` as the API/UX term. The aliasing only affects what the viewer sees in caption text.

### LinkedIn rewrite — hook line

Replace:

> Running five AI coding agents in parallel sounded productive.
> In practice, I spent more time switching between terminals than reviewing code.

With (243 chars, fits "see more" cutoff):

> I measured my terminal-switches for a week.
> ~40 per hour when running 5 AI coding agents in parallel.
> The "10x productivity" story turned out to be a "10x context-switching" story.

Concrete, falsifiable, leads with measurement. Keeps the line-1 hook short enough that LinkedIn's mobile preview doesn't truncate it.

### X / Twitter — single tweet rewrite

Replace generic version with:

> I measured my terminal-switches with 5 AI agents running.
> ~40 / hour.
>
> Built Kookr — one dashboard for Claude Code + Codex CLI agents. Open source.
>
> github.com/kookr-ai/kookr

(247 chars, fits 280.)

### Hashtags

Drop: `#AIcoding`
Add: `#CodexCLI`, `#AIAgents`

Final 5: `#AIAgents #DeveloperTools #ClaudeCode #CodexCLI #OpenSource`

## Decisions kept from v1 (critics did not overturn)

- 1080p crisp render → 4K upscale (no critic flagged the resolution decision).
- 7-act structure stays (no critic argued for merging or splitting acts, just for content fixes inside acts).
- TTS narration with matilda voice stays.
- Single video, no separate social cut (user picked this; critics did not push back).
- Codex compat docs page at `docs/codex-cli-setup.md` and README diff stay as drafted.

## What's still uncertain (escalated to user)

1. **The "Manual supervision avoided: ~22 min" overlay** — is the heuristic honest enough for the user to publish? The RFC v2 will footnote the calculation (`1 manual check / 30s × elapsed task time`) so the claim is auditable. If the user thinks it's too aggressive, alternative is to drop the number and just say "Skip the 30-second polling tax."

2. **The split-screen cold open** — adds ~3s and a fake tmux grid. The fake terminal already exists (`terminal-content.ts`); a 4-panel CSS grid is cheap. But it pushes total to ~2:33. Acceptable, or do we trim 3s elsewhere?

3. **The `time reclaimed` and `manual supervision avoided` numbers** — should they be displayed as visible UI in the actual product (not just demo overlays)? That's a real feature decision. For this video, they are demo-only overlays. The RFC v2 will be explicit.

4. **The model stamp in Act 3** — Kookr's AI suggestion feature uses whichever model is configured. If the default is currently haiku-4-5 then the stamp is accurate. If it's sonnet-4-6 or routes through a different provider, fix the stamp before recording.

5. **Install verb on closing card** — `pnpm dlx kookr` would be ideal one-liner, but the actual install today is `git clone && pnpm install && pnpm dev`. Closing card has space for one verb only; either we add the dlx-style command (does it exist?) or we live with the longer one.
