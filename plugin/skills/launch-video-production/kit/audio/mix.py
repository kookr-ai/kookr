#!/usr/bin/env python
"""Mix narration + synthesized music bed + SFX into a loudness-normalised master.

usage (needs a Python with numpy, scipy and soundfile, and ffmpeg on PATH):
    python mix.py <timeline.json> <narrationDir> <outBase>

Writes <outBase>.wav (48 kHz stereo 16-bit), <outBase>.mp3 (128 kbps), <outBase>.report.json and
<outBase>.stems/{voice,music,sfx}.wav (pre-master, float) and <outBase>.stems/limited.wav (the
master before loudness normalization). Timeline contract: see README.md.

Signal flow:  voice ──────────────────────────────┐
              bed -> sidechain duck (voice env) ──┼─> sum -> soft limiter -> loudnorm 2-pass -> wav/mp3
              sfx (gain, pan, time) ──────────────┘
"""
import inspect
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import maximum_filter1d

import synth

SR = synth.SR
TARGET_LUFS = -16.0
TARGET_TP = -1.7  # internal margin; the requirement is <= -1.5
# Bed's nominal level is already tuned in synth.py; music.gain_db is relative to that.


def db(x):
    return 20 * math.log10(max(x, 1e-12))


def lin(d):
    return 10 ** (d / 20)


def rms(x):
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0


class TimelineError(Exception):
    pass


# ---------------------------------------------------------------- narration

def load_narration(timeline, narration_dir, n_total):
    """Place each clip at its start on a mono-in-stereo voice track. Validates overlap and overrun."""
    voice = np.zeros((n_total, 2))
    clips = []
    for item in timeline.get("narration", []):
        path = os.path.join(narration_dir, item["id"] + ".wav")
        if not os.path.exists(path):
            raise TimelineError(f"narration clip not found: {path}")
        x, rate = sf.read(path, dtype="float64", always_2d=True)
        x = x.mean(axis=1)
        if rate != SR:
            g = math.gcd(SR, rate)
            x = signal.resample_poly(x, SR // g, rate // g)
        start = float(item["start"])
        end = start + len(x) / SR
        if start < 0:
            raise TimelineError(f"narration '{item['id']}' starts before 0 ({start}s)")
        if end > timeline["duration"] + 1e-9:
            raise TimelineError(f"narration '{item['id']}' ends at {end:.3f}s, past duration {timeline['duration']}s")
        clips.append(dict(id=item["id"], start=start, end=end, samples=x * lin(item.get("gain_db", 0))))
    clips.sort(key=lambda c: c["start"])
    for a, b in zip(clips, clips[1:]):
        if b["start"] < a["end"]:
            raise TimelineError(f"narration clips overlap: '{a['id']}' ends {a['end']:.3f}s but '{b['id']}' starts {b['start']:.3f}s")
    for c in clips:
        s = int(round(c["start"] * SR))
        voice[s:s + len(c["samples"]), :] += c["samples"][:, None]
    return voice, [dict(id=c["id"], start=round(c["start"], 3), end=round(c["end"], 3)) for c in clips]


# ---------------------------------------------------------------- ducking

CONTROL_RATE = 1000  # Hz; the duck envelope is computed at 1 ms resolution, then interpolated


def voice_activity(voice, thr_db=-50.0, win_ms=20):
    """Boolean per control-frame: is narration audible? (short-time RMS above threshold)."""
    mono = voice.mean(axis=1)
    hop = SR // CONTROL_RATE
    w = int(SR * win_ms / 1000)
    pw = np.convolve(mono ** 2, np.ones(w) / w, mode="same")
    return np.sqrt(pw[::hop]) > lin(thr_db)


def duck_gain(voice, n, duck_db, attack=0.08, release=0.35, hold_ms=150, lookahead_ms=40):
    """Sidechain gain for the music, per sample. Follows the narration envelope:
    - gaps shorter than `hold_ms` stay ducked (no pumping between words)
    - the target leads the voice by `lookahead_ms` so the 80 ms attack is finished when speech lands
    - one-pole smoothing with separate attack (going down) and release (coming back) times."""
    act = voice_activity(voice).astype(np.float64)
    act = maximum_filter1d(act, size=hold_ms)
    la = lookahead_ms
    target = np.concatenate([act[la:], np.zeros(la)])
    a_att = 1 - math.exp(-1 / (attack * CONTROL_RATE))
    a_rel = 1 - math.exp(-1 / (release * CONTROL_RATE))
    d = np.zeros(len(target))
    cur = 0.0
    for i, tgt in enumerate(target):
        cur += (a_att if tgt > cur else a_rel) * (tgt - cur)
        d[i] = cur
    t_ctrl = np.arange(len(d)) / CONTROL_RATE
    d_s = np.interp(np.arange(n) / SR, t_ctrl, d)
    return 10 ** (-duck_db * d_s / 20)


# ---------------------------------------------------------------- sfx

def render_sfx(timeline, n_total):
    out = np.zeros((n_total, 2))
    base_seed = int(timeline.get("seed", 0))
    for i, ev in enumerate(timeline.get("sfx", [])):
        fn = synth.SFX.get(ev["type"])
        if fn is None:
            raise TimelineError(f"unknown sfx type '{ev['type']}' (known: {', '.join(synth.SFX)})")
        args = dict(ev.get("args") or {})
        if "seed" in inspect.signature(fn).parameters:
            args.setdefault("seed", base_seed + i)  # each event differs, but reproducibly
        buf = synth._pan(fn(**args).astype(np.float64), ev.get("pan", 0.0)) * lin(ev.get("gain_db", 0))
        s = int(round(ev["t"] * SR))
        if s < 0:
            raise TimelineError(f"sfx '{ev['type']}' at t={ev['t']} is before 0")
        e = min(s + len(buf), n_total)
        if s < n_total:
            out[s:e] += buf[:e - s]
    return out


# ---------------------------------------------------------------- master

def soft_limit(x, knee=0.5, ceiling=0.78):
    """Gentle limiter: transparent below `knee`, tanh-rounded approach to `ceiling` above it."""
    a = np.abs(x)
    over = a > knee
    y = a.copy()
    y[over] = knee + (ceiling - knee) * np.tanh((a[over] - knee) / (ceiling - knee))
    return np.sign(x) * y


def integrated_lufs(x):
    """BS.1770 integrated loudness (K-weighting, 400 ms blocks, -70 LUFS / -10 LU gates) at 48 kHz.
    Used only to pre-scale the mix near the target; ffmpeg's loudnorm does the exact final pass."""
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]
    k = signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=0), axis=0)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    ms = np.array([np.mean(k[i:i + blk] ** 2, axis=0).sum() for i in range(0, max(len(k) - blk, 1), hop)])
    lk = -0.691 + 10 * np.log10(np.maximum(ms, 1e-12))
    keep = lk > -70
    rel = -0.691 + 10 * np.log10(np.mean(ms[keep])) - 10
    keep &= lk > rel
    return -0.691 + 10 * np.log10(np.mean(ms[keep]))


