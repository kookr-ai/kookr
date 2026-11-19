"""Local synthesis kit for a short narrated film: a music bed plus UI/cinematic SFX.

Everything is generated from math (numpy/scipy only): no samples, no network, no licensed audio.
Output convention: float32 arrays shaped (n, 2) at 48 kHz.

Developed and tested with numpy 2.2 and scipy 1.15. The library itself needs only numpy and scipy;
mix.py and verify.py also need soundfile.

Musical design: A natural minor. The progression is Am - F - C - G(5), two bars each, so every
fundamental and every partial we synthesize stays inside {A B C D E F G}. Partials are restricted
to harmonics whose pitch classes are in the scale (e.g. no 5th harmonic, which would be a major
third), which is what keeps the bed "in key" even under a measurement.
"""
import numpy as np
from scipy import signal

SR = 48000

# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------


def mtof(m):
    """MIDI note number -> frequency in Hz (A4 = 69 = 440 Hz)."""
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(m):
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


A_MINOR_PITCH_CLASSES = {9, 11, 0, 2, 4, 5, 7}  # A B C D E F G


def _sos(kind, freq, order=2, fs=SR):
    return signal.butter(order, freq, btype=kind, fs=fs, output="sos")


def lowpass(x, freq, order=2, fs=SR):
    return signal.sosfilt(_sos("lowpass", freq, order, fs), x, axis=0)


def highpass(x, freq, order=2):
    return signal.sosfilt(_sos("highpass", freq, order), x, axis=0)


def bandpass(x, lo, hi, order=2):
    return signal.sosfilt(_sos("bandpass", [lo, hi], order), x, axis=0)


def _t(n):
    return np.arange(n) / SR


def _smoothstep(x, a, b):
    """0 below a, 1 above b, smooth in between."""
    u = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


def _stereo(left, right=None):
    right = left if right is None else right
    return np.stack([left, right], axis=1)


def _pan(x, pan):
    """Constant-power pan of a stereo buffer. pan in -1 (left) .. 1 (right)."""
    ang = (np.clip(pan, -1, 1) + 1) * np.pi / 4
    return x * np.array([np.cos(ang), np.sin(ang)]) * np.sqrt(2)


def _finish(x, peak, fin_ms=0.3, fout_ms=10.0):
    """Trim to a target peak and force the buffer to start/end at exactly zero (no clicks)."""
    x = np.asarray(x, dtype=np.float64)
    m = np.max(np.abs(x))
    if m > 0:
        x = x * (peak / m)
    n = len(x)
    fi = max(2, int(SR * fin_ms / 1000))
    fo = max(2, min(n // 2, int(SR * fout_ms / 1000)))
    x[:fi] *= np.linspace(0, 1, fi)[:, None]
    x[n - fo:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fo)))[:, None]
    x[0] = 0.0
    x[-1] = 0.0
    return x.astype(np.float32)


def _noise(rng, n):
    return rng.standard_normal((n, 2))


def _sine_sweep(n, f_of_t):
    """Sine whose instantaneous frequency is f_of_t(t); phase is integrated so there are no jumps."""
    t = _t(n)
    return np.sin(2 * np.pi * np.cumsum(f_of_t(t)) / SR)


# --------------------------------------------------------------------------------------
# Reverb: Schroeder reverb (4 damped parallel combs -> 2 series allpasses per channel).
# The feedback loops are evaluated block-by-block (one block = one delay length) so each
# block is a vectorised scipy call; that is ~100x faster than a per-sample python loop.
# --------------------------------------------------------------------------------------
_COMB_MS = ((29.7, 37.1, 41.1, 43.7), (30.9, 38.3, 42.3, 45.1))  # left / right (decorrelated)
_ALLPASS_MS = (5.0, 1.7)


