# Briefs

Templates for every agent in the run. Replace the `<ANGLE_BRACKET>` placeholders. Each brief is
self-contained on purpose: the agent that receives it knows nothing else.

Three habits apply to all of them:

- **Fixed answer shape.** Number the deliverables. Answers in the same shape can be compared.
- **Full answer to a file, short answer back.** Ask for the full text in a file outside the
  repository and a capped summary (300-450 words) in the reply. The files feed the review page.
- **Name the source of truth.** Point at the facts pack by absolute path and forbid reading a
  checkout that may be stale.

## Shared opening for round one (the blind panel)

> You are `<ROLE DESCRIPTION, WITH THE EXPERIENCE THAT MAKES THE ROLE CREDIBLE>`. You are one of
> several experts being consulted independently and blind to each other; give YOUR view, do not hedge
> toward a consensus.
>
> THE JOB: we are producing a 30-60 second launch video (motion graphics + one narrator voice-over +
> music and effects) announcing `<PRODUCT>`: what it is, how it works, how it differs from other
> approaches, and why use it.
>
> SOURCE OF TRUTH: read `<FACTS_PACK>` (the product's documentation verbatim, plus real captured
> output). Do not read `<STALE_CHECKOUT>`. Every claim you propose must trace to the facts pack.
> Limits the product states about itself: `<LIMITS>`. Compare against categories of solution; do not
> name competitor products.
>
> DELIVER, in exactly this shape: `<NUMBERED LIST FOR THE ROLE, BELOW>`
>
> Write the full answer to `<OUT_DIR>/<role>.md`, then return a compact version of the same points in
> at most `<N>` words, no preamble. Do not edit any file in any git repository.

### Positioning strategist

1. Audience: the single primary viewer, and the moment in their week this should hit.
2. One-line promise the viewer can repeat afterwards (14 words at most).
3. Hook (seconds 0-3): what is on screen and what is spoken; best and one alternate.
4. Claims: at most three, ranked, each with the facts-pack line it rests on.
5. Positioning against each alternative category, one sentence each, worded so an expert would not scoff.
6. Call to action: the last four seconds, on screen and spoken.
7. One thing to cut.
8. Risks: up to three ways the video backfires with this audience, and the guard for each.
9. Distribution: where it will be watched, and what that implies for length, aspect ratio and sound-off viewing.

### Domain expert

1. The mechanism in one breath (35 words at most).
2. The real differentiator (not just "simpler"), why it matters, and the lines behind it.
3. A comparison table against the alternative categories.
4. Honest limits the video must not hide or contradict (four at most), each with its source.
5. Claims an expert would scoff at (four at most), each with a safe rewording.
6. Hook (seconds 0-3) from the expert's angle.
7. The one visual that makes the mechanism click in under six seconds: what moves.
8. One thing to cut.

### Scriptwriter for the ear

State the voice constraints in the brief: a synthetic narrator; 105-130 spoken words; symbols and
commands on screen, not spoken; avoid words a speech engine garbles.

1. Three scripts from different angles (for example: the pain story, the contrarian claim, the
   mechanism demo). Each as numbered lines: spoken text, the on-screen event it lands on, word count.
2. Your pick, and why, in two sentences.
3. Hook (seconds 0-3) of the pick.
4. The line people will repeat, and where it sits.
5. A caption version for sound-off viewing, seven words per caption at most.
6. One thing to cut from a typical launch script.
7. Pronunciation notes for the synthetic voice.

### Motion director

State the production constraints in the brief: one HTML page at 1920×1080, 30 fps, one paused
timeline stepped frame by frame (DOM, CSS, inline SVG, canvas; no footage, no 3D, no stock
imagery); the fonts available; the brand colours and what each means; synthesized sound; watched
mostly in a README and on social feeds, often muted.

1. Concept in two sentences, and the one recurring motif.
2. Two alternative concepts, one line each, and why they rank lower.
3. Storyboard: six to nine shots, each with time range, layout, what moves and how, the transition out, and on-screen text verbatim.
4. Hook: the first three seconds frame by frame.
5. The hero moment, precise enough for a developer to build.
6. Motion language: easing, durations, how text enters and leaves, camera moves, what never moves.
7. Sound map: per shot, the effect or musical event; tempo and character of the bed.
8. Sound-off plan.
9. One thing to cut.

### Skeptical practitioner

Cast someone in the target audience who is tired of the product category and already has a
home-made answer to the problem.

1. First reaction, verbatim, in the first five seconds.
2. Top five objections, ranked. For each: the objection, the honest answer the facts pack supports
   (quote the line), and a verdict: ANSWERED, PARTLY, NOT ANSWERED.
3. What would make you try it tonight.
4. What would make you close the tab (five concrete phrases, visuals or claims).
5. The hook that would stop your scroll.
6. Claims you would accept, at most three, in your wording.
7. One thing to cut.
8. The proof you want on screen, and for how long.

### Retention editor

1. Target length and why.
2. Beat sheet: start-end seconds, the beat's job, its single idea, maximum words on screen; mark the pattern interrupts.
3. Hook, and the thing that must NOT be in the first three seconds.
4. Readability rules: minimum font size, maximum characters per terminal line, minimum dwell per line, safe margins.
5. Captions: burned in or not, where, how many words, style.
6. Audio mix: loudness target, music level under voice, ducking, where silence lands, how many effects.
7. Pacing of the demo: typing speed, what to pre-fill, what to highlight.
8. End card: what stays, for how long.
9. Formats: which aspect ratios, and what changes for a square or vertical cut.
10. One thing to cut.

## Audio engineer (one agent, parallel with the builders)

