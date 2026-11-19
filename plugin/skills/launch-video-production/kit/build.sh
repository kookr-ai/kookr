#!/usr/bin/env bash
# Full build: narration -> mix -> frames -> video -> contact sheets.
# usage: ./build.sh [all|audio|frames|video|sheet]   (default all)
# Environment, all optional (defaults in brackets):
#   PY      a Python with numpy, scipy, soundfile and kokoro_onnx [python3]
#   VOICE   narrator voice [am_michael]      SPEED  narration speed [1.08]
#   SHARDS  parallel frame-render processes [6]
#   FPS     frames per second [30]           OUT    name of the clip, out/<OUT>.mp4 [film]
# Narration also needs KOKORO_DIR (see audio/narrate.py).
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}
VOICE=${VOICE:-am_michael}
SPEED=${SPEED:-1.08}
SHARDS=${SHARDS:-6}
FPS=${FPS:-30}
OUT=${OUT:-film}
step=${1:-all}

audio() {
  # Narration is slow, so it is recorded again only when the voice, the speed or the script changed.
  local stamp
  stamp="$VOICE $SPEED $(cksum < script.json)"
  if [ ! -f out/vo/durations.json ] || [ "$(cat out/vo/.stamp 2>/dev/null)" != "$stamp" ]; then
    "$PY" audio/narrate.py script.json out/vo "$VOICE" "$SPEED"
    printf '%s\n' "$stamp" > out/vo/.stamp
  else
    echo "narration: reusing out/vo (voice, speed and script unchanged)"
  fi
  "$PY" audio/make-timeline.py
  "$PY" audio/mix.py audio/timeline.json out/vo out/mix
}

frames() {
  mkdir -p out/frames
  find out/frames -name 'f*.png' -delete
  local dur i from to failed=0 pids=()
  dur=$("$PY" -c "import json;print(json.load(open('audio/timeline.json'))['duration'])")
  for i in $(seq 0 $((SHARDS - 1))); do
    from=$("$PY" -c "print(round($dur*$i/$SHARDS*$FPS)/$FPS)")
    to=$("$PY" -c "print(round($dur*($i+1)/$SHARDS*$FPS)/$FPS)")
    node render.mjs film.html out/frames "$FPS" "$from" "$to" > "out/frames.$i.log" 2>&1 &
    pids+=($!)
  done
  for i in "${pids[@]}"; do wait "$i" || failed=1; done
  cat out/frames.*.log
  if [ "$failed" -ne 0 ]; then echo "frames: a render shard failed (see the log above)" >&2; return 1; fi
  echo "frames: $(find out/frames -name 'f*.png' | wc -l | tr -d ' ') written"
}

video() {
  ffmpeg -y -loglevel error -framerate "$FPS" -start_number 0 -i out/frames/f%05d.png -i out/mix.wav \
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k -shortest "out/$OUT.mp4"
  ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of compact "out/$OUT.mp4"
}

sheet() {
  # One still per second, 24 per sheet (6 x 4), each stamped with its time: out/contact-sheet-01.png, -02, ...
  # One ffmpeg run per sheet, so the sheet count follows the film's length.
  local total per=24 sheets i first last
  total=0
  if [ -d out/frames ]; then total=$(find out/frames -name 'f*.png' | wc -l | tr -d ' '); fi
  if [ "$total" -eq 0 ]; then echo "sheet: no frames in out/frames; run ./build.sh frames first" >&2; return 1; fi
  sheets=$(( (total + per * FPS - 1) / (per * FPS) ))
  find out -maxdepth 1 -name 'contact-sheet-*.png' -delete
  for i in $(seq 1 "$sheets"); do
    first=$(( (i - 1) * per * FPS )); last=$(( i * per * FPS ))
    ffmpeg -y -loglevel error -framerate "$FPS" -start_number 0 -i out/frames/f%05d.png \
      -vf "select='not(mod(n\,$FPS))*gte(n\,$first)*lt(n\,$last)',scale=640:-1,drawtext=text='%{eif\:t\:d}s':x=12:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.7,tile=6x4" \
      -frames:v 1 "$(printf 'out/contact-sheet-%02d.png' "$i")"
  done
  echo "sheet: $sheets contact sheet(s) written"
}

case "$step" in
  all) audio; frames; video; sheet ;;
  audio|frames|video|sheet) "$step" ;;
  *) echo "unknown step $step"; exit 2 ;;
esac
