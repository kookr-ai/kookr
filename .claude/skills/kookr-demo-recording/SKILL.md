---
name: kookr-demo-recording
description: How to record the Kookr demo video with optional TTS narration audio
keywords: demo, video, recording, tts, text-to-speech, playwright, narration, audio, webm, regenerate demo
related: playwright-e2e-patterns, e2e-agent-testing
---

# Demo Recording

## When to Use

When you need to generate or regenerate the Kookr demo video, with or without voice narration.

## Quick Reference

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

## How It Works

### Pipeline

1. **TTS setup** (if enabled): starts Docker container (`tts/docker-compose.yml`), generates WAV clips for each narration line via `POST /synthesize`
2. **Server start**: launches E2E test server with `FakeTerminalManager` + `FakeTerminalBridge` (no tmux needed)
3. **Playwright recording**: drives the UI scenario with `recordVideo`, injects captions via DOM
4. **Audio sync**: `holdTime()` ensures each caption holds long enough for the speech clip to finish (clip duration + 500ms padding)
5. **ffmpeg merge**: combines silent video + timed audio clips using `adelay` filters
6. **Cleanup**: stops TTS container, removes temp files

### Key files

| File | Purpose |
|------|---------|
| `demo/record.ts` | Main recording script — scenario, captions, TTS orchestration |
| `demo/terminal-content.ts` | Pre-scripted ANSI terminal output per agent |
| `demo/output/` | Generated files (gitignored) |
| `tts/` | Pocket TTS Docker service (server.py, Dockerfile, docker-compose.yml) |
| `tts/voices/matilda.mp3` | Default narration voice (cloned from aegiscore) |
| `src/server/tts-manager.ts` | TTS Docker lifecycle (start/stop/health) |
| `src/server/fake-terminal-bridge.ts` | Streams pre-scripted content to xterm.js |

### Terminal content modes

- **`instant`** — dumps all content at once. Used for blocked/stopped agents (permission block, needs input). Terminal appears frozen.
- **`streaming`** — sends line-by-line at configurable speed. Used for healthy running agents. Conveys "this agent is busy."

### Narration scripts

Defined in `NARRATIONS` object in `demo/record.ts`. Each key maps to a `tracker.mark()` call in the scenario. To change narration text, edit the `NARRATIONS` object.

### Voice selection

Default: `matilda` (voice clone from `tts/voices/matilda.mp3`). Override with:
```bash
TTS_VOICE=alba pnpm demo:record   # Built-in voice (no HF_TOKEN needed)
```

Built-in voices (no token): `alba, marius, javert, jean, fantine, cosette, eponine, azelma`

### Output

| File | Description |
|------|-------------|
| `demo/output/kookr-demo.webm` | Final video (with audio if TTS was used) |
| `demo/output/kookr-demo-screenshot.png` | Screenshot at peak state (2 findings) |
| `demo/output/kookr-demo-triage.png` | Screenshot during triage (terminal visible) |

### TTS service lifecycle

Mirrors the STT pattern exactly:
- `KOOKR_TTS=true` → auto-start Docker container on server start, auto-stop on shutdown
- `KOOKR_TTS_URL` → use external service (skip Docker)
- Non-fatal: TTS failure doesn't break the server or recording (falls back to silent)
- Manager: `src/server/tts-manager.ts` (mirrors `src/server/stt-manager.ts`)

## Emoji Rendering

Recording requires `fonts-noto-color-emoji` on Linux / Apple Color Emoji on macOS — verified by `demo/lib/preflight.ts` at startup.

## Fake Data Requirements

The demo uses `FakeTerminalManager` — no real agents run. This means features that depend on real infrastructure need fake data injected:

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

## Post-Recording Checklist

After recording, verify each of these before committing:

1. **Audio:** Check `[tts] Generated N/N clips` in output. If any failed, fix before shipping.
2. **Duration:** Target 90-120s. Under 60s feels rushed; over 150s loses attention.
3. **Screenshots:** Open both PNGs and verify no broken emoji boxes, blank areas, or wrong state.
4. **Captions match visuals:** Every claim in a caption should be visible on screen at that moment.
5. **File size:** WebM should be under 15MB. If larger, the video may need shorter hold times.
6. **Snoozed/completed sections:** If the scenario snoozes or completes a task, verify the corresponding section renders in the findings panel.

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
