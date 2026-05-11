# RFC: Demo Video v3 — Multi-Project + Codex CLI Cut

## Status

**Draft (v1, plan-only).** Recording NOT yet run. Awaiting user approval before any code changes land in `demo/record.ts`, `README.md`, or `docs/`.

This is an **iteration** of the existing `demo/record.ts` Playwright pipeline. It is NOT the larger Remotion / scene-DSL refactor proposed in `docs/rfc/rfc-demo-video-strategy.md` — that RFC remains separately tracked and out of scope here.

## Problem

The current shipped demo (`releases/tag/demo-v1`, recorded by the existing seven-act pipeline) has three concrete weaknesses for the LinkedIn / X push:

1. **Codex CLI is absent.** Kookr's headline claim is "supervise multiple AI coding agents from one dashboard," and a load-bearing differentiator is that it handles **both** Claude Code and Codex CLI agents in one queue. The current video shows only Claude Code agents. Viewers cannot tell, watching it, that Codex compatibility exists at all.
2. **Multi-project management is under-shown.** The sidebar already groups parallel agents by project (acme/webapp + acme/api-service in the existing record) with per-project PR limits, budgets, and color-coded badges — but the camera never lingers on the sidebar, never demonstrates cross-project finding routing, and never makes the project-pill filter visible. A viewer with two browser tabs open mistakes it for a single-project dashboard.
3. **It looks dated on a 4K timeline.** The video is captured at 1280×720. On a Retina or 4K LinkedIn feed, especially side-by-side with native 1080p/4K product videos, it reads as a screen recording from 2018.

These three issues compound. Without Codex on-screen, viewers conclude Kookr is Claude-Code-only. Without the multi-project camera moves, they conclude it's a single-project tool. At 720p they conclude both verdicts in the first 4 seconds, before the narration has a chance to argue otherwise.

### Why now

A LinkedIn + X awareness post is being prepared (see `linkedin.md`, `twitter.md` in this directory). The whole bundle ships together — video + README hero update + new Codex setup docs + social copy. Posting any single piece in isolation undersells the others.

## Audience

LinkedIn and X **first-time viewer**, scrolling a mobile or desktop feed. No prior Kookr context. Specifically:

- Watches **muted by default** — autoplay is silent on both platforms. The first ~6 seconds decide whether they unmute. Captions are first-class, narration is the accent.
- Sees the video in a **~360px-wide inline preview** on mobile feed. Captions must remain readable at that size — favour ≤70 characters per line, ≥18px effective font.
- Probably runs 2–5 AI coding agents in parallel already. They understand "permission prompt," "PR review," "merge conflict" without explanation. They do NOT need the "what is an LLM agent" pre-roll.
- Decides whether to click through to the repo within ~15 seconds. The hook in Act 0 must do the work.

Not in scope: existing Kookr users (they get the changelog), enterprise buyers (they get a different artifact).

## Requirements

- **R1 — 1080p crisp source, 4K release upload.** Capture at 1920×1080 with `deviceScaleFactor: 2`. Post-process upscale to 3840×2160 with ffmpeg lanczos + H.264 for the LinkedIn/X master.
- **R2 — Length ≤ 2:30 (hard cap 2:50).** Beyond 2:30, LinkedIn drop-off graphs from comparable dev-tool demos show audience halving every additional 20s.
- **R3 — At least one Codex CLI agent on-screen alongside Claude Code agents** in the same dashboard view. The provider badge (`agent-provider-mark` component, already in the codebase) must render and be visible.
- **R4 — Multi-project sidebar is a deliberate camera target.** Act 1 must include a hover-or-click on a project pill that filters the queue, and project chips must be visible on each agent row in at least three acts.
- **R5 — Captions readable at LinkedIn mobile inline (~360px) size.** Existing caption style is acceptable; max line length stays ≤70 characters; new captions provided in `script.md`.
- **R6 — Narration optional, captions are canonical.** Captions carry the story when muted. Narration via existing `tts/` Docker (matilda voice) overlays the same beats but is not the only path to comprehension.
- **R7 — Silent .webm intermediate preserved** for the captioned LinkedIn cut, exactly as the existing pipeline already does.
- **R8 — No new dependencies.** Stay on Playwright + the existing `tts/` container + ffmpeg. No Remotion, no scene DSL.

