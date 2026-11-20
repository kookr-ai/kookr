#!/usr/bin/env python
"""Voice audition clips, including Kokoro voice blends (a weighted sum of two voice embeddings).
usage: audition.py <outDir> <name> <speed> <soften:0|1> <voice[:weight]> [<voice:weight> ...]
Renders the first three lines of script.json as <outDir>/<name>-<id>.wav. `soften` turns ". " into "... ",
the longer sentence pause Kookr's speech service applies to Kokoro voices."""
import json, os, re, sys
import soundfile as sf
from kokoro_onnx import Kokoro
out, name, speed, soften = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4] == "1"
recipe = [(p.split(":")[0], float(p.split(":")[1]) if ":" in p else 1.0) for p in sys.argv[5:]]
m = os.environ.get("KOKORO_DIR") or sys.exit("Set KOKORO_DIR to the folder holding kokoro-v1.0.int8.onnx and voices-v1.0.bin")
k = Kokoro(f"{m}/kokoro-v1.0.int8.onnx", f"{m}/voices-v1.0.bin")
style = sum(w * k.get_voice_style(v) for v, w in recipe)
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
lines = json.load(open(os.path.join(here, "script.json")))["lines"][:3]
os.makedirs(out, exist_ok=True)
for line in lines:
    i = line["id"]
    text = re.sub(r"\.\s+", "... ", line["text"]) if soften else line["text"]
    # same rule as narrate.py: a British voice (name starting with "b") reads with British pronunciation
    y, sr = k.create(text, voice=style, speed=speed, lang="en-gb" if recipe[0][0].startswith("b") else "en-us")
    sf.write(f"{out}/{name}-{i}.wav", y, sr); print(name, i, round(len(y) / sr, 2), flush=True)
