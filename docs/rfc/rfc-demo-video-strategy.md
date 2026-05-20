# RFC: Demo Video Strategy for the Multi-Feature Kookr UI

## Status

**Draft (v3 — post round-2 review revision + empirical probe closure)**

## Problem

The current demo pipeline (`demo/record.ts`, 1296 lines + `demo/terminal-content.ts`, 309 lines) was designed when Kookr exposed five or six user-facing features. The app today exposes fifteen feature categories (F1–F15 + F-Settings). An audit of the current ~90–120s recording confirms it covers roughly 40% of the documented surface — strong on F1/F3/F4/F5 (the core loop), partial on F6/F7, and effectively absent on F2 (anomaly UI), F8 (session reflection), F9 (autonomy), F10 (circuit breakers), F11 (schedules), F12 (contribution workspace), F13 (achievements), F14 (Claude API quota), F15 (self-diagnostics), and F-Settings.

Two structural problems block a straightforward extension:

1. **Monolithic single-pass orchestration.** `record()` is a 600-line async function with seven hardcoded acts inline. Adding an eighth act means inserting another 150-line block into an already-dense function. There is no scenario DSL, no per-act helper, and no branching/parallel scene support. Stretching this approach to 15 features pushes the file past 2500 lines and the runtime past five minutes — outside the 60–180s window where viewers retain attention.

2. **Brittle DOM-injected captions and audio sync.** Captions are `<div>` elements injected via `page.evaluate()` and captured by Playwright's video encoder. Audio is generated separately by the Pocket TTS Docker service, then merged with `ffmpeg adelay`. The math relies on `Date.now()` offsets accumulating accurately across the entire recording. Over 90s with 13 narration clips, sync drift of ±50ms per clip is plausible; over 180s with 25+ clips, audible lip-sync misses become likely.

(A third problem — the emoji hide-list — is decoupled and addressed by Phase 0 alone, independent of architecture.)

Without a structural change, the demo will continue to misrepresent the product: a viewer sees the core loop and concludes Kookr is "just" an attention router for permission prompts, missing the playbooks, GitHub awareness, contribution workspace, achievements, scheduled tasks, diagnostics, session reflection, circuit breakers, and quota tracking that now make up the bulk of the value.

### Why now

Cost of inaction over the next 90 days is concrete: every feature shipped (F8 reflection landed in v1.x; F12 workspace and F13 achievements are recently shipped; F11 schedules, F14 quota, F15 diagnostics likewise) widens the gap between what the demo shows and what the product does. The README hero, contributor onboarding, and any external demo asset all draw from the same artifact. Each delayed week increases the probability that a maintainer ships a screenshot-driven asset to compensate, fragmenting the demo story across artifacts that drift independently. The RFC is timed to refit the pipeline before the F8/F10/F11/F12/F14/F15 audit gap becomes embarrassing rather than merely incomplete.

## Audience

The primary audience is a **developer evaluating Kookr for adoption** — typically a maintainer running multiple AI agents who lands on the README or a Show HN-style post. They tolerate 120–180s of dense feature demonstration if pacing is good, want to see the anomaly detection mechanism in concrete terms, and trust visible cause-and-effect ("Kookr surfaced this; the developer responded; the next agent surfaced") more than narrated claims.

A 60s investor / tweet-share cut is desirable but explicitly out of scope for V1. Once the per-scene scene library exists (Phase 1 deliverable), assembling a second `Composition.tsx` that selects a subset of clips is near-zero additional effort — see Open Questions.

The pipeline is **not** optimized for a passive marketing teaser; that audience would call for a different story entirely (motion-graphics over real product capture, voiceover talent, human editing). That artifact stays out of this RFC.

## Requirements

The redesigned pipeline must:

