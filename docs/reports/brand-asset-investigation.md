# Brand Asset Investigation — Issue #40

Status: Recommendation accepted, partial integration shipped in this report's PR.
Date: 2026-05-06

## Asset inventory

`assets/branding/` contains two source files committed without prior cleanup:

| Property | `kookr-ai-logo.png` | `kookr-ai-logo-animated.mp4` |
| --- | --- | --- |
| Actual format | **JPEG** (filename misleadingly says `.png`) | MP4, H.264 High@L3 + AAC stereo |
| Dimensions | 784×1168 (portrait) | 448×672 (portrait), 24 fps, 145 frames |
| File size | 124 KB | 1.2 MB (video 1.5 Mbit/s, audio 124 kbit/s) |
| Background | Off-white (RGB ~250–252), **no transparency** | Off-white (~250), **no transparency** |
| Audio track | n/a | **Yes — AAC stereo, 48 kHz, 6.0 s** (must be stripped before any product use) |
| Content bbox | ~600×614 (near-square subject inside vertical whitespace padding) | ~347×355 (same near-square subject inside whitespace padding) |

Two structural issues to flag:

1. The static asset is a JPEG with a `.png` extension. Anything that loads it as a PNG today is silently relying on the browser's content sniffing rather than the file extension. Renaming to `.jpg` or re-exporting as a true PNG is part of the cleanup below.
2. Both source files are visually portrait (2:3) but the actual logo subject is roughly square. Trimming the whitespace recovers ~25% of canvas area for free and avoids awkward layouts in any UI placement.

## Recommendations

### Static logo: integrate, restrained

The static logo is appropriate for restrained brand placement in three spots:

- **Browser favicon and app icon** — the obvious win. Tabs are unbranded today.
- **Top-bar wordmark** — pair an 18 px brand glyph with the existing `KOOKR` text wordmark. No layout shift, no animation, identity at a glance.
- **README hero** — a small (~96 px) brand mark above the H1. At the time of this report, the README already had a hero demo animation; the brand mark sat above it without competing.

These are all integrated in this PR.

### Animated logo: do **not** integrate in V1

The `docs/architecture.md` "operational dashboard" framing and the issue's own design constraints ("Avoid prominent hero/marketing treatment inside the app") rule out an animated brand inside the dashboard. Specific reasons to skip the animated MP4 for now:

- **Audio track present.** Cannot be used as-is.
- **Operational dashboard tone.** A 6-second branded animation competes with task status, terminal output, and findings — exactly what the issue warns against.
- **README already has motion.** The hero already included a demo animation and a 76-second narrated demo link. A second animated asset above the demo would dilute attention from the demo, which carries more product information.
- **Bundle/runtime cost.** Even at 1.1 MB muted, this is more weight than a static dashboard should ship for cosmetic motion.

A muted derivative is produced (see below) so a future use case (e.g., a dedicated landing page outside the dashboard) can adopt it without re-processing.

## Derivatives produced in this PR

All derivatives live under `assets/branding/derived/` (single source of truth). Originals are kept untouched in `assets/branding/`.

| File | Purpose | Size |
| --- | --- | --- |
| `kookr-ai-logo-trimmed.png` | Square (1168×1168), trimmed, transparent — high-fidelity master for re-deriving sized variants | 360 KB |
| `kookr-ai-logo-{32,64,128}.png` | Pre-rendered transparent variants — 32/64 power favicons + the in-app top-bar glyph; 128 is the README hero | 2 KB → 21 KB |
| `favicon.ico` | Multi-size ICO (16/32/48/64) | 14 KB |

Larger sized PNGs (256, 512) and a muted MP4 derivative were prototyped during the investigation but dropped from the committed set per YAGNI — they had no current consumer and the muted derivative is one `ffmpeg -an -c:v copy` away from the source MP4 if a future surface needs it.

The derivatives are produced by alpha-keying near-white pixels (luminance ≥ 248 → fully transparent, ≤ 230 → fully opaque, soft ramp in between) after content-bbox cropping with 4 % padding. The exact script is recorded in this PR's commit message; re-running is straightforward if the source assets are ever updated.

### Why `src/frontend/public/` symlinks instead of duplicates

Vite serves only files under its configured `publicDir` (defaults to `<root>/public` = `src/frontend/public/`) at runtime, so the favicon and top-bar glyph must be reachable from there. To avoid hand-synced copies (CLAUDE.md drift discipline: a symlink beats "remember to copy X to Y"), `src/frontend/public/{favicon.ico,kookr-mark-32.png,kookr-mark-64.png}` are **symlinks** into `assets/branding/derived/`. Vite follows them at build time and emits real files into `dist/frontend/`, so production output is unaffected. Editing the source updates both surfaces with no manual sync. Linux + macOS support — same platform constraint as the rest of Kookr.

## Accessibility & performance constraints applied

- Top-bar `<img>` is marked `alt="" aria-hidden="true"` because the adjacent `KOOKR` wordmark is the textual identity. The image is decorative and screen readers should skip it.
- `pointer-events: none` and `user-select: none` on the glyph — no accidental drag/select; clicks pass through to the existing layout container.
- `flex-shrink: 0` on the glyph and a fixed 18 px size — no layout shift on theme switch, font-size change, or compact mode.
- No animation, no opacity transitions, no JavaScript involvement. Light- and dark-theme compatible (the asset has transparent background; it renders correctly on either).
- No bundle change beyond the three small static files in `public/` (~23 KB combined).

## Follow-up notes (not in this PR)

- **Source file convention.** `kookr-ai-logo.png` is actually a JPEG. Rename to `.jpg` or re-encode to true PNG in a future cleanup. Left untouched here to avoid breaking any external link that already points at the current path.
- **SVG master.** No vector source exists. If the brand evolves, commissioning an SVG master would let us drop the multi-size raster derivatives and ship a single ~5 KB asset.
- **Animated asset placements.** If a future landing page or marketing surface materializes outside the dashboard, the muted MP4 derivative is ready for use. Until then, do not wire it into the operational dashboard.
- **Mobile/responsive verification.** The README and dashboard use the brand mark at small fixed sizes (96 px in README, 18 px in TopBar). No responsive concerns at these dimensions, but if larger placements are ever attempted, viewport testing is required.
