#!/usr/bin/env python3
"""Generate the ten chirp sounds (assets/sounds/chirp_*.wav).

Each one is synthesized from scratch (no recordings, so no licensing), soft
and short, and shaped differently enough that you can tell who chirped you
from across the room: different pitch, rhythm and contour.

    python3 scripts/make-chirps.py
"""
import math
import os
import struct
import wave

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'sounds')
PEAK = 0.5  # about -6 dBFS: clear on a phone speaker, never harsh


def note(f0, f1, dur, shape='lin', vib=(0, 0), amp=1.0, attack=0.008, tail=0.35, harm=(1.0, 0.16, 0.04), am=(0, 0)):
    """One syllable: a glide from f0 to f1 with a soft envelope."""
    n = int(dur * SR)
    out = [0.0] * n
    phase = 0.0
    vib_rate, vib_depth = vib
    am_rate, am_depth = am
    for i in range(n):
        t = i / SR
        x = i / max(1, n - 1)
        if shape == 'arch':  # up to f1 and back to f0
            f = f0 + (f1 - f0) * math.sin(math.pi * x)
        elif shape == 'exp':  # quick start, settles at f1
            f = f1 + (f0 - f1) * math.exp(-5 * x)
        else:
            f = f0 + (f1 - f0) * x
        f += vib_depth * math.sin(2 * math.pi * vib_rate * t)
        phase += 2 * math.pi * f / SR
        s = sum(h * math.sin((k + 1) * phase) for k, h in enumerate(harm))
        # Raised-cosine attack, smooth sine-shaped body, gentle exponential tail.
        env = 0.5 - 0.5 * math.cos(math.pi * min(1.0, t / attack))
        env *= math.sin(math.pi * x) ** tail
        if am_depth:
            env *= 1 - am_depth * (0.5 + 0.5 * math.sin(2 * math.pi * am_rate * t))
        out[i] = amp * env * s
    return out


def song(parts, room=True):
    """parts: [(start seconds, samples)] mixed into one clip, with a soft room echo."""
    length = max(int(start * SR) + len(s) for start, s in parts) + int(0.25 * SR)
    buf = [0.0] * length
    for start, s in parts:
        o = int(start * SR)
        for i, v in enumerate(s):
            buf[o + i] += v
    if room:
        for delay, gain in ((0.031, 0.18), (0.067, 0.09), (0.113, 0.04)):
            d = int(delay * SR)
            for i in range(length - 1, d - 1, -1):
                buf[i] += gain * buf[i - d]
    top = max(abs(v) for v in buf) or 1
    return [v * PEAK / top for v in buf]


def seq(notes, start=0.0):
    """Notes one after another: [(gap before, samples)]."""
    parts, t = [], start
    for gap, s in notes:
        t += gap
        parts.append((t, s))
        t += len(s) / SR
    return parts


CHIRPS = {
    # "Cheerily, cheer-up": rounded rising-falling phrases.
    'robin': lambda: song(seq([
        (0, note(2400, 3100, 0.14, 'arch')), (0.05, note(3000, 2500, 0.12)),
        (0.05, note(2600, 3300, 0.14, 'arch')), (0.08, note(3100, 2700, 0.16)),
    ])),
    # A quick, bright descending trill.
    'wren': lambda: song(seq([(0 if i == 0 else 0.018, note(4700 - 70 * i, 4100 - 70 * i, 0.045, attack=0.004, tail=0.5)) for i in range(9)])),
    # Two upward "tweet"s.
    'finch': lambda: song(seq([
        (0, note(2800, 4400, 0.11, 'exp')), (0.12, note(2800, 4400, 0.11, 'exp')),
    ])),
    # The two-note "fee-bee" whistle.
    'chickadee': lambda: song(seq([
        (0, note(3950, 3920, 0.32, vib=(6, 12), harm=(1.0, 0.05))),
        (0.06, note(3450, 3400, 0.36, vib=(6, 12), harm=(1.0, 0.05))),
    ])),
    # "Cheer, cheer, cheer": long downward slurs.
    'cardinal': lambda: song(seq([(0 if i == 0 else 0.09, note(4200, 2100, 0.22, tail=0.3)) for i in range(3)])),
    # A soft, wavering warble.
    'bluebird': lambda: song(seq([
        (0, note(2600, 2650, 0.2, vib=(18, 120))), (0.03, note(2900, 2950, 0.18, vib=(18, 120))),
        (0.03, note(2500, 2450, 0.28, vib=(18, 120))),
    ])),
    # A rolling trill that climbs.
    'canary': lambda: song(seq([(0 if i == 0 else 0.012, note(2800 + 90 * i, 3100 + 90 * i, 0.05, attack=0.004)) for i in range(12)])),
    # Two crisp "chip"s, then a short buzzy trill.
    'sparrow': lambda: song(seq([
        (0, note(5200, 3800, 0.04, attack=0.003, tail=0.6)), (0.09, note(5200, 3800, 0.04, attack=0.003, tail=0.6)),
        (0.12, note(3450, 3350, 0.35, am=(55, 0.7))),
    ])),
    # Five notes stepping up a pentatonic scale.
    'lark': lambda: song(seq([(0 if i == 0 else 0.03, note(f, f * 1.03, 0.1, 'arch')) for i, f in enumerate((2640, 2960, 3320, 3960, 4440))])),
    # A low, gentle coo.
    'dove': lambda: song(seq([
        (0, note(520, 620, 0.35, 'arch', harm=(1.0, 0.35, 0.12), tail=0.5)),
        (0.12, note(560, 500, 0.5, harm=(1.0, 0.35, 0.12), tail=0.5)),
    ])),
}


def write(name, samples):
    path = os.path.join(OUT, f'chirp_{name}.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v)) * 32767)) for v in samples))
    return path


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, make in CHIRPS.items():
        s = make()
        print(f'{write(name, s)}  {len(s) / SR:.2f} s')