- **R1 — Cover ≥80% of documented features (F1–F15, F-Settings)** in the final video without exceeding 180 seconds of total runtime. The scene plan in Design includes every feature category named "absent" in the Problem section — F8 and F10 included.
- **R2 — Be regenerable in CI** with no human in the loop. Same code + same input + same pinned environment → **structurally identical** output (verified by per-frame SSIM ≥ 0.99 on a sampled grid + audio waveform Pearson correlation ≥ 0.99 against a committed reference). Byte-identity SHA-256 is **not** the gate — Chromium's H.264 encoder is non-deterministic across hardware (libavcodec vs VideoToolbox), Chrome shell minor versions, font rasterizers (FreeType vs Core Text), and V8 builds; demanding byte-identity guarantees a "constantly-failing-so-everyone-rubber-stamps" regression.
- **R3 — Support per-scene editing** so a feature change can be re-recorded for one scene without re-running the entire demo, with cross-scene state isolation enforced by an automated test.
- **R4 — Preserve narrated audio** by consuming the existing TTS clip output. Replacing the upstream TTS service is out of scope.
- **R5 — Run on Linux and macOS** with no GPU requirement. WSL2 must work for development. Single doctor command surfaces missing dependencies before any capture starts.
- **R6 — Use only OSS or permissively-licensed dependencies** that are free for Kookr's posture. Kookr is donationware released under a permissive license, maintained by a single individual (Jean Ibarz) — Remotion's "free for individuals and companies with ≤3 employees" tier comfortably applies. A passive `package.json#contributors` list serves as a tripwire if the contributor base ever grows past that boundary, but no hard CI gate is needed for an individual project.
- **R7 — Eliminate the emoji hide-list** by ensuring the recording host has the required fonts and `fontconfig` cache state. Phase 0 alone covers this.
- **R8 — Render in under 30 minutes locally** for a 180s output on a contributor laptop with at least 4 cores and 16 GB RAM. If a measured 4-core baseline exceeds this, R8 is **relaxed to ≤45 minutes** AND `pnpm demo:scene <id>` becomes the canonical local workflow with full renders running on CI; the demo never simply "stalls in Phase 1." The else branch is mandatory.
- **R9 — Not leak PII or secrets** into committed demo artifacts. An automated frame-content scan runs before any committed `.mp4`.

Non-goals:

- **NG1 — Do not record real Claude Code / Codex CLI agents.** The fake-data API surface is intentional and load-bearing for determinism. Authenticity tradeoff acknowledged in Alternatives.
- **NG2 — Do not adopt a cloud render farm in V1.** Local CPU rendering must be sufficient for contributors.
- **NG3 — Do not replace TTS service** in this RFC.
- **NG4 — Do not produce multi-variant outputs in V1** (e.g., a separate 60s investor cut). Architected to make this trivial later, not delivered.

## Design

### Architecture: Playwright (capture) + Remotion (compositing)

```
┌──────────────────────────────────────────┐
│ demo/orchestrate.ts (entry)              │
│ Per-scene Playwright captures, sequential│
│ → scene-anomaly-respond.webm             │
│ → scene-permission-block.webm            │
│ → scene-playbooks.webm                   │
│ ... (10–11 scenes, 10–18s each)          │
│ Captions + cursor highlights baked-in    │
│ via CSS class injection at capture time  │
│                                          │
│ Per-scene narration via existing TTS     │
│ → narration-anomaly-respond.mp3          │
│ ...                                      │
└──────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│ demo/remotion/ (subfolder, root pkg.json)│
│ Composition.tsx — declarative timeline   │
│ <TransitionSeries> w/ <OffthreadVideo>   │
│ <Audio> per scene                        │
│ Inline 0.5s text-fade act-boundary cards │
└──────────────────────────────────────────┘
                    │
                    ▼
              kookr-demo.mp4
              H.264 + AAC, 1280×720, 30fps
              SHA-256 checked against reference
```

**Why this split:**

- **Playwright stays the source of truth for product UI.** Real React components, real state, real interactions. We never mockup Kookr — the demo always reflects the actual app.
- **Remotion replaces the ffmpeg compositing stage.** Scene transitions, act-boundary cards, and audio mixing become declarative React (`useCurrentFrame()`, `interpolate()`, `<Sequence>`, `<Audio>`, `<OffthreadVideo>`). The team already writes React.
- **Captions and cursor highlights bake into the Playwright capture**, not into Remotion. CSS class injection at capture time (`page.addStyleTag({ content: '.kookr-callout-target { box-shadow: 0 0 0 4px gold; }' })` plus `page.evaluate` to add the class to the target element) means the highlight survives any UI layout change and needs no Remotion coordinate math. The visible cursor causality (Kookr alert → developer click) is the product claim made visible; this is V1, not Phase 3 polish.

**Both POCs validated:** The multi-scene Playwright + ffmpeg POC confirmed `xfade`, `adelay`, and per-scene context spin-up. The Remotion POC confirmed `<Video>`/`<Audio>`/CLI render against synthetic content. A targeted follow-up empirical probe is verifying the same with real Playwright vp8 output through `<OffthreadVideo>`; result will gate Phase 2 entry.

