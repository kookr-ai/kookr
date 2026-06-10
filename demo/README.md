# Demo Media

Kookr's README uses one primary above-the-fold product visual:

- `assets/branding/derived/kookr-screenshot.png` for the static dashboard screenshot.
- The narrated demo video linked from the README release page for the full walkthrough.

Do not add a second near-identical dashboard animation directly under the hero screenshot. If the README needs animation later, prefer a short, crisp MP4 hosted on GitHub release assets or user attachments instead of committing a large binary to the repository.

## Verify Scenario Alignment First

The recorder drives the real, freshly built frontend — so the video always shows the current UI. What can drift is the demo script itself (selectors, flows). Before recording, run:

```bash
pnpm demo:check
```

This replays the full scenario headless in about a minute (no TTS, no video) and fails loudly on any drift. Never record without a passing check.

## Regenerate The Demo

Use the checked-in Playwright recorder:

```bash
pnpm demo:record
```

This runs the demo scenario and writes the full export matrix:

```text
demo/output/kookr-demo.webm            # 1080p master (narration + optional music bed)
demo/output/kookr-demo.srt             # subtitles — upload with the YouTube video
demo/output/kookr-demo.mp4             # 1080p H.264 for X/LinkedIn native upload
demo/output/kookr-demo-4k.mp4          # 4K release asset
demo/output/kookr-demo-vertical.mp4    # 9:16 for Shorts/Reels/TikTok
demo/output/kookr-demo-teaser.mp4      # ~30s timeline teaser
demo/output/kookr-demo-loop.mp4        # 12s silent hero loop
demo/output/kookr-demo-loop.gif        # same loop for GitHub README autoplay
demo/output/kookr-demo-thumbnail.jpg   # designed YouTube thumbnail
demo/output/kookr-demo-screenshot.png
demo/output/kookr-demo-triage.png
```

To include narration, run the recorder with a TTS server:

```bash
KOOKR_TTS_URL=http://localhost:8004 pnpm demo:record
```

Opening hook variants for A/B testing: `DEMO_HOOK=A|B|C pnpm demo:record`.

Optional music bed: drop one license-free track into `demo/assets/music/` — see `demo/assets/music/README.md`.

Before replacing README media, verify that terminal and dashboard text are legible at GitHub README width. Publish long-form demo videos as release assets, then keep the README link pointed at the release.

The full publish checklist (YouTube upload with SRT + thumbnail, release assets, social formats) lives in `.claude/skills/kookr-demo-recording/SKILL.md`.
