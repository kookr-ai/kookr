# Example storyboard: the source run's second draft (the build contract)

> This is a real, complete storyboard, kept as an example of the level of detail builders need:
> fixed narration starts, rules for every scene, a table of the demo's real states, and per-scene
> events with times and verbatim text. Write your own for your subject; do not reuse its content.

49 seconds, 1920×1080, 30 fps, 120 BPM (one beat = 0.5 s).
Concept: **"The box never grows."** One real four-line shelf sits in the same rectangle for the
middle of the film. Everything the product does happens to its lines; the rectangle never resizes.

v2 answers the first review round (four simulated viewers, a craft critic, a fact-checker):
the payoff is now shown (Thursday: the test passes), the blank-page beat and the three-word
"Bounded. Voted. Plain text." beat are gone, the demo has fewer and slower votes, every command says
who runs it, the aging tick is explained, small text is bigger, and the four big cuts are louder.
`storyboard-v1.md` is the previous version.

All on-screen terminal text inside the shelf, the strip, the `cat` and the `git diff` is real output
of `nb` 0.10.0 (capture: `demo-film.txt`, the THIRD capture). The failing and passing test lines in
the hook and the payoff are an illustration of the problem, not product output.

## Narration (fixed start times in film seconds; measured clip lengths in brackets)

| id | start | text |
|----|-------|------|
| l01 | 0.25 | Monday, your agent hit a trap. Tuesday. Same trap. [3.29] |
| l03 | 4.30 | Agent notebook gives it a page of lessons. [2.77] |
| l04 | 7.40 | One plain text file. One lesson per line. [2.92] |
| l05 | 10.80 | When a task starts, your harness shows it that file. (ends 13.57) When it ends, the agent votes on what helped. (14.15–16.46) |
| l06 | 17.00 | The file is capped. (ends 18.09) A new lesson always gets in. (18.45–20.00) The lowest score drops out. (20.43–21.86) |
| l07 | 23.80 | Lessons are shown, not searched. [2.03] |
| l08 | 26.10 | Because the one that matters most is the one your agent would never think to search for. [4.91] |
| l09 | 31.30 | And it's plain text. You can read it, fix it, and review every change. [4.31] |
| l10 | 36.30 | It's a store, not a loop. Your harness drives it. [3.09] |
| l12 | 40.30 | Thursday, it reads the note first. [about 2.3] |
| l11 | 44.00 | Agent notebook. Small memory, on purpose. [2.84] |

## Rules that hold in every scene

- **Sound-off first.** The headline text on screen must carry the story with no audio. No subtitle
  band inside the picture; keep everything above y = 1040.
- **Readability (raised in v2: the film is also watched on phones).** Nothing smaller than 36 px.
  Terminal text and anything a viewer must read: at least 44 px. Headlines at least 96 px. At most
  52 characters per terminal line. A line of text stays at least 1.5 s (plus 0.3 s per word beyond
  five); a caption that explains something stays at least 2.0 s. Side margins 120 px, top 80 px.
  (Shared styles were raised to match: eyebrow 36 px, shelf header 36 px, strip 44 px, note 36 px.)
- **Colour means something.** Violet = lesson id. Amber = score. Teal = the tool / accent.
  Green and red only for +1 / −1 votes, pass / fail, and diff lines. Red-pink = full / evicted.
- **Captions are not terminal text.** Anything the film says about the picture (a label, an
  explanation) is set in the sans face as a caption, never in the mono face on a terminal line.
- **Who runs it.** A command never appears behind a bare `$` prompt inside the product demo
  (S3–S5): each strip line starts with a small label chip saying who runs it — `you`, `hook`,
  or `agent` — in place of the prompt.
- **Motion.** Default entrances `expo.out`, 8–12 frames; exits `power3.in`, 5–7 frames; camera
  moves `expo.inOut`, 15–30 frames, no rotation or perspective. Headlines roll in as whole lines in
  a mask. Terminal output prints whole, in one frame; only a typed command is typed.
  **Exception, new in v2: the four big cuts** (reveal 4.0, cap 18.4, "Shown, not searched" 23.8,
  end card 43.8) break those rules on purpose: a hard cut to very large type, a flash frame, a
  large scale punch. Dynamic range is the point: quiet before, loud on the frame, settle fast.
- **When the world moves, everything in the scene moves with it** (headline included), so left
  edges stay aligned. A scene is never left with the shelf alone and no headline for more than 10 frames.
- **No:** particles, glitch, scanlines, neon glow, gradients-as-decoration, emoji, stock imagery,
  a brain or a knowledge-graph picture, competitor names, any statistic or percentage.

