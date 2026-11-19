---
name: launch-video-production
group: communication
description: >
  Produce a short narrated motion-graphics film (30-60 seconds: a product launch, a feature
  announcement, an explainer) entirely on the local machine, with a fleet of agents: a blind expert
  panel shapes the message, a timed storyboard becomes the build contract, scene builders animate
  HTML pages that are rendered frame by frame, narration is synthesized locally, music and effects
  are synthesized, and simulated viewers plus a fact-checker review the rendered frames before a
  second draft. Use when asked for a launch video, product teaser, motion render, animated explainer
  or video tutorial with voice-over. Ships a reusable kit (timeline engine, frame grabber, narrator,
  music and effects synthesizer, mixer, review-page builder). Do NOT use for editing existing footage,
  for screen recordings, or for a static diagram.
keywords: >
  launch video, product video, teaser, motion graphics, motion render, animated explainer, video
  tutorial, voice-over, narration, text to speech, Kokoro, storyboard, script, GSAP, headless
  Chromium, frame rendering, ffmpeg, music synthesis, sound effects, audio mix, simulated viewers,
  expert panel, fact check, contact sheet, artifact, README video
related: adversarial-swarm-analysis, agent-fleet-orchestration, ui-mockup-variants, clear-technical-writing, asking-the-operator
---

# Launch video production

How to make a short narrated film about a product with a fleet of agents, from a blank page to a
reviewed second draft the operator can play. It was distilled from one full run (a 49-second launch
film for a command-line tool); `references/lessons.md` holds what that run got wrong first.

The method rests on four decisions. Keep them even if you change everything else.

1. **The film is a web page whose picture is a pure function of time.** One paused animation
   timeline is stepped frame by frame in a headless browser to make the video, and the same page is
   played live, with the soundtrack as its clock, as the reviewable draft. Nothing is recorded in
   real time, so every frame is reproducible and any single frame can be rendered alone for review.
2. **A timed storyboard is the contract between agents.** It fixes each narration start and each
   picture event to the second. Picture, sound and captions are then built independently against
   those times and still line up.
3. **Opinions are gathered blind, and reviews are run on the thing itself.** Experts are consulted
   separately, before any concept exists, in a fixed answer shape. Reviewers get the rendered frames
   and the narration, never the rationale.
4. **No agent can hear.** Sound is verified by measurement only, and the operator is told plainly
   that nobody has listened to it.

## Before you start

Check the machine once. Stop and tell the operator if a row is missing: every later step depends
on these.

| Need | Check | Used for |
|---|---|---|
| ffmpeg and ffprobe | `ffmpeg -version` | muxing, loudness, contact sheets |
| Node.js 18+ | `node -v` | frame grabber, page builder |
| A headless Chromium and `playwright-core` | `ls ~/.cache/ms-playwright` (Linux) or `ls ~/Library/Caches/ms-playwright` (macOS); find a `playwright-core` in a nearby `node_modules` | frame capture. Reuse an installed browser; do not run `playwright install` on a shared host |
| A local text-to-speech voice | for Kokoro: the ONNX model files and a Python environment with `kokoro_onnx` and `soundfile` | narration. Prefer a local engine: a cloud voice sends the script to a third party |
| Python with numpy, scipy, soundfile | `python3 -c "import numpy, scipy, soundfile"` | music, effects, mix |

Copy `kit/` from this skill into a working folder inside a fresh worktree of the target repository
(for example `media/<film-name>/`). `kit/README.md` lists every file and command. Nothing in the
kit is committed or pushed until the operator has approved a direction.

## The run, in order

Do the steps in this order. The first two are yours; they are short and everything else leans on them.

### 1. Prove the render path (10 minutes, alone)

Before any agent is spawned, render two seconds of a trivial page and one narrated line into a
clip: `render.mjs` → `narrate.py` → `ffmpeg`. If this fails, the cause is the environment (browser
path, fonts, the voice model) and no amount of creative work fixes it.

### 2. Write a facts pack

Put, in one file outside the repository: the product's own documentation verbatim (from the current
remote branch, not a possibly stale checkout), and **real captured output** of the product doing
what the film will show. Every brief points at this file. Rules that follow from it:

- Every spoken or on-screen claim must trace to a line in the pack.
- Terminal text on screen is copied from a real capture, character for character. If the real
  output is too wide or too busy to read on screen, **re-record a simpler real run**; never edit or
  truncate the capture.
- Write down the product's own stated limits. The film must not contradict them.

### 3. Round one: a blind expert panel (parallel)

Spawn about six agents at once, each with one role, the facts pack, and a fixed answer shape.
They do not see each other's answers or any idea of yours. Roles that earned their place:

| Role | What it settles |
|---|---|
| Positioning strategist | the one viewer, the one-line promise, the call to action |
| Domain expert | the real differentiator, honest limits, phrasings an expert would scoff at |
| Scriptwriter for the ear | three scripts from different angles, the quotable line, pronunciation notes |
| Motion director | the visual concept and its recurring motif, a shot list, the motion rules |
| Skeptical practitioner | the objections, what would make them close the tab, what proof they want |
| Retention editor | length, a beat sheet, minimum text sizes, captions, the audio mix targets |

Ask every role for the same four things first — a hook for seconds 0-3, at most three claims, one
thing to cut, risks — then its specialty. Have each write its full answer to a file and return a
short version. `references/briefs.md` has the briefs.

