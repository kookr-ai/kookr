# Lessons from the source run

What went wrong, or nearly did, the first time this process was run, and the rule each one became.
Read the section for the step you are on.

## Rendering

- **A seek function that returns the timeline hangs the frame grabber.** `page.evaluate(t =>
  timeline.time(t))` returns the timeline object; the browser bridge then tries to serialize a huge
  circular structure and never comes back. Wrap the body in braces so it returns nothing. The kit's
  `film.seek` already does.
- **Vendor the fonts for rendering.** The render page loads fonts from local files so a frame never
  depends on the network. The review page loads the same families from the font host its viewer allows.
- **Glyphs outside the fonts fall back silently.** Check marks, crosses and circled digits were not
  in the display or mono faces; draw them as inline SVG. A mono face with ligatures merges `++` in a
  diff: turn ligatures off on terminal text.
- **`will-change` and tween order can make a frame depend on render order.** One builder's frames
  differed by a pixel between forward and backward renders until `will-change` was switched off in
  its scenes and its transforms were computed from `t` in a hook. Ask every builder for the
  forwards/backwards/shuffled comparison; "byte-identical" is achievable.
- **The last frame.** A scene visible while `start <= t < end` disappears at exactly `t = duration`.
  The engine clamps the seek just below the end.
- **Contact-sheet timestamps.** After an ffmpeg `select` filter the frame counter `n` restarts, so
  a stamp written from `n` reads 0 on every tile. Stamp from `t`.
- **Do not install or kill browsers on a shared machine.** Reuse an installed headless Chromium by
  path. Never stop render processes with a pattern kill: it matches your own shell and other tasks' browsers.

## Script and voice

- **Measure, then place.** Narration clips came out about 4 % longer than estimated from a slower
  take. Record at the final speed before fixing any start time.
- **Hits belong on sentence starts.** The first cut put its biggest hit in the middle of a spoken
  sentence, and the critic saw it from the cue sheet alone. `silencedetect` gives the pause before
  each sentence; put the hit there.
- **Write for the engine.** "Read it" can come out as "red it": write "you can read it". Keep
  commands, flags, symbols and version numbers on screen.
- **A voice has a pace.** The same synthetic voice at 0.88 and at 1.08 speed sounds like two
  different narrators, and the slower one adds about a fifth to the film's length. When the operator
  names a voice they already use elsewhere, find the exact settings (speed, pause handling), render
  an audition with them, and say what that pace does to the length.
- **Voice blends are cheap auditions.** With an embedding-based engine a weighted mix of two voices
  is a new voice; offer one or two blends beside the stock voices.

## Sound

- **Start the music lower than feels right, then raise it by measurement.** A bed at −15 dB sat
  24 dB under the voice, which is inaudible; −9 dB gave 17 dB, inside the 15-20 dB target.
- **A run of identical chimes is noise.** Let repeated events climb in pitch within the key.
- **Typing sounds are texture.** Sparse (about eleven clicks a second) and very quiet, or leave them out.
- **Leave half a second of silence before the biggest hit**, and the last second of the film quiet.

## Honesty

- **No invented numbers.** A script line with "twenty minutes, gone" came from an illustrative
  diagram, not a measurement. It was cut. If the documentation has no outcome data, the film claims none.
- **The picture makes claims too.** The fact-checker passed every spoken sentence and failed four
  things in the picture: the order of actions did not match the capture a later shot was taken from;
  a caption was set in terminal type on an output line, so it read as tool output; an output line
  appeared before its effect; a window was titled as the raw file while showing a formatted listing.
  Captions are set in the text face; terminal lines contain only what the tool printed.
- **Say who runs each command.** A bare `$` prompt under "your harness runs" confused two viewers.
  Tag each command with who runs it.
- **Show real states.** If the real tool changes something the story would rather skip, show it
  with a caption that explains it, or re-record a run where it is simpler. Do not draw a state the
  tool does not produce.
- **Label the demo's settings.** A demo run with a tiny limit so it fits on screen needs that said
  on screen.

## What viewers asked for

Four role-played viewers, separately, asked for the same things. Assume the next audience will too.

- **Show the cure, not only the pain.** The first cut showed the problem three times and never
  showed it solved. Every viewer asked for the payoff; it became a three-second closing scene that
  mirrors the opening.
- **Energy needs dynamic range.** A precise, tasteful cut scored 4-5 of 10 for energy: one layout
  and one headline size for most of its length, and hits of a few percent. The fix was three or four
  cuts that break the film's own motion rules on purpose (a hard cut to very large type, a flash
  frame, a large punch), with quiet around them.
- **Cut the adjectives.** Three words describing the product read as launch filler to two viewers.
  A real command on screen held them.
- **One table is not a film.** The same element on screen for twenty seconds reads as static on a
  phone, even when its contents change. Vary scale and framing.
- **Text sizes are set for a phone.** At 1920×1080, 30 px text is about 6 px on a phone. The floor
  that survived review was 36 px for anything and 44 px for anything that must be read.
- **Undefined jargon ends attention.** Name a concrete example the first time a term of art
  appears on screen.

## Working with the fleet

- **Publish the first draft before the review round.** The operator can react (a voice, a
  direction) while reviewers work, and often does.
- **Resume builders; do not respawn them.** A builder resumed with a message keeps its mental model
  of its own code. Tell it what changed and why, and which defects must not recur.
- **Back up each draft's scene files, storyboard and clip** before a revision round.
- **A change to the contract mid-build goes to the builder and to the storyboard at once**, never
  to one of them.
- **Keep the hold visible.** Source in a worktree, nothing committed or pushed, until the operator
  approves a direction: a rendered clip in the repository's history is their call.
