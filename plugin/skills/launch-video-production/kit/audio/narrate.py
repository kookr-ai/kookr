#!/usr/bin/env python
"""Local narration with Kokoro-82M (ONNX). No network call: the model is read from the folder
named by KOKORO_DIR.

usage: narrate.py <script.json> <outDir> [voice=am_michael] [speed=1.0]
       voice may be a blend of voices with weights, joined by "+": af_heart:0.5+af_sky:0.5

script.json: {"lines": [{"id": "l01", "text": "..."}, ...]}
Writes <outDir>/<id>.wav (24 kHz mono) and <outDir>/durations.json ({id: seconds}).
"text" is what the voice says; write numbers and symbols the way they should be spoken.
"""
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_DIR = os.environ.get("KOKORO_DIR", "")
if not MODEL_DIR:
    sys.exit("Set KOKORO_DIR to the folder holding kokoro-v1.0.int8.onnx and voices-v1.0.bin")


def main() -> None:
    script, out = sys.argv[1], sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) > 3 else "am_michael"
    speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    os.makedirs(out, exist_ok=True)
    kokoro = Kokoro(f"{MODEL_DIR}/kokoro-v1.0.int8.onnx", f"{MODEL_DIR}/voices-v1.0.bin")
    lang = "en-gb" if voice.startswith("b") else "en-us"
    if "+" in voice or ":" in voice:
        # A blend, as auditioned with audition.py: "af_heart:0.5+af_sky:0.5". A weighted sum of two
        # voice embeddings is a new voice; the first voice named decides the pronunciation above.
        recipe = [(part.split(":")[0], float(part.split(":")[1]) if ":" in part else 1.0) for part in voice.split("+")]
        voice = sum(weight * kokoro.get_voice_style(name) for name, weight in recipe)
    durations = {}
    for line in json.load(open(script))["lines"]:
        samples, rate = kokoro.create(line["text"], voice=voice, speed=speed, lang=lang)
        sf.write(os.path.join(out, line["id"] + ".wav"), samples, rate)
        durations[line["id"]] = round(len(samples) / rate, 3)
        print(f'{line["id"]}  {durations[line["id"]]:6.2f}s  {line["text"]}', flush=True)
    durations["_total"] = round(sum(durations.values()), 3)
    json.dump(durations, open(os.path.join(out, "durations.json"), "w"), indent=1)
    print(f'total speech {durations["_total"]}s  voice={sys.argv[3] if len(sys.argv) > 3 else "am_michael"} speed={speed}')


if __name__ == "__main__":
    main()