def _comb(x, d, g, damp):
    """Feedback comb y[n] = x[n] + g * lowpass(y[n-d]); `damp` darkens the tail each pass."""
    n = len(x)
    y = np.zeros(n)
    y[:d] = x[:d]
    zi = np.zeros(1)
    for s in range(d, n, d):
        e = min(s + d, n)
        fb, zi = signal.lfilter([1 - damp], [1, -damp], y[s - d:s], zi=zi)
        y[s:e] = x[s:e] + g * fb[:e - s]
    return y


def _allpass(x, d, g):
    """Schroeder allpass y[n] = -g x[n] + x[n-d] + g y[n-d]: thickens echoes without colouring."""
    n = len(x)
    y = -g * x
    for s in range(d, n, d):
        e = min(s + d, n)
        k = e - s
        y[s:e] = -g * x[s:e] + x[s - d:s - d + k] + g * y[s - d:s - d + k]
    return y


def reverb(x, rt60=1.5, wet=0.3, damp=0.35, predelay=0.0, tail=None, sr=SR):
    """Add reverb to a stereo buffer. Returns dry + wet*reverb, extended by `tail` seconds
    (default: rt60/2) so the decay is not cut off. rt60 is the time to decay by 60 dB."""
    x = np.asarray(x, dtype=np.float64)
    tail_n = int(sr * (rt60 * 0.5 if tail is None else tail))
    pre = int(sr * predelay)
    n = len(x) + tail_n
    out = np.zeros((n, 2))
    out[:len(x)] += x
    for ch in range(2):
        src = np.zeros(n)
        src[pre:len(x) + pre if len(x) + pre <= n else n] = x[:n - pre, ch]
        acc = np.zeros(n)
        for ms in _COMB_MS[ch]:
            d = int(sr * ms / 1000)
            acc += _comb(src, d, 10 ** (-3.0 * d / (rt60 * sr)), damp)
        for ms in _ALLPASS_MS:
            acc = _allpass(acc, int(sr * ms / 1000), 0.7)
        out[:, ch] += wet * 0.35 * acc
    return out


# --------------------------------------------------------------------------------------
# MUSIC BED
# --------------------------------------------------------------------------------------
# Chord table, two bars (8 beats) each. Voicings avoid B (its 3rd harmonic would be F#, out of key).
#   pad    : MIDI notes for the sustained pad
#   bass   : MIDI root for the pulse (>= F1 = 43.7 Hz so nothing lands below 28 Hz)
#   arp    : the four notes the pluck arpeggio cycles through
PROGRESSION = [
    dict(name="Am", pad=[45, 52, 57, 60, 64], bass=33, arp=[57, 60, 64, 69]),
    dict(name="F", pad=[41, 48, 53, 57, 60], bass=29, arp=[53, 57, 60, 65]),
    dict(name="C", pad=[48, 55, 60, 64, 67], bass=36, arp=[60, 64, 67, 72]),
    dict(name="G5", pad=[43, 50, 55, 62, 67], bass=31, arp=[55, 62, 67, 74]),
]
BEATS_PER_CHORD = 8

# Fixed per-layer output scales, tuned by measurement so that energy 1.0 peaks near -6 dBFS.
_LAYER_SCALE = dict(pad=0.22, pluck=0.24, bass=0.26, kick=0.30, hats=0.05)

# Single-cycle wavetable for the pad: harmonics 1,2,3,4,6 only (all in-key for our chord roots).
_TABLE_N = 65536
_ph = np.arange(_TABLE_N) / _TABLE_N
_PAD_TABLE = sum(a * np.sin(2 * np.pi * h * _ph) for h, a in ((1, 1), (2, .5), (3, .33), (4, .2), (6, .1)))


def _wavetable(phase):
    """Nearest-entry lookup in a 65536-point table (fast; the table is fine enough to be inaudible)."""
    return _PAD_TABLE[(phase * _TABLE_N).astype(np.int64) & (_TABLE_N - 1)]


