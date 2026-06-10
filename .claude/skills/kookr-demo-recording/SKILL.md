---
name: kookr-demo-recording
description: How to record, verify, export, and publish the Kookr demo video with optional TTS narration audio
keywords: demo, video, recording, tts, text-to-speech, playwright, narration, audio, webm, mp4, vertical, shorts, gif, srt, subtitles, thumbnail, youtube, publish, regenerate demo, check mode
related: playwright-e2e-patterns, e2e-agent-testing
---

# Demo Recording

## When to Use

When you need to generate, verify, or regenerate the Kookr demo video and its distribution formats, with or without voice narration.

## Quick Reference

### ALWAYS check scenario alignment first

The recording drives the **real current frontend** (built by `pnpm build`, served by the E2E test server), so the video always shows the current UI by construction. What drifts are the *selectors and flows in the demo script*. Before any recording — and after any significant frontend change — run:

```bash
pnpm demo:check
```

This replays the entire scenario headless with all holds capped to ~150ms, no TTS, no video, no exports (~1 min). It fails loudly on any selector or flow drift and ends with `CHECK PASSED` when the script is fully aligned with the current UI. Never record without a passing check.

### Always prefer narrated video

The `.env` file in the repo root has `HF_TOKEN` and `KOOKR_TTS=true`. Copy it to the worktree if needed, then record with TTS:

```bash
cp $HOME/git/kookr/.env .env  # if in a worktree
pnpm demo:record                    # reads .env automatically
```

Only record silent if TTS is genuinely unavailable (Docker down, no HF token).

### Silent video (fallback only)

```bash
KOOKR_TTS= pnpm demo:record
```

### With external TTS service (already running)

```bash
KOOKR_TTS_URL=http://localhost:8004 pnpm demo:record
```

### Opening hook variants (A/B testing)

The first narration line is selectable — everything else stays identical, so variants are cheap to regenerate and A/B test on social:

```bash
DEMO_HOOK=A pnpm demo:record   # default: "Running five coding agents sounds like leverage…"
DEMO_HOOK=B pnpm demo:record   # "Your AI agents are fast. Supervising them is the part that does not scale."
DEMO_HOOK=C pnpm demo:record   # "This is what running five AI coding agents actually looks like…"
```

## How It Works

### Pipeline

1. **TTS setup** (if enabled): starts Docker container (`tts/docker-compose.yml`), generates WAV clips for each narration line via `POST /synthesize`
2. **Server start**: launches E2E test server with `FakeTerminalBackend` + `FakeTerminalBridge` (no tmux needed)
3. **Playwright recording**: drives the UI scenario with `recordVideo`, injects captions via DOM. The video opens directly on the cold-open terminal grid (pain first — social retention is decided in the first 3 seconds); the logo appears only on the closing CTA card.
4. **Audio sync**: `holdTime()` ensures each caption holds long enough for the speech clip to finish (clip duration + 500ms padding)
5. **ffmpeg merge**: combines silent video + timed audio clips using `adelay` filters
6. **Music bed** (optional): first audio file in `demo/assets/music/` is looped, faded, and mixed at low volume under the narration
7. **Subtitles**: `kookr-demo.srt` is generated from the same narration timeline (upload with the video so YouTube can auto-translate captions)
8. **Export matrix**: every distribution format is derived from the master WebM (see Output below)
9. **Cleanup**: stops TTS container, removes temp files

### Key files

| File | Purpose |
|------|---------|
| `demo/record.ts` | Main recording script — scenario, captions, TTS orchestration, check mode |
| `demo/lib/timeline.ts` | SRT builder + tracker-mark → cut-segment resolution |
| `demo/lib/exports.ts` | ffmpeg export matrix (MP4/vertical/teaser/loop/GIF) + music bed |
| `demo/terminal-content.ts` | Pre-scripted ANSI terminal output per agent |
| `demo/assets/music/` | Optional license-free music bed (first audio file is used) |
| `demo/output/` | Generated files (gitignored) |
| `tts/` | Pocket TTS Docker service (server.py, Dockerfile, docker-compose.yml) |
| `tts/voices/matilda.mp3` | Default narration voice (copied into the TTS image at build time) |
| `src/server/tts-manager.ts` | TTS Docker lifecycle (start/stop/health) |
| `src/server/fake-terminal-bridge.ts` | Streams pre-scripted content to xterm.js |

### Terminal content modes

- **`instant`** — dumps all content at once. Used for blocked/stopped agents (permission block, needs input). Terminal appears frozen.
- **`streaming`** — sends line-by-line at configurable speed. Used for healthy running agents. Conveys "this agent is busy."

### Narration scripts

Defined in `NARRATIONS` object in `demo/record.ts`. Each key maps to a `tracker.mark()` call in the scenario. To change narration text, edit the `NARRATIONS` object. Opening hook lines live in `HOOK_VARIANTS` (selected via `DEMO_HOOK`).

### Voice selection

Default: Matilda (`/app/voices/matilda.mp3`). Override with:
```bash
TTS_VOICE=alba pnpm demo:record   # Built-in voice (no HF_TOKEN needed)
```