### Scene plan (10 scenes × 12–18s ≈ 150s + ~15s of inline act-fades)

| # | File | Features covered | Target dur | Group |
|---|---|---|---|---|
| 1 | `01-orient-launch.ts` | F1.2/F1.3/F1.4 (status, activity, metadata), F4.1 (launch), F4.8 (AI naming) | 12s | Triage |
| 2 | `02-anomaly-respond.ts` | F2.1 (needs input), F3.1/F3.2/F3.3 (view/respond/advance), F3.9 (AI suggestions), F5.6 (loop) | 18s | Triage |
| 3 | `03-permission-quick-action.ts` | F2.4 (permission block), F3.8 (quick action), F2.7 (explanation) | 12s | Triage |
| 4 | `04-playbooks.ts` | F6.1/F6.2/F6.3 (browse, parameter, launch), F4.5 (criteria) | 15s | Workflow |
| 5 | `05-github-awareness.ts` | F7.1/F7.2/F7.3/F7.4/F7.5 (PR detected, CI failure, alert, GitHub tab) | 15s | Workflow |
| 6 | `06-contribution-ws.ts` | F12.1/F12.3/F12.4 (worktree lease, cleanup view, safe cleanup), F4.10 (parent/child) | 15s | Workflow |
| 7 | `07-schedules-autonomy.ts` | F11.1/F11.4 (cron + UI), F9.1/F9.2 (autonomy + auto-proceed) | 15s | Operations |
| 8 | `08-reflection-breakers.ts` | F8.1/F8.2/F8.3 (interaction log, friction, report), F10.1/F10.3 (breaker state + status panel) | 18s | Operations |
| 9 | `09-quota-diagnostics-settings.ts` | F14.1/F14.2 (quota), F15.1/F15.3 (diagnostics + stats), FS.1/FS.2 (settings) | 15s | Operations |
| 10 | `10-achievements-allclear.ts` | F13.1/F13.2/F13.3 (catalog, unlock toast, panel), F5.7 (all clear) | 12s | Closing |

Scenes 8 and 9 are the explicit fix to round-1 finding that F8 and F10 contradicted R1. Group fades (Triage→Workflow→Operations→Closing) are inline 0.5s text-fade overlays in `Composition.tsx`, not dedicated React components.

Each scene file exports a `Scene` object: `{ id, fIds, narrations, targetDurationMs, capture(ctx) }`. The orchestrator runs them sequentially, calling `POST /api/test/reset` between scenes.

### Sticky scene durations (with deterministic trim, not band rejection)

Each scene declares `targetDurationMs`. After capture, `ffmpeg -ss 0 -t <targetSeconds> -c copy` trims the recorded `.webm` to exactly the declared target. Composition then uses `targetDurationMs` directly. This is deterministic regardless of Playwright's known 0.6–0.8s encoder-tail-latency variance — the trim is post-process, not a flaky band check. A capture that came in shorter than target fails loudly (the `holdTime` was too short, fix the scene). A capture that came in longer is silently trimmed. This closes the round-1 drift concern and the round-2 ±100ms-too-tight concern in one move.

### Phased delivery

**Phase 0 — Decoupled emoji fix (1 day, ships independently).**
- Linux: ensure `fonts-noto-color-emoji` is installed and `fc-cache -fv` runs before any Chromium spawn.
- macOS: relies on system Apple Color Emoji, which Chromium picks up via Core Text. Add a sanity check in the doctor command.
- Add `demo/lib/preflight.ts` that detects font availability via Playwright `page.evaluate(() => getComputedStyle(...).fontFamily)` against a known emoji-bearing element. Fail with an actionable error before recording starts.
- Remove the four CSS hide rules from `record.ts`. Reference is by code search anchor (the unique string `// EMOJI-HIDE-LIST-V1`), not line number, so the Phase 0 patch survives concurrent edits.
- Update `.claude/skills/kookr-demo-recording/SKILL.md` Headless Chromium Gotchas section.

**Phase 1 — Per-scene Playwright captures + Remotion-rendered output (7–10 days; round-2 review found the v2 5-day estimate optimistic for atomic landing).**
Adopt round-1 critic feedback: skip the intermediate ffmpeg merge entirely. Phase 1 produces both the per-scene captures *and* the Remotion-rendered MP4 in one PR. To reduce atomic-landing risk, work behind a `KOOKR_DEMO_PIPELINE=v2` env flag — the existing `demo/record.ts` keeps working until the new pipeline produces an acceptable demo, then the flag becomes default and the old monolith is deleted in a follow-up PR.