def _energy_curve(n, sections, xfade=0.6):
    """Per-sample energy 0..1 from the sections list, smoothed so layers crossfade (no clicks).
    The smoothing window is a Hann of `xfade` seconds, centred on each boundary."""
    e = np.zeros(n)
    for s in sections:
        a, b = int(round(s["from"] * SR)), int(round(s["to"] * SR))
        e[max(a, 0):min(b, n)] = float(s["energy"])
    w = np.hanning(int(xfade * SR)) if xfade > 0 else np.ones(1)
    w /= w.sum()
    pad = len(w)
    padded = np.pad(e, (pad, pad), mode="edge")
    return signal.fftconvolve(padded, w, mode="same")[pad:-pad]


def _layer_gains(e):
    """Energy -> per-layer gain. This is the 'arrangement': which layer plays at which energy."""
    return dict(
        pad=0.12 + 0.88 * _smoothstep(e, 0.0, 0.3),   # 0 = pad tail only, quiet
        pluck=_smoothstep(e, 0.15, 0.3),               # enters by 0.3
        bass=_smoothstep(e, 0.45, 0.6),                # enters by 0.6
        kick=_smoothstep(e, 0.6, 1.0),                 # full only at 1.0
        hats=_smoothstep(e, 0.7, 1.0),
    )


def _grid(n, bpm):
    """Sample index of every beat; t=0 is beat 0 (a downbeat). Rounded to the nearest sample."""
    beat = 60.0 / bpm
    k = np.arange(int(np.ceil(n / SR / beat)) + 2)
    return np.round(k * beat * SR).astype(np.int64)


