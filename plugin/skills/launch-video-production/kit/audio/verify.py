#!/usr/bin/env python
"""Numerical quality checks for synth.py / mix.py. Prints a PASS/FAIL table.

usage: python audio/verify.py <mixBase> <narrationDir>
   e.g. python audio/verify.py out/mix out/vo

Checks the report and stems of a finished mix (<mixBase>.report.json, <mixBase>.stems/), then the
synthesizer itself. The last check times a fixed 46 s mix and needs two short clips named d01.wav
and d02.wav in <narrationDir>; it is skipped, with a printed reason, when they are not there.
"""
import json, os, resource, subprocess, sys, tempfile, time
import numpy as np, soundfile as sf
from scipy import signal
import synth
SR = synth.SR


def check(name, ok, val):
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {val}", flush=True)


base, narr = sys.argv[1], sys.argv[2]
rep = json.load(open(base + ".report.json"))
check("no clipped samples", rep["clipped_samples"] == 0, rep["clipped_samples"])
check("true peak <= -1.5 dBTP", rep["true_peak_dbtp"] <= -1.5, rep["true_peak_dbtp"])
check("integrated -16 +-0.7 LUFS", abs(rep["integrated_lufs"] + 16) <= 0.7, rep["integrated_lufs"])
check("voice/music >= 12 dB (active)", rep["voice_to_music_db"] >= 12, rep["voice_to_music_db"])

# ---- bed under a multi-section arrangement
secs = [{"from": 0, "to": 5, "energy": 0.3}, {"from": 5, "to": 15, "energy": 0.8}, {"from": 15, "to": 25, "energy": 1.0},
        {"from": 25, "to": 32, "energy": 0.0}, {"from": 32, "to": 40, "energy": 0.6}]
b = synth.bed(46, 100, secs, 7)
jump = np.abs(np.diff(b, axis=0)).max() / np.abs(b).max()
check("bed max step < 0.2 of peak", jump < 0.2, round(float(jump), 4))
check("bed ends at zero", float(np.abs(b[-1]).max()) < 1e-4 and float(np.abs(b[0]).max()) < 1e-3, [float(np.abs(b[0]).max()), float(np.abs(b[-1]).max())])
worst = max(float(np.abs(fn()[[0, -1]]).max()) for fn in synth.SFX.values())
check("every SFX starts/ends within 1e-3 of 0", worst < 1e-3, worst)
check("determinism: same seed -> identical bytes", b.tobytes() == synth.bed(46, 100, secs, 7).tobytes(), "identical")
check("different seed differs", b.tobytes() != synth.bed(46, 100, secs, 8).tobytes(), "differs")

# ---- beat alignment on solo layers, several tempi
for bpm in (100, 93, 128):
    L, _ = synth.bed_layers(30, bpm, [{"from": 0, "to": 30, "energy": 1.0}], 7)
    worst_ms = 0
    for layer, first, step in (("bass", 1, 1), ("kick", 2, 2)):
        x = np.abs(L[layer]).max(axis=1)
        env = np.convolve(x, np.ones(48) / 48, mode="same")  # 1 ms smoothing
        beat = 60 / bpm
        for k in range(first, int(28 / beat), step):
            t0 = int(round(k * beat * SR))
            lo = t0 - 480                                   # window starts 10 ms before the grid point
            w = env[lo:t0 + 1920]
            # onset = first point where the 1 ms envelope has risen 10% of the way from its pre-note level
            # to the note's peak (robust to the previous note's decaying tail)
            thr = w[0] + 0.1 * (w.max() - w[0])
            onset = int(np.argmax(w > thr))
            worst_ms = max(worst_ms, abs((onset - 480) / SR * 1000))
    check(f"bass/kick onsets within 5 ms of grid @ {bpm} bpm", worst_ms <= 5, f"worst {worst_ms:.2f} ms")

# ---- musicality
A_MIN = [9, 11, 0, 2, 4, 5, 7]
def cents_off(f):
    m = 69 + 12 * np.log2(f / 440)
    return min(abs((m - round(m)) * 100) if round(m) % 12 in A_MIN else 1e9 for _ in [0]), round(m) % 12
L, info = synth.bed_layers(46, 100, secs, 7)
LD, _ = synth.bed_layers(46, 100, secs, 7, reverb_wet=0)  # dry: the notes without reverb room modes
print("notes used:", ", ".join(f"{n} {f}Hz" for n, f in info["notes"]))
check("all fundamentals in A natural minor", all(round(69 + 12 * np.log2(f / 440)) % 12 in A_MIN for _, f in info["notes"]), f"{len(info['notes'])} notes")
def peaks_in_key(x, lo_hz, db_floor=-25, top=4):
    """Hann-windowed, zero-padded FFT peaks (> db_floor re the window max) -> list of out-of-key ones."""
    w = x * np.hanning(len(x))
    sp = np.abs(np.fft.rfft(w, 2 ** 18)); fr = np.fft.rfftfreq(2 ** 18, 1 / SR)
    pk, _ = signal.find_peaks(sp, height=sp.max() * 10 ** (db_floor / 20), prominence=sp.max() * 10 ** ((db_floor - 5) / 20))
    bad, n = [], 0
    pk = pk[np.argsort(sp[pk])[::-1][:top]]  # dominant peaks only: weaker local maxima are onset/decay splatter, not pitches
    for i in pk:
        if fr[i] < lo_hz: continue
        n += 1
        m = 69 + 12 * np.log2(fr[i] / 440)
        if round(m) % 12 not in A_MIN or abs(m - round(m)) > 0.3:
            bad.append((round(float(fr[i]), 1), round(float(m - round(m)), 2)))
    return n, bad