- Refactor `record.ts`:
  - Old single-context recording becomes `demo/scenes/*.capture.ts` (10 files, ~150 lines each — capture functions only, Playwright-side imports).
  - `demo/scenes/manifest.ts` — pure data: `{ id, file, targetDurationMs, narrationFile, fIds }[]`. **Imported by both Playwright orchestrator AND Remotion Composition** (round-2 FM-10: keeps Playwright out of the Remotion bundle).
  - `demo/orchestrate.ts` is the new entry point. Old `pnpm demo:record` script aliases to `orchestrate.ts` so the contributor surface is unchanged.
  - `demo/lib/scene-context.ts` — Playwright context factory + fake-API helper + narration helper.
  - `demo/lib/preflight.ts` — environment doctor (font, ffmpeg ≥5.0, ffprobe, Docker for TTS, Node ≥20, Remotion Chrome shell present). On macOS uses `ls /System/Library/Fonts/Apple\ Color\ Emoji.ttc` (sub-millisecond), not `system_profiler`.
  - `demo/lib/measure-scene-duration.ts` — `ffprobe` JSON parse with explicit version sniff.
  - `demo/lib/trim-scene.ts` — `ffmpeg -ss 0 -t <target> -c copy` to enforce sticky duration deterministically.
  - `demo/lib/scene-contract.ts` — TypeScript module that imports the `ServerMessage` union from `src/shared/contracts/messages.ts` and exports type-checked `injectFakeX` helpers. Compiling scene files now fails `tsc` if a server contract changes.
  - **Pre-flight TTS pass before any Playwright capture**: the orchestrator generates and measures all narration clips first; if any clip exceeds its scene's `targetDurationMs`, the orchestrator fails fast with a full diff (`narrations 3, 7, 9 exceed targets by 0.7s, 0.3s, 1.1s`). One round of edits, one re-run — never lose 6 captured scenes to a 7th narration overrun.
  - Locale + TZ pinning is enforced via Playwright **`contextOptions: { locale: 'en-US', timezoneId: 'UTC' }`** plus `args: ['--lang=en-US']` on every browser context. Process-level `LANG=` / `TZ=` does not propagate into Chromium's `Intl` resolution, so the contextOptions path is the only correct fix (round-2 FM-11).
  - Cursor-causality CSS class uses a per-run UUID suffix (`.kookr-callout-target-${uuid}`) to avoid collision with any current or future app class. CI grep guard: `rg "kookr-callout-target" src/` must match zero lines.
  - End-of-scene **settle hold**: every scene's capture function awaits `requestIdleCallback` + transitionend events on visible elements before yielding, so act-boundary fades never overlay mid-animation frames (round-2 FM-4).
- Add Remotion to **root** `package.json` as a devDependency. Remotion sources live in `demo/remotion/` as a subfolder, not a workspace package. `vite.config.ts` adds `optimizeDeps.exclude: ['remotion']` to keep the main app build clean.
- Add `demo/remotion/Root.tsx` and `demo/remotion/Composition.tsx`:
  - `<TransitionSeries>` with one `<TransitionSeries.Sequence durationInFrames={target}>` per scene
  - `<OffthreadVideo src={staticFile(scene.webm)}/>` + `<Audio src={staticFile(scene.mp3)}/>` per sequence
  - Inline 0.5s text fades at group boundaries (3 boundaries — Triage→Workflow, Workflow→Operations, Operations→Closing) using `interpolate(frame, [start, start+15], [0, 1])` opacity on a positioned div. No `ChapterIntro.tsx` component.
- Add `pnpm demo:render` (full sweep), `pnpm demo:scene <id>` (single scene), `pnpm demo:render --frames=0-300` (preview window), `pnpm demo:doctor` (preflight only).

**Phase 2 — Hardening, gates, determinism (5–7 days; round-2 found the v2 3-day estimate undercosted, especially for OCR PII scan setup).**
- **Structural-identity gate** (replaces the v2 SHA-256 byte-identity approach): render on a pinned `macos-14` GH Actions runner (Apple Silicon, deterministic VideoToolbox). Compare output against `demo/output/reference/` using:
  - Per-frame SSIM ≥ 0.99 on a 30-frame sample grid (3 frames × 10 scenes)
  - Audio waveform Pearson correlation ≥ 0.99 against `reference.wav`
  - Container metadata sanity (resolution, fps, codec) exact-match
  - Fails PR if any threshold is missed.
