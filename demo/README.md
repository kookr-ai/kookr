# Demo Media

Kookr's README uses one primary above-the-fold product visual:

- `assets/branding/derived/kookr-screenshot.png` for the static dashboard screenshot.
- The narrated demo video linked from the README release page for the full walkthrough.

Do not add a second near-identical dashboard animation directly under the hero screenshot. If the README needs animation later, prefer a short, crisp MP4 hosted on GitHub release assets or user attachments instead of committing a large binary to the repository.

## Regenerate The Demo

Use the checked-in Playwright recorder:

```bash
pnpm demo:record
```

This runs the demo scenario and writes:

```text
demo/output/kookr-demo.webm
demo/output/kookr-demo-screenshot.png
demo/output/kookr-demo-triage.png
```

To include narration, run the recorder with a TTS server:

```bash
KOOKR_TTS_URL=http://localhost:8004 pnpm demo:record
```

Before replacing README media, verify that terminal and dashboard text are legible at GitHub README width. Publish long-form demo videos as release assets, then keep the README link pointed at the release.
