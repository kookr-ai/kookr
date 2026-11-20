#!/usr/bin/env python3
"""Writes audio/timeline.json: narration starts, sound effects and music sections for the film.
Every time here mirrors an event in storyboard.md; change both together.
usage: python3 audio/make-timeline.py"""
import json, os

DURATION, BPM = 49.0, 120
narration = [("l01", 0.25), ("l03", 4.30), ("l04", 7.40), ("l05", 10.80), ("l06", 17.00), ("l07", 23.80),
             ("l08", 26.10), ("l09", 31.30), ("l10", 36.30), ("l12", 40.30), ("l11", 44.00)]
sfx = []
def fx(kind, t, gain_db=-12, pan=0.0, **args):
    e = {"type": kind, "t": round(t, 3), "gain_db": gain_db, "pan": pan}
    if args: e["args"] = args
    sfx.append(e)

def typing(start, end, per_second=11, gain_db=-26):
    """Soft key clicks under a typed command: sparse and quiet, so it reads as texture, not clatter."""
    n = int((end - start) * per_second)
    for i in range(n):
        fx("key", start + i * (end - start) / n, gain_db, pan=-0.15 + 0.3 * ((i * 7) % 10) / 10)

# S1 hook: three failures, each a little louder
fx("tick", 0.9, -15); fx("vote_down", 0.9, -20)
fx("tick", 2.8, -13); fx("vote_down", 2.8, -17)
fx("tick", 3.5, -11); fx("vote_down", 3.5, -14)
# S2 reveal: riser into the first big cut, then three lessons land
fx("riser", 3.0, -14, duration=1.0); fx("impact", 4.0, -4)
fx("stamp", 5.9, -14); fx("stamp", 6.2, -14); fx("stamp", 6.5, -14)
# S3 the fourth lesson is typed and lands in its slot
typing(7.6, 8.7); fx("enter", 8.8, -16); fx("stamp", 9.2, -11)
# S4 shown, then voted: two rising chimes, one falling
for i, t in enumerate((12.0, 12.2, 12.4, 12.6)): fx("tick", t, -18, pan=-0.2 + 0.13 * i)
fx("vote_up", 14.3, -10, step=0); fx("vote_up", 14.9, -9, step=2); fx("vote_down", 15.7, -9)
# S5 the cap: typed command, stillness, the second big cut
typing(17.1, 18.1, per_second=14); fx("riser", 17.3, -17, duration=0.8)
fx("enter", 18.4, -14); fx("impact", 18.4, -3)
fx("tick", 18.9, -15); fx("tick", 19.4, -14); fx("tick", 19.9, -13)       # the newcomer pressing on a full shelf
fx("evict", 20.4, -7, pan=0.4); fx("impact", 20.4, -13); fx("stamp", 21.1, -11)
fx("tick", 21.6, -13); fx("vote_down", 21.6, -17)
# S6 shown, not searched: third big cut
fx("impact", 23.8, -7); fx("whoosh", 24.75, -16, duration=0.3, direction="up")
fx("pop", 29.3, -15, pan=-0.3); fx("pop", 29.7, -15); fx("pop", 30.1, -15, pan=0.3)
# S7 paper, S8 back to dark
fx("whoosh", 30.95, -15, duration=0.5, direction="up"); fx("stamp", 33.1, -15)
fx("whoosh", 35.95, -15, duration=0.5, direction="down")
fx("tick", 36.3, -17); fx("tick", 36.6, -17); fx("tick", 36.9, -17)
# S10 payoff: the test passes
typing(41.0, 41.8); fx("enter", 41.85, -17); fx("vote_up", 42.1, -8, step=3); fx("shimmer", 42.1, -14, duration=1.4)
# S9 end card: fourth big cut
fx("impact", 43.8, -8); fx("shimmer", 43.85, -11); fx("pop", 45.6, -16)

timeline = {
    "duration": DURATION, "bpm": BPM, "seed": 7,
    "narration": [{"id": i, "start": s, "gain_db": 0} for i, s in narration],
    "sfx": sorted(sfx, key=lambda e: e["t"]),
    "music": {"gain_db": -9, "duck_db": 10, "sections": [
        {"from": 0.0, "to": 4.0, "energy": 0.25},    # hook: thin, uneasy
        {"from": 4.0, "to": 17.0, "energy": 0.8},    # reveal and mechanism: full
        {"from": 17.0, "to": 18.0, "energy": 0.55},  # tension before the cap
        {"from": 18.0, "to": 18.5, "energy": 0.0},   # stillness before the hit
        {"from": 18.5, "to": 23.5, "energy": 1.0},   # hero
        {"from": 23.5, "to": 31.0, "energy": 0.5},   # the argument: room for the voice
        {"from": 31.0, "to": 36.0, "energy": 0.3},   # paper: warm and thin
        {"from": 36.0, "to": 40.0, "energy": 0.6},   # building
        {"from": 40.0, "to": 43.5, "energy": 0.8},   # payoff
        {"from": 43.5, "to": 48.0, "energy": 0.45},  # resolved
        {"from": 48.0, "to": 49.0, "energy": 0.0},   # last second quiet
    ]},
}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "timeline.json")
json.dump(timeline, open(out, "w"), indent=1)
print(out, len(sfx), "sfx")