## Design

### Scene plan (table)

| Act | Time | Focus | Caption (≤70 char) | Codex visible? | Multi-project visible? |
|---|---|---|---|---|---|
| 0 | 0:00–0:08 | Cold dashboard, 5 agents already running across 2 projects | 5 AI agents working. One needs you. Which one? | yes (badge in row) | yes (sidebar both projects) |
| 1 | 0:08–0:35 | Project sidebar + provider badges; hover project pill filters queue | One dashboard. Two projects. Claude Code + Codex CLI. | yes (highlighted + tooltip) | yes (filter demo) |
| 2 | 0:35–0:55 | Permission block on Claude agent; one-key allow | Permission blocked. One key — keep moving. | mixed | yes (badge stays) |
| 3 | 0:55–1:25 | Two findings: question on Codex agent + merge conflict on Claude | Cross-project triage. Answer one, snooze the other. | yes (Codex finding header) | yes (project chips on both) |
| 4 | 1:25–1:50 | Agent opens PR, CI fails, finding pops; click into GitHub tab | PR opened. CI red. Kookr brings it to you. | mixed | yes |
| 5 | 1:50–2:10 | Completion digest: files changed, tests, cost | Done. What changed, what it cost. | mixed | yes |
| 6 | 2:10–2:30 | Closing CTA + repo URL + Codex fork link | Local-first. Multi-agent. Multi-project. | yes (final card) | yes (final card) |

Total: 2:30. Hard cap 2:50 honoured. Each act's exact narration, on-screen caption, and visual choreography are specified in `script.md`.

### Codex CLI integration callout

The treatment has three layers:

1. **Persistent provider badge in each agent row.** Already rendered by the existing `agent-provider-mark` component for `agentType: 'codex-cli'`. We just need the fake task data in `demo/record.ts` to set `agentType: 'codex-cli'` on at least one of the five agents. Recommended: repurpose Agent 4 (api-service rate-limiting) as the Codex agent so the Act 3 finding lands on a Codex provider.

2. **Tooltip overlay at the moment of first Codex spotlight (Act 1, ~0:25).** A small floating overlay reading:

   > **Codex CLI** via `jeanibarz/codex#feat/claude-compat`
   > Adds PermissionRequest, Notification, SubagentStart/Stop, SessionEnd, plus `.claude/skills` + `.claude/agents` loaders. See `docs/codex-cli-setup.md`.

   Duration ~3s, fades in/out. Implemented by a new helper `showProviderBadge(page, text)` analogous to the existing `showCaption()`.

3. **Closing card (Act 6) includes the fork URL** `https://github.com/jeanibarz/codex/tree/feat/claude-compat` rendered in the lower-third for ~3s.

### Required code edits to `demo/record.ts`

Enumerated diff plan (no code applied in this RFC; described for reviewer approval).

1. **Viewport bump.** Change the constant `VIEWPORT = { width: 1280, height: 720 }` (line ~58) to `VIEWPORT = { width: 1920, height: 1080 }`. Add `deviceScaleFactor: 2` to the `browser.newContext({ viewport, recordVideo, deviceScaleFactor: 2 })` call (line ~713). Verify nothing in the demo CSS keys off the smaller viewport.

2. **Replace `NARRATIONS` map** (line ~500) with the new ~14-entry map. Exact key→text below. The keys map 1:1 onto the new `tracker.mark()` calls in the rewritten record body.

   ```ts
   const NARRATIONS: Record<string, string> = {
     // Act 0 — hook
     hook: 'Five AI agents working in parallel. One needs you. Which one?',
     // Act 1 — multi-project + Claude + Codex
     projects_open: 'Two projects, side by side. Webapp on the left, API service on the right.',
     providers_mixed: 'Claude Code and Codex CLI agents — same queue, same triage.',
     codex_fork: 'Codex compatibility runs on a maintained fork. Link in the description.',
     // Act 2 — permission block
     permission_block: 'Permission blocked on the webapp agent. Kookr flags it instantly.',
     permission_allow: 'One key to allow. The queue rolls forward.',
     // Act 3 — cross-project triage
     two_findings: 'A question on the Codex agent, a merge conflict on Claude. Both surfaced.',
     ai_suggest: 'AI suggests a response. Approve, edit, or write your own.',
     snooze_other: 'The merge conflict can wait. Snooze it and keep moving.',
     // Act 4 — GitHub awareness
     pr_opened: 'An agent just opened a pull request.',
     ci_failed: 'CI failed. Same attention queue. Same triage.',
     // Act 5 — completion + cost
     agent_done: 'Agent finished. Files changed, tests run, dollars spent.',
     // Act 6 — close
     closing: 'Local-first. Multi-agent. Multi-project. Claude Code and Codex CLI.',
     repo_url: 'github.com/kookr-ai/kookr. Apache 2.0.',
   };
   ```