- **Scene-contract test**: vitest assertion that every scene's fake-data calls type-check against current `ServerMessage` types. Note this catches structural drift only — semantic drift (e.g., enum value renamed but shape preserved) is NOT caught; round-3 may add a string-table assertion if needed.
- **State-reset coverage assertion**: integration test uses `vi.resetModules()` + dynamic import per Zustand slice (round-2 FM-6 — co-importing all slices pollutes initial state). Snapshots initial state to `demo/test/fixtures/initial-store-state.json`. Asserts post-reset against snapshot, not against the slice's live module export. Plus a glob-based coverage check: `glob('src/frontend/**/*-store.ts')` diffed against an enumerated allowlist; fails if a store file exists that isn't in the test.
- **PII scan**: `demo/lib/scrub-frames.ts` runs OCR (Tesseract in a small standalone container) at **10 fps over the full 180s** (~1800 frames; ≈6 min on CPU for the OCR pass — acceptable in CI), event-anchored extra frames at every `<TransitionSeries>` boundary and the middle of each scene. **Plus a TTS-source-text scan**: every narration string is regex-scanned BEFORE the TTS call, blocking pre-render rather than post-OCR (round-2 FM-1: a stale `contributorName: "real-name@github"` would render aloud and ship; OCR can't catch that). Fixture allowlist enumerated in `demo/lib/pii-allowlist.ts`. False-positive bypass requires a documented PR comment per added entry.
- **License tripwire** (not gate): a `pnpm demo:license-check` script runs `git shortlog -sne -- demo/` and prints a warning if it ever reports more than 3 unique authors — at which point the maintainer reconsiders Remotion seat licensing. No hard CI failure: Kookr is donationware run by an individual, the Remotion "free for individuals and ≤3-person teams" tier is satisfied with margin. If the project's contributor base ever shifts (e.g., a small team forms around it), this tripwire surfaces the question; until then, it's a no-op.
- **`pnpm demo:bless` is gated**: blessing a new reference internally invokes the full `demo:render` + PII scan + license gate before writing. No back-doors. Two-reviewer approval required on any commit that touches `demo/output/reference/`.
- **Version pinning**: doctor refuses to run on ffmpeg/ffprobe < 5.0.

Phase 3 (audio ducking, speed ramping, multi-variant cuts) **was cut.** Round-1 review found speed ramping has no concrete idle-frame detection plan and 2× audio is "chipmunk-grade"; audio ducking depends on ambient music that doesn't exist; multi-variant cuts are NG4. Remove temptation to perpetually defer.

### Handling render time on contributor laptops

R8 requires <30 min on a 4-core / 16GB machine. The 24-core POC measured 0.25× realtime (12 min for 180s). A 4-core machine plausibly degrades to 0.10–0.15× realtime — 20–30 min for 180s. Three concrete iteration helpers and a defined else branch:

- `pnpm demo:scene <id>` recaptures one scene only; full render runs only at release.
- `pnpm demo:render --frames=0-300` previews the first 10s of any composition change in <60s.
- Phase 2 entry runs a **mandatory measurement step**: a contributor on a 4-core M1 Air (or vendor-equivalent — Apple M1, AMD Ryzen 5 5500U, Intel i5-1235U) records `demo/perf/4core-measurement.json` with `total_render_ms`. The measurement file is committed alongside Phase 2 and CI reads it.
- **Else branch (round-2 FM-2 fix)**: if `total_render_ms > 1_800_000` (30 min), R8 is relaxed to ≤45 min, full renders move to CI as canonical (`macos-14` runner), and `pnpm demo:scene <id>` becomes the documented local development loop. The demo does NOT stall in Phase 1; the workflow shifts. This is the explicit fallback the gate needs.
- macOS GH Actions runners cost ~$0.16/min vs $0.008/min for ubuntu-latest. Release-tag-only renders cap exposure at ~$5/release. Documented in `demo/remotion/COST.md`.

### Audio handling at scene boundaries

Each scene's narration is an independent `<Audio src>` element anchored to its own `<TransitionSeries.Sequence>`. There is no global audio track. If TTS for a scene is missing (Docker down), Composition silently substitutes a `null` `<Audio>` and emits a build warning so the silent-fallback case is observable. If TTS clip is shorter than scene duration, the fixed `targetDurationMs` makes trailing silence intentional rather than buggy. If TTS clip is longer than scene duration, the orchestrator fails the capture with an actionable error ("narration N (4.2s) exceeds scene N target (3.5s); shorten narration or extend target").

## Files to change

**Phase 0:**
- `demo/record.ts` — remove the four CSS rules under the `// EMOJI-HIDE-LIST-V1` anchor
- `demo/lib/preflight.ts` (new) — font and dependency check; called from existing entry
- `.claude/skills/kookr-demo-recording/SKILL.md` — remove Headless Chromium Gotchas hide-list, document font requirement
- `README.md` — add a "Recording prerequisites" subsection (font, ffmpeg ≥5.0, Docker for TTS)

**Phase 1:**
- `demo/record.ts` → split into `demo/orchestrate.ts` + `demo/scenes/01-orient-launch.ts` … `10-achievements-allclear.ts`
- `demo/lib/scene-context.ts`, `demo/lib/measure-scene-duration.ts`, `demo/lib/scene-contract.ts` (all new)
- `demo/remotion/Root.tsx`, `demo/remotion/Composition.tsx` (new)
- `package.json` — add `remotion`, `@remotion/transitions` deps; add `demo:render`, `demo:scene`, `demo:doctor` scripts
- `vite.config.ts` — `optimizeDeps.exclude: ['remotion', '@remotion/transitions']`
- `.gitignore` — `~/.cache/remotion/` (per-user; project-relative is auto-handled by Remotion)

**Phase 2:**
- `demo/lib/scrub-frames.ts` (new) — OCR + regex PII scan at 10fps, event-anchored
- `demo/lib/scrub-narration.ts` (new) — regex scan of TTS source strings before synthesis
- `demo/lib/pii-allowlist.ts` (new) — enumerated fixture entries
- `demo/test/scene-contract.test.ts` (new) — type assertion against `ServerMessage`
- `demo/test/state-reset-coverage.test.ts` (new) — uses `vi.resetModules()`, snapshot-based
- `demo/test/store-coverage.test.ts` (new) — glob check for un-enumerated stores
- `package.json` — add `demo:license-check` script wrapping `git shortlog -sne -- demo/` with a >3-author warning
- `.github/workflows/demo-render.yml` (new) — release-tag-only render on `macos-14`, SSIM + audio-correlation gate against committed reference
- `demo/output/reference/` (new committed dir) — sample frames + reference audio. Updated only via `pnpm demo:bless`, which internally re-runs PII + license gates.
- `demo/perf/4core-measurement.json` (new committed) — measured render time on a 4-core machine; gates Phase 2 R8 path.
- `demo/remotion/COST.md` (new) — CI runner cost note.

## Edge cases

- **Fontconfig cache stale after `apt install`.** Phase 0 explicitly runs `fc-cache -fv` and the preflight font probe verifies emojis render before capture proceeds.
- **macOS preflight.** Phase 0 doctor checks `system_profiler SPFontsDataType` for "Apple Color Emoji" and sanity-tests via the Playwright probe; no apt path required.
- **GitHub Actions ubuntu-latest is 2 vCPU + 7 GB.** Round-1 review correctly flagged this can blow R8. CI render in Phase 2 runs on `macos-14` (4-core M1) or a self-hosted Linux runner, scheduled per release tag, **not on every PR**. PR CI runs only the scene-contract test, state-reset-coverage test, and PII scan against a fixture frame set — fast enough for normal PR latency.
- **Remotion license posture.** Kookr is donationware released under a permissive license, maintained by a single individual — the Remotion "free for individuals and ≤3-person teams" tier applies with margin. The `demo:license-check` script is a passive tripwire that prints a warning if `git shortlog -sne -- demo/` ever reports more than 3 unique authors. No hard CI block: that complexity isn't justified for an individual project's reality.
- **Codec output choice.** Default is H.264 in MP4 (Remotion default). Wider device coverage than `.webm`. Color space is forced to BT.709 in Remotion's render config to avoid Safari/QuickTime washouts identified in round-1 review.
- **Playwright vp8 → Remotion `<OffthreadVideo>` artifacts: empirically closed.** A targeted probe rendered two real Playwright vp8 captures (red/blue 1280×720) through `<TransitionSeries>` with a 0.5s `fade` and exhaustively checked all 158 output frames. Result: no black frames, no keyframe glitches, no VFR drift (Remotion absorbs 25fps→30fps cleanly), zero seek failures in verbose compositor logs. **No normalization step is required.** Use `<OffthreadVideo>` (not `<Video>`, which fails in headless render for vp8). The vp8 stream header reports `duration=N/A` — this is benign because Remotion uses `durationInFrames` from the `Sequence` wrapper, never the stream header.
- **Audio at TransitionSeries boundaries sums, does not crossfade** (probe finding). During the transition overlap window, both scenes' `<Audio>` tracks play simultaneously at full volume — this is mixing, not crossfading. Implement audio crossfade explicitly with volume callbacks: outgoing scene `<Audio volume={(f) => interpolate(f, [0, TRANSITION_FRAMES], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} />`, entering scene with the inverse curve. The pattern is straightforward but must not be omitted, or boundary audio will be perceived as a jarring stack rather than a crossfade.
- **Act-fade overlay vs mid-action frames.** Settle-hold at scene end (FM-4) ensures the outgoing frame is quiescent before the fade overlays. A visual-regression sanity check asserts SSIM ≥ 0.95 between the last 5 frames of scene N and a captured "rest reference" for that scene.
- **ffprobe schema drift across versions.** Pinned ffmpeg ≥5.0 across all platforms; Phase 0 doctor refuses older versions with an actionable error.
- **Locale and time zone.** `LANG=en_US.UTF-8 TZ=UTC` enforced at orchestrator entry. F11 schedule UI shows times in UTC for consistency.
- **PII leakage.** Phase 2 OCR scan over sampled frames blocks commits containing real GitHub URLs, API key shapes, `.env` content. Scan runs in CI as a required check.
- **Cross-scene contamination.** Scene-N+1 captured alone vs. captured after scene-N must produce identical bytes (state-reset-coverage test enforces). New features that introduce state slices add their reset assertion to this test as part of their PR.
- **Scene-manifest drift.** `Composition.tsx` imports each scene from `demo/scenes/index.ts`; renaming a scene file without updating the index is a `tsc` failure, not a runtime mystery.
- **Phase 0 runs alone if Phase 1 stalls.** Phase 0 is independent. If Phase 1 work is paused, the existing monolith keeps producing demos with proper emoji rendering; no regression.
- **Future feature additions.** Adding F16+ becomes one new scene file plus one entry in `Composition.tsx` and one fake-data reset clause. No core-pipeline edits.

## Alternatives considered

### A1 — Status quo

Rejected. The Problem section names the structural blockers; doubling the file without restructuring concentrates demo knowledge in one engineer.

### A2 — Pure Remotion mockups (no real product capture)

Rejected for V1. Linear ships a mockup-based demo successfully, so this isn't impossible — but Kookr's UI changes weekly, and synchronizing a parallel Remotion mockup would create a second-system maintenance burden the team doesn't have. Real product capture stays the source of truth. (If the team grows and a marketing variant becomes worthwhile, this is reconsidered as a separate artifact, not a replacement.)

### A3 — Charm VHS

Disqualified. Terminal-only DSL; no `URL` / `browser` primitive; cannot drive Chromium.

### A4 — Headed Chrome under Xvfb + ffmpeg x11grab

Rejected. The motivating benefit (emoji rendering) is solved by the Phase 0 font fix. Xvfb adds WSL2 socket workarounds, x11grab needs `libx264 -preset ultrafast` to hit 30fps, and you still need ffmpeg or Remotion downstream for compositing. Worse complexity for the same emoji outcome.

### A5 — OBS / Kdenlive manual editing

Rejected for V1. Highest visual ceiling, lowest reproducibility. Conflicts with R2.

### A6 — Multi-scene Playwright + pure ffmpeg compositing (no Remotion)

The previous v1 of this RFC proposed shipping this as a Phase 1 milestone before adding Remotion in Phase 2. Round-1 review correctly identified this as throwaway work. Cut. Phase 1 now ships per-scene capture *and* Remotion compositing in one milestone.

### A7 — Just keep the demo at 90s with 40% coverage

Rejected. The decision space here is whether to grow the demo to match the product or to grow the product faster than the demo. The Why-now subsection prices the cost of inaction; we choose to grow the demo.

## Open questions

- **`@remotion/transitions` vs vanilla `<Sequence>` opacity interpolation.** The Phase 1 Composition uses `<TransitionSeries>` from the transitions package. If the empirical probe shows boundary artifacts even with normalization, fall back to vanilla `<Sequence>` with manual opacity interpolation (5–10 lines per transition). Neither blocks the architecture.
- **Phase 2 render-time floor on a 4-core dev laptop.** Open until measured. Hard checkpoint — Phase 2 does not merge until the measurement is in the RFC.
- **A 60s investor cut as a second `Composition.tsx`.** Out of V1 scope (NG4) but the architecture supports it for free. Open question: does the README need both a 180s and a 60s asset, or is one enough?
- **Demo asset storage.** Whether the rendered MP4 lands in git, git-LFS, or an external CDN. Repo-bloat threshold is unmeasured. Tentative answer: keep MP4 out of git; commit only the SHA-256 reference + a CI artifact upload.

## Critic feedback incorporated

Round 2 (this revision):

- **delivery-pragmatist**: Phase 1 5-day → 7–10 day with feature-flag fallback (`KOOKR_DEMO_PIPELINE=v2`); Phase 2 R8 checkpoint now has explicit else branch (relax to ≤45min, CI canonical, `demo:scene` local); license gate boundary expanded to `demo/`; bless command runs gates internally; macOS runner cost surfaced.
- **failure-mode-analyst**: SHA-256 byte-identity replaced with SSIM + audio-correlation gate (FM-13 — Chromium output is not byte-deterministic); pre-flight TTS pass before any capture (FM-7); deterministic `ffmpeg -ss 0 -t` trim instead of ±100ms band (FM-8); UUID-suffixed CSS class + grep guard (FM-9); split scene manifest from capture functions (FM-10); Playwright `contextOptions.timezoneId/locale` not just env (FM-11); `ls`-based macOS font check (FM-12); end-of-scene settle hold (FM-4); narration source-text scan in addition to OCR (FM-1); store-coverage glob test (FM-6); vp8 boundary mitigation order (FM-3 — try remux + keyframes before re-encode).

Round 1:

- **design-minimalist**: cut Phase 1 ffmpeg merge (throwaway), cut `ChapterIntro.tsx` and `Callout.tsx` as components (CSS injection at capture time), keep Remotion in root package, reduce scene count to 10.
- **ambition-amplifier 2026-05-05**: novel finding — F8 and F10 silently absent from scene list contradicting R1; promote cursor causality highlight from polish to V1; surface authenticity tradeoff of fake-data NG1; document multi-variant outputs as a near-zero V1.5 extension.
- **delivery-pragmatist**: split was unsafe (Phase 1 narrated output would have regressed), now collapsed. Rolled in: license CI gate, scene-contract test, state-reset coverage assertion, version pinning, atomic Phase 0 anchor (not line numbers), CI render budget on real GH Actions specs.
- **failure-mode-analyst**: rolled in PII scan, locale/TZ pinning, fontconfig cache step, ffmpeg-version preflight, sticky duration policy, color-space pin, R2 hash check, scene-manifest drift via `tsc`.
- **socratic-challenger**: added Audience section, "Why now" cost-of-inaction note, explicit phase-cancellation behavior (Phase 0 ships alone), honest naming of throwaway risk in old Phase 1.

**Adversarial pair resolution (design-minimalist + ambition-amplifier):**
On Phase 3, sided with design-minimalist (cut speed ramping and audio ducking — no concrete frame-selection plan, no ambient music exists, chipmunk-audio risk identified by failure-mode-analyst is unmitigated). On cursor causality highlight, sided with ambition-amplifier (this is the product claim made visible — promote to V1, baked into capture via CSS injection rather than Remotion overlay). On scene count, met between (10 scenes) by merging the Operations triplet but keeping F8/F10/F13 visible.

**ambition-amplifier 2026-05-05: novel finding** (per skill log convention).

**Empirical probe (parallel to round 2):** validated the highest-risk unverified architectural claim — Playwright vp8 → Remotion `<OffthreadVideo>` boundary cleanliness. Result: HOLDS (no artifacts) with one corrective finding (audio at boundaries sums, doesn't crossfade — explicit volume callbacks required). Both findings folded into Edge cases.

**Round 3 (not yet run):** would verify the SSIM ≥0.99 threshold is achievable across two consecutive renders on the pinned `macos-14` runner. Tractable but defers to user direction on whether to run round 3 before implementation begins.
