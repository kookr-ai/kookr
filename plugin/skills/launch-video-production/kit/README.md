# Film kit

Copy this folder into a working folder inside a fresh worktree of the target repository
(for example `media/<film-name>/`), then build the film there. Everything runs locally.

## What each file is

| File | What it does |
|---|---|
| `film.html` | The film page: a 1920×1080 stage, playback controls, the audio element. Loads the files below. |
| `film.css` | Design tokens, the stage, the scene base. Replace the tokens with the subject's identity; add shared picture elements. |
| `engine.js` | The timeline engine. `FILM.scene(id, start, end, build)` registers a scene; `FILM.seek(t)` is the only way time advances. |
| `player.js` | Live playback: the audio element is the clock. Does nothing in render mode (`?render=1`). |
| `captions.example.js` | The verbatim caption track shown under the picture. Copy to `captions.js` and fill from the script. |
| `render.mjs` | Frame grabber: steps `film.seek(t)` in headless Chromium and writes PNGs. |
| `build.sh` | Narration → mix → frames (parallel shards) → video → contact sheet. |
| `build-artifact.mjs` | Packs the film and its soundtrack into one self-contained review page from a template. |
| `storyboard.example.md` | The source run's second storyboard, as a filled-in example of the build contract. |
| `lib/fonts.example.css` | `@font-face` rules pointing at local font files, so rendering never needs the network. |
| `audio/` | Narrator, voice auditions, music and effects synthesizer, mixer, measurement checks. See `audio/README.md`. |

You add: `lib/gsap.min.js` (GSAP 3, one file), the font files named in `lib/fonts.css`,
`components.js` (elements shared by several scenes, with their geometry fixed in one place),
one `scenes-<x>.js` and `scenes-<x>.css` per builder, `script.json`, `storyboard.md`, and a
development page per builder (a copy of `film.html` that loads only that builder's files).

## The rule every scene obeys

The page's state is a pure function of time. `FILM.seek(t)` may be called for any `t`, in any
order, and must always produce the same picture.

- Animate with tweens on the scene's timeline (time 0 is the scene's start), the helpers in
  `engine.js` (`h.type`, `h.count`, `h.swapText`, `h.classAt`, `h.split`, `h.el`), and
  `FILM.hooks.push(fn(t))` for anything computed from `t` (a blinking caret, a decaying shake).
- No CSS animations or transitions, no timers, no `requestAnimationFrame`, no randomness at render
  time, no `onComplete` / `onStart` / `call()` side effects: they do not replay when seeking backwards.
- When one property of one element is tweened more than once, every tween after the first is a
  `fromTo` with `immediateRender: false`.
- `film.seek` returns nothing on purpose. A function called across the automation bridge that
  returns the timeline object hangs the frame grabber.

## Commands

```sh
# stills at exact times (fast; use these to look at your work)
AT=0,0.9,2.1 node render.mjs film.html out/stills

# a burst at 10 fps between two times, to judge motion
node render.mjs film.html out/burst 10 21.8 23.2

# narration, then the mix (needs KOKORO_DIR and a Python with kokoro_onnx, numpy, scipy, soundfile)
PY=python3 KOKORO_DIR=/path/to/model ./build.sh audio

# all frames in 8 parallel shards, then the video and a contact sheet
SHARDS=8 ./build.sh frames && OUT=my-film ./build.sh video && ./build.sh sheet

# the playable review page
OUT=my-film node build-artifact.mjs page.html out/artifact/my-film.html
```

`render.mjs` needs `playwright-core` and a headless Chromium that are already installed: set
`PLAYWRIGHT_CORE` to an installed copy's folder if it is not resolvable from the current directory,
and `CHROME_BIN` if the browser is not in Playwright's cache. It never installs a browser.

## The review page template

`build-artifact.mjs` fills a template you write (`page.html`; `page.example.html` is the source run's) with: `/*FILM_CSS*/`, `/*FILM_JS*/`,
`{{AUDIO:path}}`, `{{IMG:path}}`, `{{TEXT:path}}`, `{{MP4_MB}}`. The template must contain the
same element ids as `film.html` (`frame`, `stage`, `caption`, `controls`, `play`, `scrub`, `clock`,
`cc`, `audio`) and load GSAP from a script host the viewer allows, before the inlined film script.
Put the player first, then: what nobody has checked (the sound), voice auditions, the idea, the
script, storyboard stills, directions considered, what the panel changed, what the reviewers said
and what changed, and the decisions that belong to the operator.