def _chord_at(beat_index):
    return PROGRESSION[(beat_index // BEATS_PER_CHORD) % len(PROGRESSION)]


def _add(buf, start, sig):
    """Mix `sig` into `buf` at `start`, clipped to the buffer."""
    if start >= len(buf) or start + len(sig) <= 0:
        return
    a = max(start, 0)
    b = min(start + len(sig), len(buf))
    buf[a:b] += sig[a - start:b - start]


def _pad_layer(n, bpm, rng, wet=1.0):
    """Warm detuned pad: three slightly detuned voices per note and per channel (chorus-like width),
    chord changes crossfaded over one beat, a slow LFO sweeps the low-pass cutoff, light reverb."""
    grid = _grid(n, bpm)
    beat = 60.0 / bpm
    # The pad is low-passed below ~1.3 kHz anyway, so synthesize it at SR/4 and upsample: 4x cheaper.
    D = 4
    rate = SR // D
    grid_lo = grid // D
    n_lo = n // D + 1
    xf = int(beat * rate)
    out = np.zeros((n_lo, 2))
    nchords = int(np.ceil((len(grid) - 1) / BEATS_PER_CHORD))
    for c in range(nchords):
        a = grid_lo[c * BEATS_PER_CHORD]
        b = grid_lo[min((c + 1) * BEATS_PER_CHORD, len(grid) - 1)]
        s0, s1 = a - xf, b + xf
        seg_n = s1 - s0
        t = np.arange(seg_n) / rate
        env = np.ones(seg_n)
        if c > 0:  # the first chord starts at full level; later ones fade in across the overlap
            env[:2 * xf] = np.sin(np.linspace(0, np.pi / 2, 2 * xf)) ** 2
        env[-2 * xf:] *= np.cos(np.linspace(0, np.pi / 2, 2 * xf)) ** 2  # fade out across the overlap
        chord = PROGRESSION[c % len(PROGRESSION)]
        seg = np.zeros((seg_n, 2))
        for ch in range(2):
            for m in chord["pad"]:
                f0 = mtof(m)
                for cents in rng.uniform(-10, 10, 3):
                    seg[:, ch] += _wavetable(f0 * 2 ** (cents / 1200) * t + rng.random()) / (3 * len(chord["pad"]))
        _add(out, s0, seg * env[:, None])
    # slow filter movement: crossfade between a dark and a brighter low-pass, LFO period ~ 8 bars
    t = np.arange(n_lo) / rate
    lfo = 0.5 + 0.5 * np.sin(2 * np.pi * t / (beat * 32) - np.pi / 2)  # starts dark
    dark, bright = lowpass(out, 450, 2, rate), lowpass(out, 1300, 2, rate)
    out = dark * (1 - lfo[:, None]) + bright * lfo[:, None]
    out = reverb(out, rt60=2.5, wet=0.35 * wet, damp=0.5, tail=0, sr=rate)
    out = signal.resample_poly(out, D, 1, axis=0)[:n]
    # 10 ms fade-in: the pad's phases start mid-cycle, so avoid a step at t=0
    fi = int(0.01 * SR)
    out[:fi] *= np.linspace(0, 1, fi)[:, None]
    return out


def _pluck_layer(n, bpm, rng, e, wet=1.0):
    """Sparse plucked arpeggio on the 8th-note grid. A seeded random draw per step decides whether
    the step plays; the play probability rises with the energy at that moment (sparse at 0.3).
    Echoes at a dotted 8th bounce left/right (a feedback-delay flavour) and a bit of reverb."""
    grid = _grid(n, bpm)
    beat = 60.0 / bpm
    pattern = [0, 1, 2, 3, 2, 1, 2, 3]
    dry = np.zeros((n, 2))
    note_n = int(0.9 * SR)
    tt = np.arange(note_n) / SR
    tones = {}  # only ~16 distinct pitches exist, so render each once
    for k in range(len(grid) * 2):
        start = grid[k // 2] if k % 2 == 0 else int(round((k // 2 + 0.5) * beat * SR))
        if start >= n:
            break
        r = rng.random()
        pan_draw = rng.uniform(-0.6, 0.6)
        density = 0.2 + 0.7 * _smoothstep(e[start], 0.3, 1.0)
        if r > density:
            continue
        chord = _chord_at(k // 2)
        f = mtof(chord["arp"][pattern[k % 8]])
        # harmonics 1-4 only: all in key (no 5th harmonic = no major third)
        if f not in tones:
            tone = sum(a * np.sin(2 * np.pi * h * f * tt) * np.exp(-tt * (6 + 5 * h)) for h, a in ((1, 1), (2, .5), (3, .25), (4, .12)))
            tones[f] = tone * np.minimum(1, tt / 0.002) * np.exp(-tt * 1.5)
        tone = tones[f]
        _add(dry, start, _pan(_stereo(tone), pan_draw))
    # ping-pong feedback echo: two repeats, alternating sides
    d = int(round(0.75 * beat * SR))
    echo = dry.copy()
    for i, g in enumerate((0.38, 0.16)):
        sh = np.zeros_like(dry)
        sh[d * (i + 1):] = dry[:n - d * (i + 1)][:, ::-1 if i % 2 == 0 else 1]
        echo += g * sh
    return reverb(echo, rt60=1.8, wet=0.25 * wet, damp=0.5, tail=0)[:n]


def _bass_layer(n, bpm):
    """Warm sub pulse: one short sine note per beat on the chord root (+ soft 2nd/3rd harmonic so it
    is audible on small speakers too)."""
    grid = _grid(n, bpm)
    beat = 60.0 / bpm
    out = np.zeros((n, 2))
    nn = int(min(0.5, beat * 0.9) * SR)
    tt = np.arange(nn) / SR
    for k, s in enumerate(grid):
        if s >= n:
            break
        f = mtof(_chord_at(k)["bass"])
        # harmonics 1-3 only (no saturation: tanh would add a 5th harmonic = out-of-key major third)
        tone = np.sin(2 * np.pi * f * tt) + 0.45 * np.sin(2 * np.pi * 2 * f * tt) + 0.2 * np.sin(2 * np.pi * 3 * f * tt)
        tone = tone * np.minimum(1, tt / 0.004) * np.exp(-tt / 0.2)
        tone *= 1.0 if k % 4 == 0 else 0.8  # gentle accent on the downbeat
        _add(out, s, _stereo(tone))
    return _hp_zero_phase(out, 32)


def _kick_layer(n, bpm):
    """Soft kick on beats 1 and 3 of every bar: a sine sweeping ~120 -> 50 Hz."""
    grid = _grid(n, bpm)
    out = np.zeros((n, 2))
    nn = int(0.3 * SR)
    tt = np.arange(nn) / SR
    phase = 2 * np.pi * (50 * tt + 70 * 0.03 * (1 - np.exp(-tt / 0.03)))
    tone = np.sin(phase) * np.minimum(1, tt / 0.003) * np.exp(-tt / 0.1)
    for k, s in enumerate(grid):
        if s >= n:
            break
        if k % 2 == 0:
            _add(out, s, _stereo(tone))
    return _hp_zero_phase(out, 32)


def _hats_layer(n, bpm, rng):
    """Light noise hats on the off-beat 8ths, band-limited to 6-10 kHz so they tick, not hiss."""
    beat = 60.0 / bpm
    out = np.zeros((n, 2))
    nn = int(0.05 * SR)
    tt = np.arange(nn) / SR
    for k in range(int(n / SR / beat) + 2):
        s = int(round((k + 0.5) * beat * SR))
        if s >= n:
            break
        burst = bandpass(_noise(rng, nn), 6000, 10000, 2) * np.minimum(1, tt / 0.001)[:, None] * np.exp(-tt / 0.012)[:, None]
        _add(out, s, burst * rng.uniform(0.6, 1.0))
    return out


def _hp_zero_phase(x, f):
    """Zero-phase high-pass (forward-backward) so onset timing is not smeared; removes < ~28 Hz.
    First-order on purpose: a steeper filter pre-rings by ~3 ms before each bass onset."""
    return signal.sosfiltfilt(_sos("highpass", f, 1), x, axis=0)


def bed_layers(duration, bpm, sections, seed, reverb_wet=1.0):
    """Render each layer separately (already gain-scheduled by energy). Returns (layers, info).
    Sum of layers + final fade == bed(). reverb_wet=0 renders pad/pluck dry (used to test the notes themselves)."""
    n = int(round(duration * SR))
    e = _energy_curve(n, sections)
    g = _layer_gains(e)
    seeds = np.random.SeedSequence(int(seed)).spawn(3)
    rng_pad, rng_pluck, rng_hat = (np.random.default_rng(s) for s in seeds)
    raw = dict(
        pad=_pad_layer(n, bpm, rng_pad, reverb_wet),
        pluck=_pluck_layer(n, bpm, rng_pluck, e, reverb_wet),
        bass=_bass_layer(n, bpm),
        kick=_kick_layer(n, bpm),
        hats=_hats_layer(n, bpm, rng_hat),
    )
    layers = {k: raw[k] * g[k][:, None] * _LAYER_SCALE[k] for k in raw}
    notes = sorted({m for c in PROGRESSION for m in c["pad"] + c["arp"] + [c["bass"]]})
    info = dict(notes=[(note_name(m), round(mtof(m), 2)) for m in notes], energy=e)
    return layers, info


def bed(duration, bpm, sections, seed=0):
    """Music bed: float32 (n, 2) at 48 kHz, t=0 is a downbeat, ends with a clean fade to zero.

    sections: [{"from": s, "to": s, "energy": 0..1}, ...]
      energy 0   -> near silence, pad only
      energy .3  -> pad + sparse pluck
      energy .6  -> + bass pulse
      energy 1.0 -> + soft kick and hats
    Layers fade in/out over ~0.6 s at section boundaries. Same arguments -> identical bytes."""
    layers, _ = bed_layers(duration, bpm, sections, seed)
    x = sum(layers.values())
    x = _hp_zero_phase(x, 32)
    n = len(x)
    fo = min(int(2.0 * SR), n // 2)
    x[n - fo:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fo)))[:, None]
    x[-1] = 0.0
    return x.astype(np.float32)


# --------------------------------------------------------------------------------------
# SFX. Each returns a short (n, 2) float32 buffer that starts and ends at ~0.
# Every function takes `seed` so the mixer can vary repeats deterministically.
# --------------------------------------------------------------------------------------


def key(seed=0):
    """Soft mechanical key: a bright click on top of a short low 'thock'; pitch/level vary by seed."""
    rng = np.random.default_rng(seed)
    n = int(0.06 * SR)
    t = _t(n)
    f0 = 170 * (1 + 0.12 * rng.uniform(-1, 1))
    click = bandpass(_noise(rng, n), 1800, 6000) * np.exp(-t / 0.004)[:, None]
    thock = _stereo(np.sin(2 * np.pi * f0 * t) * np.exp(-t / 0.018))
    return _finish(0.5 * click + 0.8 * thock, 0.35 * rng.uniform(0.8, 1.0))


def enter(seed=0):
    """Heavier key: deeper thock, wider click, plus a second smaller 'clack' as the key bottoms out."""
    rng = np.random.default_rng(seed + 1000)
    n = int(0.12 * SR)
    t = _t(n)
    body = _stereo(np.sin(2 * np.pi * 105 * t) * np.exp(-t / 0.04))
    click = bandpass(_noise(rng, n), 700, 3500) * np.exp(-t / 0.012)[:, None]
    t2 = np.clip(t - 0.045, 0, None)
    clack = bandpass(_noise(rng, n), 1500, 5000) * (np.exp(-t2 / 0.008) * (t >= 0.045))[:, None]
    return _finish(0.9 * body + 0.6 * click + 0.4 * clack, 0.5)


def _sweep_noise(rng, n, f0, f1, bands=9, width=0.9):
    """Noise whose spectral centre glides from f0 to f1 (log-spaced) using a bank of band-passes
    weighted by a moving Gaussian: a time-varying filter without per-sample filter updates."""
    centres = np.geomspace(min(f0, f1), max(f0, f1), bands)
    pos = np.linspace(0, 1, n)
    idx = pos * (bands - 1) if f1 > f0 else (1 - pos) * (bands - 1)
    noise = _noise(rng, n)
    out = np.zeros((n, 2))
    for i, c in enumerate(centres):
        band = bandpass(noise, c / 1.4, min(c * 1.4, SR / 2 * 0.9), 2)
        out += band * np.exp(-0.5 * ((idx - i) / width) ** 2)[:, None]
    return out


def whoosh(duration=0.8, direction="up", seed=0):
    """Filtered-noise swoosh. direction 'up' sweeps dark->bright (peak late), 'down' bright->dark."""
    rng = np.random.default_rng(seed + 2000)
    n = int(duration * SR)
    u = np.linspace(0, 1, n)
    k = 1.5 if direction == "up" else 0.67
    env = np.sin(np.pi * u ** k) ** 2
    sweep = _sweep_noise(rng, n, 250, 7000)  # dark -> bright
    if direction != "up":
        sweep = sweep[::-1]
    return _finish(sweep * env[:, None], 0.6, fout_ms=15)


def impact(duration=1.8, seed=0):
    """Deep cinematic hit: pitch-dropping sub sine + noise burst + short reverb tail."""
    rng = np.random.default_rng(seed + 3000)
    n = int(duration * SR)
    t = _t(n)
    sub = _sine_sweep(n, lambda t: 38 + 70 * np.exp(-t / 0.12)) * np.minimum(1, t / 0.002) * np.exp(-t / 0.45)
    thump = _sine_sweep(n, lambda t: 70 + 90 * np.exp(-t / 0.04)) * np.exp(-t / 0.12) * 0.5
    burst = lowpass(_noise(rng, n), 5000) * (np.exp(-t / 0.07) * np.minimum(1, t / 0.001))[:, None]
    body = _stereo(sub + thump) + 0.5 * burst
    # reverb on the noise/mid part gives the 'room'; the sub stays dry so it does not boom
    wetpart = reverb(0.5 * burst + 0.3 * _stereo(thump), rt60=1.6, wet=0.9, damp=0.4, tail=0)
    return _finish(body + 0.6 * wetpart[:n], 0.9, fout_ms=40)


def riser(duration=2.0, seed=0):
    """Tension riser: noise sweeping up + a tone rising A2 -> A4 (two octaves, in key) with
    accelerating tremolo; amplitude grows quadratically into the cut at the end."""
    rng = np.random.default_rng(seed + 4000)
    n = int(duration * SR)
    t = _t(n)
    u = np.linspace(0, 1, n)
    f = 110 * 4 ** u
    tone = _stereo(np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.3 * np.sin(4 * np.pi * np.cumsum(f) / SR))
    trem = 0.7 + 0.3 * np.sin(2 * np.pi * np.cumsum(6 + 14 * u) / SR)
    noise = _sweep_noise(rng, n, 200, 8000)
    return _finish((0.5 * tone * trem[:, None] + 0.9 * noise) * (u ** 2)[:, None], 0.7, fout_ms=40)


def tick(seed=0):
    """Tiny UI tick: a 3.2 kHz blip with a hair of noise."""
    rng = np.random.default_rng(seed + 5000)
    n = int(0.03 * SR)
    t = _t(n)
    x = _stereo(np.sin(2 * np.pi * 3200 * t) * np.exp(-t / 0.003)) + 0.4 * bandpass(_noise(rng, n), 2000, 6000) * np.exp(-t / 0.002)[:, None]
    return _finish(x, 0.3, fout_ms=6)


def pop(seed=0):
    """Soft bubble pop: a quick upward pitch glide with a rounded envelope."""
    n = int(0.12 * SR)
    t = _t(n)
    x = _sine_sweep(n, lambda t: 350 + 750 * (1 - np.exp(-t / 0.02))) * np.minimum(1, t / 0.003) * np.exp(-t / 0.03)
    return _finish(_stereo(x), 0.5, fout_ms=15)


def _bell(f, n, bright=1.0):
    t = _t(n)
    return (np.sin(2 * np.pi * f * t) + 0.35 * bright * np.sin(4 * np.pi * f * t)
            + 0.12 * bright * np.sin(6 * np.pi * f * t)) * np.minimum(1, t / 0.002) * np.exp(-t / 0.1)


def _two_note(f1, f2, bright, gap=0.11, total=0.35):
    n = int(total * SR)
    x = np.zeros(n)
    for f, at in ((f1, 0.0), (f2, gap)):
        s = int(at * SR)
        m = n - s
        x[s:] += _bell(f, m, bright)
    return reverb(_stereo(x), rt60=0.6, wet=0.2, tail=0)[:n]


def vote_up(seed=0, step=0):
    """'+1': bright rising two-note chime, E5 -> A5 (perfect fourth up).
    `step` 0..3 lifts the whole chime through E, G, A, B (all in A minor, as are their fourths),
    so a run of votes on one lesson climbs instead of repeating."""
    lift = (0, 3, 5, 7)[int(step) % 4]
    return _finish(_two_note(mtof(76 + lift), mtof(81 + lift), 1.0), 0.5, fout_ms=25)


def vote_down(seed=0):
    """'-1': duller falling two-note, E5 -> A4 (perfect fifth down)."""
    return _finish(_two_note(mtof(76), mtof(69), 0.4), 0.5, fout_ms=25)


def evict(seed=0):
    """Soft 'drop out': downward sine thud with an airy, falling noise tail."""
    rng = np.random.default_rng(seed + 6000)
    n = int(0.7 * SR)
    t = _t(n)
    thud = _sine_sweep(n, lambda t: 55 + 150 * np.exp(-t / 0.1)) * np.minimum(1, t / 0.003) * np.exp(-t / 0.15)
    air = _sweep_noise(rng, n, 800, 6000)[::-1] * ((t / 0.15) * np.exp(-t / 0.22))[:, None]
    return _finish(_stereo(thud) + 0.25 * air, 0.7, fout_ms=40)


def stamp(seed=0):
    """Rubber-stamp / paper thump: low body, mid 'thwap', and a brief paper rustle just after."""
    rng = np.random.default_rng(seed + 7000)
    n = int(0.25 * SR)
    t = _t(n)
    body = _sine_sweep(n, lambda t: 55 + 30 * np.exp(-t / 0.05)) * np.exp(-t / 0.05) * np.minimum(1, t / 0.002)
    thwap = bandpass(_noise(rng, n), 400, 2500) * np.exp(-t / 0.018)[:, None]
    t2 = np.clip(t - 0.015, 0, None)
    rustle = highpass(_noise(rng, n), 3000) * (np.exp(-t2 / 0.07) * (t >= 0.015))[:, None]
    return _finish(_stereo(body) + 0.7 * thwap + 0.12 * rustle, 0.8, fout_ms=30)


def shimmer(duration=2.0, seed=0):
    """Logo-reveal sparkle: high in-key partials (A5 E6 A6 C7 E7) with individual tremolo under a
    swelling envelope, random bright glints, all through reverb."""
    rng = np.random.default_rng(seed + 8000)
    n = int(duration * SR)
    t = _t(n)
    u = np.linspace(0, 1, n)
    env = np.sin(np.pi * u ** 1.7) ** 1.5
    x = np.zeros((n, 2))
    for i, m in enumerate((81, 88, 93, 96, 100)):
        trem = 0.65 + 0.35 * np.sin(2 * np.pi * rng.uniform(5, 11) * t + rng.uniform(0, 6.28))
        part = np.sin(2 * np.pi * mtof(m) * t + rng.uniform(0, 6.28)) * trem / (1 + 0.3 * i)
        p = _pan(_stereo(part), -0.7 + 0.35 * i)
        x += p
    glints = np.zeros(n)
    for c in rng.uniform(0.15, 0.7, 14) * n:
        glints += np.exp(-0.5 * ((np.arange(n) - c) / (0.004 * SR)) ** 2) * rng.uniform(0.4, 1)
    x += 0.5 * lowpass(highpass(_noise(rng, n), 4000), 9000) * (glints * env)[:, None]
    x *= env[:, None]
    wet = reverb(x * np.minimum(1, (1 - u) * 6)[:, None], rt60=1.8, wet=0.7, damp=0.3, tail=0)[:n]
    return _finish(wet, 0.6, fout_ms=60)


def glitch(seed=0):
    """Digital stutter for a 'forgotten / reset' moment: a bit-crushed blip chopped into repeating,
    shrinking slices separated by tiny gaps."""
    rng = np.random.default_rng(seed + 9000)
    src_n = int(0.05 * SR)
    t = _t(src_n)
    f = rng.choice([523.25, 659.26, 783.99])  # C5 / E5 / G5: stays in key
    src = np.sign(np.sin(2 * np.pi * f * t)) * 0.5 + 0.3 * rng.standard_normal(src_n)
    src = np.round(src * 8) / 8                   # ~4-bit
    src = np.repeat(src[::6], 6)[:src_n]          # sample-and-hold: lo-fi sample rate
    out = []
    for ms, g in ((30, 1), (30, .9), (15, .8), (15, .7), (8, .6), (8, .5), (8, .4), (4, .3), (4, .25)):
        k = int(ms / 1000 * SR)
        sl = src[:k] * g
        sl = sl * np.minimum(1, np.arange(k) / (0.0005 * SR))  # 0.5 ms edge so slices don't pop
        out.append(sl)
        out.append(np.zeros(int(0.012 * SR)))
    x = np.concatenate(out)
    return _finish(_stereo(x), 0.6, fout_ms=4)


# name -> function registry used by mix.py
SFX = dict(key=key, enter=enter, whoosh=whoosh, impact=impact, riser=riser, tick=tick, pop=pop,
           vote_up=vote_up, vote_down=vote_down, evict=evict, stamp=stamp, shimmer=shimmer, glitch=glitch)