Then synthesize yourself. Where the panel disagrees, decide, and record the disagreement: the
operator will want to see it.

### 4. Lock the audio before the picture

1. Write the script: 105-130 spoken words for 45-50 seconds. Commands, symbols and numbers stay on
   screen and out of the narrator's mouth.
2. Record each line as its own clip (`narrate.py`) and read the measured durations.
3. Find the pauses inside the long lines (`ffmpeg -af silencedetect`). Picture hits belong on the
   start of a sentence, in the pause before it, not in the middle of one.
4. Fix a start time for every line. Those times, plus the pauses, are what the storyboard is built on.

Record two or three alternative voices of the first lines as audition clips: the operator chooses
by ear, and it costs seconds.

### 5. Write the storyboard as a build contract

One file, read by every builder. It contains: the narration table with start times; rules that hold
in every scene (minimum text sizes, what each colour means, motion defaults, what never moves, what
is forbidden); a table of the exact states the demo passes through; and, per scene, its time range,
its job in one line, every event with its time, and the on-screen text verbatim. Mark which builder
owns which scene. `kit/storyboard.example.md` is a filled-in example.

Two rules that paid for themselves: **sound-off first** (the headline text alone must carry the
story) and **dynamic range** (name the three or four cuts that are allowed to be loud, and keep
everything else quiet so they land).

### 6. Build the picture (parallel)

Write the shared pieces yourself first: design tokens, and any element that appears in more than
one scene, with its geometry fixed in one place. Then give each builder a disjoint set of scenes,
its own two files (`scenes-a.js`, `scenes-a.css`) and its own development page, so a mistake in one
half cannot break the other. Split the film in two or three; more builders means more seams.

Each builder must render stills of its own work and look at them, and must prove **seek-safety**:
the same frame rendered after seeking forwards, backwards and in shuffled order is identical. The
rules that make that true are in `kit/README.md` and in the builder brief.

### 7. Build the sound (parallel with step 6)

`audio/make-timeline.py` (your copy of `audio/make-timeline.example.py`) holds the storyboard's times as a cue sheet; `audio/mix.py` places the
narration, synthesizes the music bed and effects (`audio/synth.py`), ducks the music under the
voice, and normalizes loudness. Read the report it writes and check: duration equals the film's,
integrated loudness within 0.7 of −16 LUFS, no clipped samples, voice 15-20 dB above the music
while speaking, no two narration clips overlapping.

### 8. Assemble and publish draft one

`build.sh` renders all frames in parallel shards, muxes the video and writes contact sheets (one
still per second, 24 per sheet).
`build-artifact.mjs` packs the same film into one self-contained page that plays live, from a template
you write (`kit/page.example.html` is the source run's). Open that
page in the headless browser once and confirm: no console errors, the audio element loads, pressing
play advances both the audio and the picture, no horizontal scroll at phone width.

Publish it for the operator now, before the review round, with: the player, the voice auditions,
the script, the storyboard stills, the directions you considered, what the panel changed, and a
section that says **nobody has listened to it**. Then keep going; do not wait for an answer.

### 9. Round two: review the rendered cut (parallel)

Reviewers cannot play video. Give them the contact sheets `build.sh sheet` wrote (one frame per
second, time stamped), the narration with its times, and the path to every full-size frame. Spawn at once:

- **Four or five simulated viewers** who know nothing about the product: a skeptic in the target
  audience, a likely adopter, a newcomer to the whole field, and one on a phone with the sound off
  (who must not be given the narration). Ask each: in one sentence, what does this do and who is it
  for; at what second would you stop watching; what you liked, disliked, wanted to see; scores.
- **A craft critic** who reads consecutive frames around the key moments and must answer with
  implementable changes (element, property, values, frames).
- **A fact-checker** who lists every claim, spoken, written or implied by the picture, and traces
  each to the facts pack.

A mismatch between a viewer's one sentence and the promise you intended is a defect. A request made
independently by most viewers is the next draft's first change.

### 10. Draft two

Write storyboard v2 with a short note of what changed and why, keep v1, and resume the same builders
with a message (they keep their context). Rebuild the sound against the new times, render, check the
page again, and publish to the same link. Report to the operator what the reviewers said, what
changed, and what was raised and deliberately not changed.

### 11. Stop at the operator's decisions

These are theirs, and the work is not delivered until they are made: the voice; the length; whether
the film's source and the clip enter the repository; other aspect ratios. Until then nothing is
committed, pushed or merged. If the operator is away, ask once with `asking-the-operator` and carry
on with whatever does not depend on the answer.

## What to tell the operator, every time

- The link to the playable draft and the path of the rendered clip.
- That the sound was measured, not heard, and the measured numbers.
- That the viewers are role-played, not real people.
- Which real captures the on-screen text came from, and what is illustration rather than product output.
- What the reviewers asked for that you did not do, and why.

## Cost and size

The source run used fifteen agents: six experts, one audio engineer, two scene builders (each
resumed once), four viewers, one critic and one fact-checker (run a second time on draft two). The builders were by far the most
expensive (several hundred thousand tokens each over two rounds) because they look at their own
frames; the experts and viewers were small. Frame rendering took about two minutes for the first draft's 1,440 frames
in eight shards on a busy machine. Do not add agents to this roster without a reason: a seventh
expert adds little, and a third builder adds a seam.