Built-in voices (no token): `alba, marius, javert, jean, fantine, cosette, eponine, azelma`

### Output — export matrix

One recording produces every distribution format:

| File | Format | Channel |
|------|--------|---------|
| `kookr-demo.webm` | 1080p WebM master (narration + optional music) | YouTube upload |
| `kookr-demo.srt` | Subtitles from the narration timeline | Upload WITH the YouTube video → auto-translated captions worldwide |
| `kookr-demo.mp4` | 1080p H.264 + AAC | X / LinkedIn **native** upload (never link-only — native videos get far more reach) |
| `kookr-demo-4k.mp4` | 4K lanczos upscale | Release asset, high-DPI embeds |
| `kookr-demo-vertical.mp4` | 1080x1920 9:16, blur-padded | YouTube Shorts / Reels / TikTok |
| `kookr-demo-teaser.mp4` | ~30s cut (pain+hook → anomaly act → CTA) | Timeline teaser linking to the full video |
| `kookr-demo-loop.mp4` | 12s silent loop of the triage moment | Hero animation, social cards |
| `kookr-demo-loop.gif` | Same loop as GIF | GitHub README autoplay |
| `kookr-demo-thumbnail.jpg` | Designed thumbnail (headline over live UI) | YouTube custom thumbnail (<2MB) |
| `kookr-demo-screenshot.png` | Screenshot at peak state | README / docs |
| `kookr-demo-triage.png` | Screenshot during triage (terminal visible) | README / docs |

### Music bed

Drop one license-free track into `demo/assets/music/` (mp3/wav/m4a/ogg/flac — first file alphabetically is used). It is looped to the video length, mixed at ~9% volume under the narration, faded in 2s / out 3s. No file → narration-only (a one-line log says so). Only applied to narrated recordings.

### TTS service lifecycle

Mirrors the STT pattern exactly:
- `KOOKR_TTS=true` → auto-start Docker container on server start, auto-stop on shutdown
- `KOOKR_TTS_URL` → use external service (skip Docker)
- Non-fatal: TTS failure doesn't break the server or recording (falls back to silent)
- Manager: `src/server/tts-manager.ts` (mirrors `src/server/stt-manager.ts`)

## Emoji Rendering

Recording requires `fonts-noto-color-emoji` on Linux / Apple Color Emoji on macOS — verified by `demo/lib/preflight.ts` at startup.

## Fake Data Requirements

The demo uses `FakeTerminalBackend` — no real agents run. This means features that depend on real infrastructure need fake data injected:

| Feature | Problem | Fix |
|---------|---------|-----|
| **Cost tracking** | No transcripts → $0.00 | Use `POST /api/test/set-spend` to inject per-task token usage and lifetime spend |
| **Terminal output** | No tmux sessions | Use `POST /api/test/set-terminal-content` with pre-scripted ANSI content |
| **Project sidebar** | No git remotes | Use `POST /api/test/set-project-id` + `set-project-config` |
| **GitHub PRs** | No `gh` CLI polling | Use `POST /api/test/broadcast-github` |
| **AI suggestions** | No LLM call in test mode | Use `POST /api/test/broadcast-suggestion` |
| **Playbooks** | No `.kookr/playbooks/` on disk | Use `POST /api/test/broadcast-playbooks` |
| **Completion digest** | No real events to summarize | Use `POST /api/test/set-completion-digest/:taskId` |

**Rule: every caption claim must have corresponding injected data.** If you say "cost tracked in real time", the TopBar must show a nonzero dollar amount.

## UI behaviors that have bitten the scenario before

- **Onboarding tour**: suppressed via `?onboarding=0` URL param (version-proof) + the `kookr:onboarding:seen-v2` localStorage key. If the tour overlay intercepts clicks, the storage key version bumped — update both.
- **Project-filter sync**: selecting a task switches the project filter to that task's project. After triaging a webapp finding, api-service agents are filtered out — click the all-projects chip before showcasing them.
- **Findings auto-scroll**: a new finding scrolls the list to top, which can swallow a click landed mid-scroll. `selectFindingByText` retries once.
- **Achievement toasts**: pop at uncontrolled times bottom-right and read as noise to first-time viewers — suppressed via injected CSS for the entire recording.

## Demo Content Quality

### Playbooks
Playbooks in the demo must feel like real workflows a developer would repeat:
- **Good:** "Implement GitHub Issue" (param: issue URL), "Test Quality Audit" (param: module select), "Security Review" (param: focus area)
- **Bad:** "Bug Fix" (too generic), "Feature Implementation" (placeholder vibes)

Include at least one playbook with a **select dropdown** parameter so the viewer sees the parameter form is rich, not just text inputs.

### Interactive flows
When demonstrating interactive UI (snooze dialog, launch dialog, playbook parameters):
- **Hold the dialog visible** for 2-3 seconds before making a selection — the viewer needs to read the options
- **After an action changes UI state** (snooze moves task to snoozed section, complete moves to completed), wait for the new section to render and hold it visible
- **Match production behavior** — watch the real app for the flow before scripting the demo. Don't guess at what happens after an action.