def ffmpeg(*args):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + r.stderr[-800:])
    return r.stderr


def loudnorm_measure(path, extra=""):
    """Run ffmpeg loudnorm in analysis mode and return its JSON stats (floats)."""
    err = ffmpeg("-i", path, "-af", f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA=11{extra}:print_format=json", "-f", "null", "-")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    return {k: float(v) if re.fullmatch(r"-?[\d.]+|-inf", v) else v for k, v in json.loads(m.group(0)).items()}


def master(mix, out_wav, tmpdir):
    """Pre-scale to ~-16 LUFS, soft-limit, then ffmpeg two-pass loudnorm to the final 16-bit wav.
    (Speech has a high peak-to-loudness ratio; limiting before loudnorm keeps its own limiter idle.)"""
    # The limiter removes a little energy, so re-aim twice: after limiting, loudnorm only has to make a
    # tiny linear correction and never needs to push peaks past the true-peak ceiling.
    gain = TARGET_LUFS - integrated_lufs(mix)
    for _ in range(3):
        limited = soft_limit(mix * lin(gain))
        gain += TARGET_LUFS - integrated_lufs(limited)
    lim = os.path.join(tmpdir, "limited.wav")
    for _ in range(2):
        limited = soft_limit(mix * lin(gain))
        sf.write(lim, limited.astype(np.float32), SR, subtype="FLOAT")
        m = loudnorm_measure(lim)  # ffmpeg's own reading differs slightly from integrated_lufs()
        if abs(m["input_i"] - TARGET_LUFS) < 0.1:
            break
        gain += TARGET_LUFS - m["input_i"]
    af = (f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
          f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    ffmpeg("-i", lim, "-af", af, "-ar", str(SR), "-c:a", "pcm_s16le", out_wav)


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    tl_path, narr_dir, base = sys.argv[1:]
    try:
        run(tl_path, narr_dir, base)
    except TimelineError as e:
        sys.exit(f"mix.py: error: {e}")


def run(tl_path, narr_dir, base):
    timeline = json.load(open(tl_path))
    duration = float(timeline["duration"])
    n = int(round(duration * SR))
    os.makedirs(os.path.dirname(os.path.abspath(base)), exist_ok=True)
    stems_dir = base + ".stems"
    os.makedirs(stems_dir, exist_ok=True)

    voice, clips = load_narration(timeline, narr_dir, n)

    m = timeline.get("music", {})
    music = synth.bed(duration, timeline["bpm"], m.get("sections", []), timeline.get("seed", 0)).astype(np.float64)
    music *= lin(m.get("gain_db", -14))
    music *= duck_gain(voice, n, float(m.get("duck_db", 9)))[:, None]

    sfx = render_sfx(timeline, n)

    for name, stem in (("voice", voice), ("music", music), ("sfx", sfx)):
        sf.write(os.path.join(stems_dir, name + ".wav"), stem.astype(np.float32), SR, subtype="FLOAT")

    wav = base + ".wav"
    master(voice + music + sfx, wav, stems_dir)
    ffmpeg("-i", wav, "-c:a", "libmp3lame", "-b:a", "128k", base + ".mp3")

    # ---- report (measured on the final file where possible)
    final, _ = sf.read(wav, dtype="float64", always_2d=True)
    stats = loudnorm_measure(wav)
    active = np.repeat(voice_activity(voice), SR // CONTROL_RATE)[:n]
    active = np.pad(active, (0, n - len(active)))
    vm = voice.mean(axis=1)
    mm = music.mean(axis=1)
    ratio = db(rms(vm[active])) - db(rms(mm[active])) if active.any() else None
    report = dict(
        duration=round(len(final) / SR, 3),
        integrated_lufs=stats["input_i"],
        true_peak_dbtp=stats["input_tp"],
        loudness_range_lu=stats["input_lra"],
        stem_rms_db={k: round(db(rms(v)), 2) for k, v in (("voice", voice), ("music", music), ("sfx", sfx))},
        voice_to_music_db=None if ratio is None else round(ratio, 2),
        clipped_samples=int(np.sum(np.abs(final) >= 1.0)),
        narration=clips,
    )
    json.dump(report, open(base + ".report.json", "w"), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
