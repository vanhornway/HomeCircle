#!/usr/bin/env python3
"""Generate the SOS alarm sounds (assets/sounds/sos_*.wav).

One per chirp, so you know who needs help before you look: the sender's chirp,
then "SOS" in Morse (. . .  - - -  . . .) twice, then the chirp again. Louder
and more insistent than a chirp. Run make-chirps.py first.

    python3 scripts/make-sos.py
"""
import math
import os
import struct
import wave

SR = 44100
DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'sounds')
NAMES = ['robin', 'wren', 'finch', 'chickadee', 'cardinal', 'bluebird', 'canary', 'sparrow', 'lark', 'dove']
TONE = 1046.5  # C6: cuts through, without being shrill on a phone speaker
DIT = 0.09
PEAK = 0.8


def read(path):
    with wave.open(path, 'rb') as w:
        assert w.getframerate() == SR and w.getsampwidth() == 2 and w.getnchannels() == 1, path
        raw = w.readframes(w.getnframes())
    return [s / 32767 for s in struct.unpack(f'<{len(raw) // 2}h', raw)]


def beep(dur):
    n = int(dur * SR)
    ramp = int(0.006 * SR)
    out = []
    for i in range(n):
        env = min(1.0, i / ramp, (n - 1 - i) / ramp)
        t = i / SR
        out.append(env * (math.sin(2 * math.pi * TONE * t) + 0.2 * math.sin(4 * math.pi * TONE * t)) / 1.2)
    return out


def rest(dur):
    return [0.0] * int(dur * SR)


def morse_sos():
    out = []
    for letter in ('...', '---', '...'):
        for i, sym in enumerate(letter):
            out += beep(DIT if sym == '.' else 3 * DIT)
            if i < 2:
                out += rest(DIT)
        out += rest(3 * DIT)
    return out


def scale(samples, peak):
    top = max(1e-9, max(abs(s) for s in samples))
    return [s * peak / top for s in samples]


def write(name, samples):
    path = os.path.join(DIR, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s)) * 32767)) for s in samples))
    print(f'{name}: {len(samples) / SR:.1f} s')


def main():
    sos = scale(morse_sos(), PEAK)
    for name in NAMES:
        chirp = scale(read(os.path.join(DIR, f'chirp_{name}.wav')), PEAK)
        write(f'sos_{name}.wav', chirp + rest(0.25) + sos + rest(0.35) + sos + rest(0.25) + chirp)


if __name__ == '__main__':
    main()