## The shelf's real states (third capture)

Shelf header title: `nb show build` (the rows are that command's output). Gauge reads `n / 4`.

| state | rows, top to bottom |
|-------|---------------------|
| **S-three** | `40091e [+1] run the build before the tests` · `844287 [+1] fresh worktree: install deps first` · `6a6223 [+1] release by tag: CI publishes it` |
| **S-full** | S-three + `d385d1 [+1] tests need Docker running` |
| **S-voted** | `40091e [+3]` · `844287 [+1]` · `6a6223 [+1]` · `d385d1 [+0]` (same order, same texts) |
| **S-final** | `40091e [+3] run the build before the tests` · `6a6223 [+1] release by tag: CI publishes it` · `d190af [+1] CI runs macOS too: no GNU-only flags` · `844287 [+0] fresh worktree: install deps first` |

## Scenes

### S1 · Hook · 0.0 – 4.0 (builder A)
Job: the agent repeats yesterday's mistake. No product name, no logo.
- Eyebrow above the day word, from frame 0: `YOUR AI AGENT`. Frame 0 is a complete picture (the
  poster): day word `Monday` (display serif, about 200 px) over the terminal line `$ npm test`,
  three empty tally boxes at the right.
- Failures land at **0.9** (Monday), **2.8** (Tuesday, after the day word rolls at **2.1**) and
  **3.5** (Wednesday, rolls at **3.3**): `✗ tests failed: forgot the build`, each filling a tally box.
  They escalate: shake of 12 / 18 / 26 px decaying over 6 frames, and the terminal panel flashes a
  red-pink fill at 20 / 30 / 45 % decaying over 6 frames. A slow push on the whole world
  (scale 1.00 → 1.03, linear) runs 0.0–3.8.
- Sub line from **2.8**: `Same trap. Every session.`
- **3.8–4.0** inhale: the world scales 1.03 → 0.96 (`power2.in`) and dims to 0.35 opacity; the last
  two frames before 4.0 are bare background.

### S2 · Reveal · 4.0 – 7.0 (builder A)
Job: name the product and say what it is. **First big cut.**
- **4.0** the wordmark `agent-notebook` hard-cuts in, centred on the stage, about 250 px, on the
  first frame of the scene (no roll-in), scaling 1.10 → 1.00 over 8 frames (`expo.out`), with a
  full-frame violet flash (opacity 0.85 → 0 over 5 frames).
- **4.5–5.0** the wordmark moves and scales into its lockup in the top band (left edge x = 260,
  about 150 px). **5.0** sub line rolls in: `A page of lessons for your AI agent.`
- **5.2–5.8** the shelf rectangle draws in at its fixed geometry (outline, then header bar, title
  `nb show build`, gauge). The three rows of **S-three** land one per beat at **5.9 / 6.2 / 6.5**,
  gauge counting `1 / 4`, `2 / 4`, `3 / 4`. End state **S-three**.

### S3 · One lesson = one line · 7.0 – 10.5 (builder A)
Job: what is inside. Starts in **S-three**, gauge `3 / 4`, shelf identical to the end of S2.
- Headline at 7.0: eyebrow `WHAT IT IS`, line `One text file.`, sub line `One lesson = one line.`
- Strip (label chip `you`): `nb add build "tests need Docker running"` typed **7.6–8.7**; Enter
  **8.8**; output `added — 4 lines` prints at 8.9; the lesson lifts from the strip into slot 4 as row
  `d385d1 [+1]` (lands **9.2**). Gauge becomes `4 / 4 full` (red-pink) at 9.2. End state **S-full**.
- The typed command stays visible until the row has left the strip (v1 made it vanish and fade back).

### S4 · Shown at the start, voted at the end · 10.5 – 17.0 (builder A)
Job: the loop, and that the harness drives it. Starts in **S-full**.
- **10.5** eyebrow `TASK START · YOUR HARNESS RUNS`, headline `Shown to the agent.`
  Strip (label chip `hook`): `nb list` prints at **11.0**, is replaced by `nb show build` at **11.7**.
  Rows light top to bottom at 12.0 / 12.2 / 12.4 / 12.6 (teal border sweep), then settle.
- **13.7** eyebrow becomes `TASK END · THE AGENT VOTES`, headline `Voted on what helped.`
  Three votes only, each readable (strip label chip `agent`):
  **14.3** `nb vote build 40091e +1` → row `40091e` `[+1]→[+2]` (a green `+1` flies into the chip, chip overshoots);
  **14.9** same command again → `[+2]→[+3]`;
  **15.7** `nb vote build d385d1 -1` → a red `−1` hits row `d385d1`: `[+1]→[+0]`, border red-pink.
  The command line changes at the same frame as the vote it shows.
  A push toward the score column (up to 1.15) is welcome only if the headline moves with the world.
  End state **S-voted**. Camera back to 1.0 by 16.9.

### S5 · The cap (hero moment) · 17.0 – 23.5 (builder A)
Job: bounded; a new lesson always gets in; the lowest score leaves. Starts in **S-voted**.
- **17.0** headline `The file is capped.`; gauge `4 / 4 full` pulses on beats 17.0–18.0. A caption
  near the gauge for the whole scene: `4 lines in this demo. 50 by default.`
- Strip (label chip `agent`): `nb add build "CI runs macOS too: no GNU-only flags"` typed
  **17.1–18.1** (fast). Stillness 18.1–18.4.
- **18.4 Enter: second big cut.** An off-white full-frame flash (opacity 0.30 → 0 in 3 frames); the
  world punches to 1.12 and settles in 10 frames; vertical shake −24 / +12 / −6 / +3 px; the gauge
  scales 1 → 1.7 → 1 over 12 frames. The typed lesson lifts out of the strip as a full-width
  row-shaped card (`d190af  [+1]  CI runs macOS too: no GNU-only flags`), travelling up 110 px in 4
  frames (`power4.out`) to press against the bottom edge of the shelf, just outside the rectangle
  under slot 4. It waits there, nudging up 8 px on the beats at 18.9, 19.4 and 19.9 (the shelf does
  not give). Gauge stays `4 / 4 full`. Headline at 18.4: `New lesson in.`
- **20.4** sub line `Lowest score out.` Row `d385d1 [+0]` first pulls back 32 px to the left with a
  red-pink fill (4 frames, 20.27–20.40), then leaves to the right (20.40–20.60, `power3.in`,
  stretched slightly along x), whole and readable until it is gone; a smaller world punch (1.05).
- **20.7–21.1** the waiting card slides up into slot 4: row `d190af [+1]`.
- **21.6** the strip prints the real output on two lines, `added — 4 lines` /
  `(evicted lowest-scored: [+0] tests need Docker running)`, and at the same frame the aging tick
  happens: row `844287` ticks `[+1]→[+0]` and moves down to slot 4 while `6a6223` and `d190af` step
  up to slots 2 and 3 (rows cross without cutting through each other's text: fade the moving row to
  0.6 or lift it in z). A caption (sans, not terminal type) beside row `844287`, held to the end of
  the scene: `unused the longest: −1`. End state **S-final**.
- Row `40091e [+3]` and the shelf rectangle get no tween of their own in this scene.

### S6 · Shown, not searched · 23.5 – 31.0 (builder B)
Job: the difference from search-based memory. Starts and stays in **S-final**.
- **23.8 third big cut:** the shelf drops to 0.18 opacity (23.5–23.7) and the headline
  `Shown, not searched.` hard-cuts in centred at about 1.9× its lockup size; at **24.8** a thick
  strike (16 px, 6 frames, `power4.out`) crosses `searched`; **25.3–25.9** the headline travels
  back to its lockup (top band, left edge x = 260) and the shelf returns to full opacity.
- **26.1** under the shelf (strip position) a search field appears: a rounded input with a magnifier,
  the placeholder `search…` and a caret; nothing is ever typed. Caption beside it:
  `A search finds only what you think to ask.`
- **27.9** all four rows light up; row `40091e` (run the build before the tests — the lesson that
  answers the hook's trap) gets a teal marker and the caption `the one it would never have searched for`.
- **29.3 / 29.7 / 30.1** three plain tags cut in on beats: `no embeddings`, `no vector DB`,
  `no network call` (each at least 44 px; the last one is on screen 0.9 s).

### S7 · Plain text · 31.0 – 36.0 (builder B)
Job: you can read it and review every change. At **31.0** the world wipes to warm paper. The shelf
rectangle stays exactly where it is and becomes a sheet of paper.
- **31.1** headline (ink) `It's a plain text file.`, sub line `Read it. Fix it. Review every change.`
- **31.4** the raw file prints whole, header `$ cat build.md` (this IS the file, so the bare prompt
  is right here): `# desc: build, test and release gotchas` / `+1  release by tag: CI publishes it` /
  `+3  run the build before the tests` / `+1  CI runs macOS too: no GNU-only flags` /
  `+0  fresh worktree: install deps first`.
- **33.1** the content cuts to the real `git diff` (header `$ git diff`), a fast cascade (40 ms apart):
  `-+1 fresh worktree: install deps first`, ` +1 release by tag: CI publishes it`,
  ` +3 run the build before the tests`, `-+0 tests need Docker running`,
  `++1 CI runs macOS too: no GNU-only flags`, `++0 fresh worktree: install deps first`.
  Three captions with leader lines, appearing at 33.5 / 33.8 / 34.1 and held to the end:
  `evicted` at the `-+0 tests need Docker running` line; `new lesson` at the `++1 CI runs…` line;
  `unused the longest: −1` bracketing the two `fresh worktree` lines.
- Footnote, at least 36 px: `git versioning is an optional setup`.

### S8 · A store, not a loop · 36.0 – 40.0 (builder B)
Job: honesty about what it is. Back to the dark world at **36.0**.
- Three cards in a row at 36.3 / 36.6 / 36.9: `① Retrieve` + `nb list · nb show`, `② Agent works`,
  `③ Reflect` + `nb vote · nb add`, joined by arrows, inside one dashed outline labelled
  `YOUR HARNESS · Claude Code, Codex CLI, or your own loop`. Below, the notebook as a small block
  connected to cards ① and ③. Nothing in this scene may be smaller than 36 px: if the shrunken shelf
  cannot keep its row text at that size, draw the notebook as a simple labelled block
  (`build · 4 lessons`, with four bars for lines) instead of a scaled-down shelf.
- Headline `A store, not a loop.` (36.2); sub line `Your harness drives it.` (37.8).
- **38.3** a caption at the bottom, at least 40 px, fully gone by 39.95:
  `Large-scale retrieval? Use a real vector store.`

### S10 · Payoff · 40.0 – 43.5 (builder B)  — new in v2
Job: close the loop the hook opened. The hook's layout returns (build it to match S1: same day-word
size and position, same terminal panel, same tally boxes; read `scenes-a.js` for the geometry).
- **40.0** eyebrow `YOUR AI AGENT`, day word `Thursday`; the tally shows the three red-pink `✗`
  boxes from the hook and a fourth, empty box.
- **40.4** above the terminal panel, one shelf row slides in as the note being read:
  `40091e  [+3]  run the build before the tests` (teal border). Sub line: `Reads the note first.`
- **41.0–41.8** the terminal types `$ npm run build && npm test`.
- **42.1** `✓ tests passed` in green; the fourth tally box turns green with a `✓`; a light world
  punch (1.04). Hold to 43.5.

### S9 · End card · 43.5 – 49.0 (builder B)
Job: name, tagline, how to get it. **Fourth big cut.**
- **43.5–43.8** the payoff picture clears (fast fade or wipe; nothing from S8 or S10 may remain).
- **43.8** the mark and wordmark `agent-notebook` hard-cut in (scale 1.08 → 1.00 over 8 frames).
- **44.6** tagline in the display serif, about 110 px: `Small memory, on purpose.`
- **45.6** the install line in a terminal-style pill: `$ npm install -g agent-notebook`
- **45.9** `then wire your harness: examples/` and, smaller, `reference hooks for Claude Code`;
  `github.com/<owner>/agent-notebook`; `MIT · zero dependencies · Node.js 18+`. Nothing under 36 px.
- From **46.2 to 49.0 nothing moves** (static end card, never fades to black).

## Sound events (for the mix; builders do not produce audio)

ticks at 0.9 / 2.8 / 3.5 (growing) · riser 3.0→4.0, impact 4.0 · stamps 5.9 / 6.2 / 6.5 · keys
7.6–8.7, enter 8.8, stamp 9.2 · ticks 12.0–12.6 · vote chimes 14.3, 14.9 (rising), falling 15.7 ·
keys 17.1–18.1, impact 18.4 · nudges 18.9 / 19.4 / 19.9 · evict 20.4 · stamp 21.1 · tick 21.6 ·
impact 23.8, whoosh 24.8 · pops 29.3 / 29.7 / 30.1 · whoosh 31.0 · stamp 33.1 · whoosh 36.0 ·
ticks 36.3 / 36.6 / 36.9 · keys 41.0–41.8, vote chime + shimmer 42.1 · impact 43.8 · pop 45.6.
Music: thin 0–4, full 4–17, tension 17–18.1, silence 18.1–18.4, full 18.4–23.5, lighter 23.5–31,
warm and thin 31–36, building 36–40, bright 40–43.5, resolved 43.5–48, last second quiet.