### Marketing rules baked into the scenario (fresh-eyes review pass)
These came out of a panel of simulated first-time viewers (skeptic, eng manager, newcomer, power user) reviewing the actual frames + narration:
- **First 3 seconds show the pain**, never a logo. The cold-open grid is on screen from frame 1; the dashboard is revealed with a live finding already queued ("1 ACTIVE") — viewers must never see an empty findings panel.
- **The "aha" comes before the tour**: permission-block triage is Act 1; project filtering is Act 2. Front-load the hardest problem, not navigation.
- **No invented metrics, ever.** A footnoted "demo overlay, not a product feature" estimate destroys trust outright. Every quantified claim must be real and on screen (session cost in the TopBar, per-task cost, the completion digest).
- **Show the loop closing**: after Allow / a sent reply, inject a `PreToolUse` so the agent visibly resumes. "Send" must not look like it goes into the void.
- **Answer "how does it attach?" early** (the plumbing narration line: local hooks, replies land in the agent's terminal, nothing leaves your machine). It is the #1 skeptic objection.
- **The closing card is a real CTA**: repo URL, clone command, star prompt, stat strip. No unverifiable claims ("two minutes") in the narration.
- **The thumbnail is captured in a post-credits epilogue** after the `video_end` tracker mark; the published video is trimmed there, so the overlay never appears in footage.

## Post-Recording Checklist

After recording, verify each of these before committing:

1. **Audio:** Check `[tts] Generated N/N clips` in output. If any failed, fix before shipping.
2. **Duration:** Target 90-150s. Under 60s feels rushed; over 150s loses attention.
3. **Images:** Open both PNGs and the thumbnail JPG — no broken emoji boxes, blank areas, or wrong state. Thumbnail must be <2MB (YouTube limit).
4. **Captions match visuals:** Every claim in a caption should be visible on screen at that moment.
5. **File size:** WebM should be under 20MB at ~150s. If larger, the video may need shorter hold times.
6. **Snoozed/completed sections:** If the scenario snoozes or completes a task, verify the corresponding section renders in the findings panel.
7. **Export matrix:** The `[export] Artifact summary:` block at the end of the run must list every file with no `MISSING` entries.
8. **SRT spot-check:** Open `kookr-demo.srt` — cue times must roughly match when each caption appears in the video.

## Publish Checklist

The live video is **YouTube `DHZrO8T_6Xg`**, linked from the root `README.md` (thumbnail image + link). When shipping a new version:

1. **Upload to YouTube**: `kookr-demo.webm` (or the 4K MP4), plus `kookr-demo.srt` as a subtitle track (enables auto-translated captions worldwide), plus `kookr-demo-thumbnail.jpg` as the custom thumbnail. Title pattern: "Kookr — supervise 5 AI coding agents from one attention queue".
2. **Update README.md**: replace the YouTube video ID in both the thumbnail `img` URL and the watch link.
3. **Release assets**: attach `kookr-demo-4k.mp4`, `kookr-demo.mp4`, and `kookr-demo-vertical.mp4` to the next GitHub release (per `demo/README.md`, long-form media lives on releases, not in the repo).
4. **Shorts/Reels/TikTok**: post `kookr-demo-vertical.mp4` with the repo URL in the description.
5. **X/LinkedIn**: native-upload `kookr-demo.mp4` (or the teaser with a link to the full video). Never post a bare YouTube link — native uploads get materially more reach.
6. **Update this skill**: record the new YouTube ID here and the `DEMO_HOOK` variant used, so the next regeneration knows what is live.

### When to regenerate

- Any visible UI change to surfaces the demo shows (TopBar, findings panel, detail panel, snooze/launch dialogs, GitHub tab)
- A headline feature ships that the narration should mention
- `pnpm demo:check` fails — fix the scenario, then re-record

### Troubleshooting

| Issue | Fix |
|-------|-----|
| "Voice load failed" | Need `HF_TOKEN` in `.env` for voice cloning voices. Or use a built-in voice. |
| Docker build timeout | First build installs PyTorch+CUDA (~6GB). Subsequent builds use cache. |
| ffmpeg not found | Install ffmpeg: `sudo apt install ffmpeg` |
| No audio in output | Check that `[tts] Generated N/N clips` shows in output. If 0, TTS failed. |
| Broken emoji boxes | Install `fonts-noto-color-emoji` (Linux) and run `fc-cache -fv`. Preflight will fail fast if the font is missing. |
| $0.00 in TopBar | Inject fake spend data via `/api/test/set-spend` |
| Snooze/complete task vanishes | Wait for the snoozed/completed section to render after the action |
| Onboarding overlay blocks clicks | Storage key version bumped — see "UI behaviors that have bitten the scenario" |
| Export job FAILED in summary | Re-run just the exports by calling the function from `demo/lib/exports.ts` against the existing `kookr-demo.webm` |