beat = 0.6
for layer in ("pad", "pluck", "bass"):
    x = LD[layer].mean(axis=1)  # dry notes (the reverb adds soft room resonances that are not notes)
    n_pk, bad = 0, []
    # analyse per beat window (0.45 s after each beat) so repetition sidebands of the rhythm don't masquerade as pitches
    for k in range(2, 70):
        s0 = int(round(k * beat * SR)) + 480
        seg = x[s0:s0 + int(0.45 * SR)]
        if len(seg) < 1000 or np.abs(seg).max() < 1e-4: continue
        n, bd = peaks_in_key(seg, 40 if layer == "bass" else 100)
        n_pk += n; bad += bd
    check(f"solo {layer}: spectral peaks (top-4 per beat window) all in key", not bad, f"{n_pk} peaks, off-scale: {bad[:6]}")
e8 = [{"from": 0, "to": 40, "energy": 0.8}]
b8 = synth.bed(40, 100, e8, 7).mean(axis=1)
f, p = signal.welch(b8, SR, nperseg=2 ** 16)
low = 10 * np.log10(p[f < 28].sum() / p.sum())
check("energy below 28 Hz (rel. total) < -40 dB", low < -40, round(float(low), 1))
ff, _, Z = signal.stft(b8, SR, nperseg=4096)
mag = np.abs(Z)
cent = float(((ff[:, None] * mag).sum(0) / np.maximum(mag.sum(0), 1e-12)).mean())  # standard frame-mean centroid
print(f"info: power-weighted centroid {(f * p).sum() / p.sum():.0f} Hz (dominated by bass)")
check("bed spectral centroid 300-2500 Hz @ energy 0.8 (frame-mean, magnitude)", 300 <= cent <= 2500, round(cent, 1))
# ---- mid band vs voice on the stems of the mix under test
voice, _ = sf.read(base + ".stems/voice.wav"); music, _ = sf.read(base + ".stems/music.wav")
vm, mm = voice.mean(axis=1), music.mean(axis=1)
act = np.convolve(vm ** 2, np.ones(960) / 960, mode="same") > 1e-5
def band(x, lo, hi): return float(np.sqrt(np.mean(signal.sosfilt(signal.butter(4, [lo, hi], "bandpass", fs=SR, output="sos"), x)[act] ** 2)))
vb, mb = band(vm, 1000, 4000), band(mm, 1000, 4000)
d = 20 * np.log10(vb / mb)
check("bed 1-4 kHz >= 6 dB below voice (active)", d >= 6, round(float(d), 1))
tot = 10 * np.log10(np.mean(b8 ** 2))
mid = 10 * np.log10(np.mean(signal.sosfilt(signal.butter(4, [1000, 4000], "bandpass", fs=SR, output="sos"), b8) ** 2))
print(f"info: bed@0.8 mid-band (1-4k) is {tot - mid:.1f} dB below its total power")

# ---- performance: 46 s timeline (needs the two demo clips; a real film's clips have other ids)
if not all(os.path.exists(os.path.join(narr, n)) for n in ("d01.wav", "d02.wav")):
    print("SKIP  46 s mix < 30 s: needs d01.wav and d02.wav in the narration folder (two short demo clips)")
    sys.exit(0)
tl = {"duration": 46.0, "bpm": 100, "seed": 7,
      "narration": [{"id": "d01" if i % 2 == 0 else "d02", "start": 0.4 + i * 4.5} for i in range(10)],
      "sfx": [{"type": t, "t": 2 + 2 * i, "gain_db": -8} for i, t in enumerate(synth.SFX)],
      "music": {"gain_db": -14, "duck_db": 9, "sections": [{"from": 0, "to": 5, "energy": 0.3}, {"from": 5, "to": 40, "energy": 0.8}]}}
with tempfile.TemporaryDirectory() as td:
    json.dump(tl, open(td + "/t.json", "w"))
    r0 = resource.getrusage(resource.RUSAGE_CHILDREN); t0 = time.time()
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "mix.py"), td + "/t.json", narr, td + "/o"], check=True, capture_output=True)
    wall = time.time() - t0; r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = r1.ru_utime + r1.ru_stime - r0.ru_utime - r0.ru_stime
    r46 = json.load(open(td + "/o.report.json"))
print(f"46s mix: LUFS {r46['integrated_lufs']} TP {r46['true_peak_dbtp']} v/m {r46['voice_to_music_db']} clipped {r46['clipped_samples']}")
check("46 s mix < 30 s", wall < 30, f"wall {wall:.1f}s, cpu {cpu:.1f}s (load avg {os.getloadavg()[0]:.0f} on {os.cpu_count()} cores)")