Only needed when the kit's `audio/` tools must be changed or rebuilt. The brief that produced them
asked for: a synthesizer library (music bed driven by sections of energy 0..1, on a beat grid; a
named set of effects), a mixer that reads a fixed timeline contract and writes a wav, an mp3, stems
and a measurement report, and a numeric quality bar reported as PASS/FAIL: zero clipped samples,
true peak, integrated loudness, voice-to-music ratio while speaking, no clicks at section
boundaries, onsets on the beat grid, every pitch in one scale, determinism for a fixed seed. Ask it
to render a spectrogram and look at it for full-height vertical lines (clicks) and a solid block
above 10 kHz (hiss).

## Scene builder

> You are a motion designer-developer building scenes `<Sx-Sy>` (`<FROM>`-`<TO>` s) of a
> `<DURATION>`-second film. Another builder is doing the other scenes in separate files; do not touch
> them. You can see images: render stills of your work and LOOK at them, and iterate until it looks
> like a professionally designed film, not a slideshow.
>
> WORKING DIRECTORY: `<WORKDIR>`. Do not run git commit, push, checkout, stash or reset, and edit no
> file other than the two you own: `<scenes-x.js>` and `<scenes-x.css>` (prefix every CSS class with `<x->`).
>
> READ FIRST: `storyboard.md` (the build contract: event times are binding to within one frame,
> because the sound is mixed against them independently), `engine.js`, `components.js`, `film.css`,
> the real capture file, your development page, `render.mjs`.
>
> THE ONE HARD RULE: the film is rendered by seeking, not by playing, so the page must be a pure
> function of time. Only tweens on the scene timeline, the provided helpers, and `FILM.hooks` for
> things computed from t. No CSS animations or transitions, no timers, no randomness at render time,
> no `onComplete`/`onStart`/`call()` side effects. When one property of one element is tweened more
> than once, every tween after the first is a `fromTo` with `immediateRender: false`.
>
> RENDER AND LOOK: `AT=0,0.9,2.1 node render.mjs <page> out/stills` renders stills at exact times;
> `node render.mjs <page> out/burst 10 21.8 23.2` renders a short burst. Always run with a timeout.
>
> QUALITY BAR, each reported PASS/FAIL from rendered stills: every event at its stated time (a still
> just before and just after); text verbatim, terminal text matching the capture; nothing
> overlapping, clipped or under the minimum size; the shared element pixel-identical at every scene
> boundary; the big cuts are strong pictures on their own frame; composition; seek-safety (forwards,
> backwards and shuffled renders of the same time are identical).
>
> If a storyboard instruction cannot work visually, build the closest thing that honours its intent
> and report the deviation with the reason. Final answer: the PASS/FAIL list, every deviation, the
> paths of eight stills to look at, and anything the other builder or the sound mix needs to know.

For a revision round, resume the same agent with a message that lists what changed and **why**
(which reviewers, in what words), restates that every time is restated in the new storyboard, and
names the defects that must not recur.

## Round two: simulated viewer

> Role-play one specific viewer and report honestly what that person would think. You are `<PERSONA:
> job, what they already use, what they have never heard of>`. You watch a `<N>`-second launch video
> for a product you have never heard of, `<SOUND ON | SOUND OFF on a phone, about 400 px wide>`, `<WHERE>`.
>
> You cannot play video, so you are given timed stills. Read, in order: `<SHEETS>` (a grid of one
> frame per second, time stamped) `<and, sound-on viewers only, the narration cue sheet>`. Full-size
> frames are at `<FRAMES>/fNNNNN.png` (seconds × 30). Look at no other file and do not look up the
> product: you know only what the video shows and says.
>
> Answer in exactly this shape: (1) in one sentence, what does this do and who is it for; (2) the
> second you would stop watching, and why; (3) three things you liked, with the second; (4) three
> things you disliked or that confused you, with the second; (5) what you wanted to see and did not;
> (6) a claim you would challenge; (7) how it differs from what you already use, in your words;
> (8) would you try it: yes, maybe or no, and the single change that would move you one step up;
> (9) scores 1-10 for clarity, credibility, energy and craft; (10) the one edit you would make.

Give the muted phone viewer the pictures only, and ask additionally which text was unreadable at
phone size and what was understood scene by scene. Give a newcomer persona a rule not to use
knowledge that person would not have, and ask which words and pictures they did not understand.

## Round two: craft critic

Give it the operator's brief in the operator's own words, the contact sheets, the narration, the
full frames and the storyboard (for intent only). Ask it to read consecutive frames around the key
moments, and to answer with: a two-sentence verdict; scores; flat moments with a fix each; whether
each big cut actually lands and exactly what would make it bigger; the top five changes ranked by
impact per effort, each with element, property, from and to values, duration in frames, and easing;
three things to keep; every visible defect with its frame number. State the constraints it must
respect, so that "more exciting" does not come back as particles and glow.

## Round two: fact-checker

> List every claim the film makes: every spoken sentence, headline, label, terminal command and
> output line, number, and anything the PICTURE implies without words (the order of rows, what
> happens when an action lands, a diagram of who runs what). For each, a verdict against `<FACTS_PACK>`
> only: SUPPORTED (quote the line and its number), SUPPORTED WITH A CAVEAT (what is omitted, and
> whether an on-screen qualifier covers it), NOT SUPPORTED, or ILLUSTRATION. Check terminal text
> character for character against the capture, and that the sequence of states shown is one the real
> product produces. Check the stated limits are not contradicted. Check the end card. Return: the
> must-fix list with the smallest change that makes each true, the should-qualify list with a
> qualifier of eight words at most, what a skeptic could call misleading, and one line on whether it
> is publishable from a factual standpoint.