3. **New caption text.** Replace each existing `showCaption(page, '...')` literal with the new caption strings from `script.md`. Captions are intentionally shorter than the narration; mobile readability dominates.

4. **Add a sixth agent OR repurpose an existing agent as Codex.** Recommended: repurpose **Agent 4** (rate-limit task on api-service). Set `agentType: 'codex-cli'` on the fake task. Today the existing `setProjectId(request, taskId4, 'acme/api-service')` call exists; we need a sibling helper `setAgentType(request, taskId4, 'codex-cli')` driven by an `/api/test/set-agent-type` endpoint on the test server. **Open question (see below):** verify the existing fake-task API surfaces `agentType`, or wire it through `e2e/test-server.ts`.

5. **New helper `showProviderBadge(page, text)`.** Same shape as `showCaption()`. Different positioning (upper-right, not bottom-center), different styling (smaller, brand-tinted border). Called once in Act 1 at the Codex spotlight beat.

6. **ffmpeg post-process: upscale to 4K.** After the existing merge step (which produces `kookr-demo.webm` or `kookr-demo.mp4` depending on TTS branch), add:

   ```bash
   ffmpeg -y -i kookr-demo.mp4 \
     -vf scale=3840:2160:flags=lanczos \
     -c:v libx264 -preset slow -crf 18 \
     -c:a copy \
     kookr-demo-4k.mp4
   ```

   Run as a final step inside `record()` (or inside `mergeAudioIntoVideo`). Gate the upscale behind an env var (`KOOKR_DEMO_UPSCALE_4K=true`) so contributors who just want the 1080p source don't pay the encode cost on every local run.

7. **Project-pill filter interaction.** In Act 1, add a Playwright sequence: hover on the `acme/webapp` project pill in the sidebar, wait 1.5s, click it (sidebar filters the queue), wait 2s, click "All" or the second project to undo. This requires no new API — the filter UI already exists. Just camera direction.

### README diff (textual summary)

Three changes to `/home/jean/git/kookr/README.md`, full unified diff in `readme-diff.md`:

- The "Watch the narrated demo video" line currently points to `releases/tag/demo-v1`; update to `demo-v3`.
- Add a new line under Quick Start: "Works with Codex CLI via a maintained fork — see [Codex CLI Setup](docs/codex-cli-setup.md)."
- The Core Features bullet "Real-time monitoring for Claude Code and Codex CLI agents" gets a parenthetical: "(Codex CLI requires the maintained [`jeanibarz/codex#feat/claude-compat`](docs/codex-cli-setup.md) fork)."

The hero screenshot stays.

## Phased delivery

This is one shipment, not a phased rollout. The whole bundle goes out together: the recording, the README diff, the new `docs/codex-cli-setup.md` page, and the LinkedIn / X posts. Phasing it would let the README link to a video that doesn't exist yet or push social copy for a docs page that isn't merged.

Within the bundle, the **order of operations** for the user is:

1. Approve drafts in this directory.
2. User applies the `record.ts` edits enumerated above.
3. User runs `pnpm demo:record` (with TTS env vars set).
4. User runs the 4K upscale step.
5. User publishes the GitHub Release `demo-v3` with both 1080p and 4K assets.
6. User applies the README diff in a single commit that also adds `docs/codex-cli-setup.md`.
7. User publishes the LinkedIn + X posts using the copy from this directory.

## Open questions

