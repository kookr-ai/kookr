# Launch-film audio toolchain

All audio is synthesized locally (numpy/scipy). No samples, no network.
Needs a Python with numpy, scipy and soundfile (plus `kokoro_onnx` for narration) and ffmpeg on PATH.
Narration reads the Kokoro model from the folder named by `KOKORO_DIR`.

## Files
- `narrate.py`  Kokoro narration: `script.json` -> `<id>.wav` (24 kHz mono) + `durations.json`.
- `audition.py` Short voice audition clips, including blends of two voices.
- `make-timeline.example.py`  The source run's cue sheet generator: copy to `make-timeline.py`,
                keep its helpers, replace its times with your storyboard's.
- `synth.py`    Library: `bed(duration, bpm, sections, seed)` music bed (A minor, Am-F-C-G5, 2 bars
                each), 13 SFX functions (`synth.SFX` registry), `reverb()` helper. 48 kHz stereo float32.
- `mix.py`      CLI mixer: narration + bed + SFX, sidechain ducking, soft limiter, ffmpeg loudnorm.
- `verify.py`   Numerical quality checks (PASS/FAIL table) of a finished mix's report and stems, then of
                the synthesizer. Its last check times a fixed 46 s mix and needs two short clips
                named `d01.wav` and `d02.wav` in the narration folder; without them it is skipped.
- `demo-timeline.json`  20 s example using every SFX and three energy sections.

## Timeline contract (extra keys ignored)
```json
{"duration": 46.0, "bpm": 100, "seed": 7,
 "narration": [{"id": "l01", "start": 0.40, "gain_db": 0}],
 "sfx": [{"type": "impact", "t": 3.0, "gain_db": -6, "pan": 0.0, "args": {"duration": 0.8}}],
 "music": {"gain_db": -14, "duck_db": 9,
           "sections": [{"from": 0, "to": 5, "energy": 0.3}, {"from": 5, "to": 40, "energy": 0.8}]}}
```
Energy: 0 pad only (quiet) / 0.3 + sparse pluck / 0.6 + bass pulse / 1.0 + kick and hats.
Time outside any section is energy 0. t=0 is a downbeat; keep section edges on beats (60/bpm s).
SFX `args` go to the function (`whoosh`: duration, direction "up"|"down"; `impact`, `riser`,
`shimmer`: duration; `vote_up`: step 0..3, which lifts the chime so a run of votes climbs). Without `args.seed`, each event gets `seed + its index`.

## Commands
Run from the film folder (the one that holds `audio/`). `build.sh audio` runs the first three.
```
PY=python3; export KOKORO_DIR=/path/to/kokoro-model-folder
$PY audio/narrate.py script.json out/vo am_michael 1.08
$PY audio/make-timeline.py                                  # writes audio/timeline.json
$PY audio/mix.py audio/timeline.json out/vo out/mix         # -> out/mix.{wav,mp3,report.json,stems/}
$PY audio/verify.py out/mix out/vo
$PY audio/audition.py out/audition george 1.0 0 bm_george   # first three script lines in another voice
$PY audio/audition.py out/audition blend 1.0 0 af_heart:0.5 af_sky:0.5        # ... or in a blend of two
VOICE=af_heart:0.5+af_sky:0.5 ./build.sh audio             # the whole narration in that blend
ffmpeg -i out/mix.wav -lavfi showspectrumpic=s=1400x600:legend=1 out/mix-spectrum.png
```
mix.py exits with an error if narration clips overlap or run past `duration`.
