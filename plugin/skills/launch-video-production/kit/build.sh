#!/usr/bin/env bash
# Full build: narration -> mix -> frames -> video -> contact sheet.
# usage: ./build.sh [all|audio|frames|video|sheet]   (default all)
# env: PY=<python> KOKORO_DIR=<model folder> SHARDS=6 VOICE=am_michael SPEED=1.08 OUT=film
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}   # a Python with numpy, scipy, soundfile and kokoro_onnx; VOICE=${VOICE:-am_michael}; SPEED=${SPEED:-1.08}; SHARDS=${SHARDS:-6}; FPS=30
step=${1:-all}

audio() {
  [ -f out/vo/durations.json ] || "$PY" audio/narrate.py script.json out/vo "$VOICE" "$SPEED"
  python3 audio/make-timeline.py
  "$PY" audio/mix.py audio/timeline.json out/vo out/mix
}
frames() {
  mkdir -p out/frames; find out/frames -name 'f*.png' -delete
  local dur; dur=$(python3 -c "import json;print(json.load(open('audio/timeline.json'))['duration'])")
  local pids=()
  for i in $(seq 0 $((SHARDS - 1))); do
    from=$(python3 -c "print(round($dur*$i/$SHARDS*$FPS)/$FPS)"); to=$(python3 -c "print(round($dur*($i+1)/$SHARDS*$FPS)/$FPS)")
    node render.mjs film.html out/frames $FPS "$from" "$to" > "out/frames.$i.log" 2>&1 & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  cat out/frames.*.log; ls out/frames | wc -l
}
video() {
  ffmpeg -y -loglevel error -framerate $FPS -start_number 0 -i out/frames/f%05d.png -i out/mix.wav \
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k -shortest out/${OUT:-film}.mp4
  ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of compact out/${OUT:-film}.mp4
}
sheet() {  # one still every 2 s, 6 per row, each stamped with its time
  ffmpeg -y -loglevel error -framerate $FPS -start_number 0 -i out/frames/f%05d.png \
    -vf "select='not(mod(n\,60))',scale=640:-1,drawtext=text='%{eif\:t\:d}s':x=12:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.7,tile=6x4" \
    -frames:v 1 out/contact-sheet.png
}
case "$step" in all) audio; frames; video; sheet ;; audio|frames|video|sheet) "$step" ;; *) echo "unknown step $step"; exit 2 ;; esac