1. **Does `e2e/test-server.ts` already expose a way to set `agentType` on a fake task?** A grep finds no `/api/test/set-agent-type` endpoint and no `setAgentType` helper in `demo/record.ts`. The existing fake-task creation path may already accept `agentType`, in which case the demo just needs to pass it through `launchViaUI`/`launchViaQuickLaunch`. If not, we need to add the endpoint. **Action:** verify before recording; if absent, the smallest viable patch is a 10-line additive endpoint plus a one-line `setAgentType()` helper in `demo/record.ts`.

2. **Codex agent's terminal content** — we currently have six fake terminal content modules (`jwtFixContent`, `paginationContent`, etc.) all written as Claude Code transcripts. If Codex's actual TUI output looks visually different (it does — banner line, `gpt-5.4` model identifier, different status formatting), we may want at least one Codex-flavoured terminal module so the on-screen terminal corroborates the badge. Recommended scope: one new function `codexRateLimitContent()` in `demo/terminal-content.ts`. **Out of scope for this RFC if too expensive — fallback is to keep the Claude-style content and let the badge + tooltip carry the claim.**

3. **deviceScaleFactor: 2 + 1920×1080 viewport bandwidth.** Playwright video at this resolution may produce a substantially larger intermediate. Local-disk impact on a contributor laptop is unmeasured. Mitigation: keep the existing temp-dir cleanup; the final .mp4 is the artifact we care about. Worth a one-shot empirical measurement on first record.

4. **Should the closing card include a QR code** to `github.com/kookr-ai/kookr`? LinkedIn mobile viewers can't tap a URL inside the video frame; a QR is one of the few ways to convert mobile feed → repo. Mild preference: yes, but only if it doesn't add a recording dependency. Out of scope if it requires a new library.

5. **Provider badge already wired through FakeTerminalManager?** The `agent-provider-mark` component is rendered by `FindingsPanel.tsx` and gated on `agent.agentType`. Confirmed at the frontend layer. The unknown is whether the WebSocket message that announces a new fake task carries `agentType` through to the agent record in the store. If it doesn't, the badge won't render in the demo and the whole Codex visibility story collapses. **Highest-priority verification before recording.**

## Alternatives considered

### A1 — Re-record the existing 7 acts at 1920×1080 only

Cheapest. Solves the "looks dated" complaint. Does NOT solve the Codex absence or the under-shown multi-project story. Rejected — the headline value prop is invisible.

### A2 — Add an 8th act for Codex on the existing structure

Inserts a Codex-only act after the current Act 1. Cheaper than a full restructure. Rejected because the existing structure doesn't make multi-project legible either, and adding an 8th act pushes runtime past 2:30 without fixing the multi-project gap. The two problems are best solved together by restructuring around the new 7-act plan above.

### A3 — Two separate videos (a Claude cut and a Codex cut)

Doubles the recording cost and fragments the LinkedIn post. Rejected — the unification ("one dashboard, both runtimes") IS the message.

### A4 — Wait for the Remotion / scene-DSL refactor in `rfc-demo-video-strategy.md`

That RFC is 4-page-deep, multi-phase, and changes the contributor workflow substantially. Holding the LinkedIn post until it lands is months. Rejected — this RFC is a tactical upgrade to the existing pipeline so the bigger refactor can ship on its own timeline.

## Risks

- **Codex agent renders but provider badge fails to wire through.** Open Question 5. Mitigation: verify before recording. Fallback: lean harder on the tooltip overlay and on Act 6 closing card; the video still works, just less elegantly.
- **2:30 is tight for 7 acts.** Allow up to 2:50 hard cap. If acts overrun in dry runs, cut Act 5 (completion digest) first — the cost / completion story is the lowest-novelty beat.
- **4K upscale produces visible artifacts** on text-heavy UI. Mitigation: lanczos is the right algorithm for text; CRF 18 is conservative. If artifacts persist, fall back to 1080p as the primary asset and skip the 4K master entirely — the README link can point to the 1080p file with no loss of message.
- **Tooltip overlay timing collides with narration.** Mitigation: bake the tooltip into the same `tracker.mark('codex_fork')` beat so they share an anchor; if narration is muted, the tooltip still tells the story.
- **README link to `demo-v3` becomes a 404** if the recording isn't published before the README PR merges. Mitigation: bundle the README diff and the release publish in the same change window; do not merge the README PR until the release tag is live.
