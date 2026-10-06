"""Original PICK FARM sound effects, synthesised with NumPy (no samples).

Usage: python3 build-sounds.py <assets-dir>
Short, quiet mono 22.05 kHz 16-bit WAV files: water, plant, coin, level, cluck, moo, tap.
Deterministic (seeded noise).
"""
import sys
import wave
from pathlib import Path

import numpy as np

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
OUT.mkdir(parents=True, exist_ok=True)
RATE = 22050
rng = np.random.default_rng(20261008)


def t(seconds):
    return np.arange(int(RATE * seconds)) / RATE


def env(n, attack=0.005, release=0.2, total=None):
    total = total or n / RATE
    x = np.arange(n) / RATE
    a = np.clip(x / attack, 0, 1)
    r = np.clip((total - x) / release, 0, 1)
    return a * r


def lowpass(x, k):
    """One-pole low-pass; k in (0, 1], smaller is darker."""
    y = np.zeros_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += k * (v - acc)
        y[i] = acc
    return y


def bell(freq, seconds, decay=6.0, partials=((1, 1), (2.76, 0.35), (5.4, 0.12))):
    x = t(seconds)
    out = sum(a * np.sin(2 * np.pi * freq * m * x) * np.exp(-decay * m ** 0.5 * x) for m, a in partials)
    return out * env(len(x), 0.002, 0.05)


def save(name, signal, gain=0.5):
    signal = signal / max(1e-6, np.abs(signal).max()) * gain
    data = (signal * 32767).astype('<i2')
    with wave.open(str(OUT / name), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())
    print(name, f'{len(signal) / RATE:.2f}s')


def mix(*parts):
    n = max(len(p) + o for p, o in parts)
    out = np.zeros(n)
    for p, o in parts:
        out[o:o + len(p)] += p
    return out


# Water: a soft splash of filtered noise with a few droplet chirps.
n = int(RATE * 0.55)
splash = lowpass(rng.normal(0, 1, n), 0.18) * env(n, 0.01, 0.4) * 0.8
drops = []
for i, f in enumerate([1400, 1800, 1150, 2100]):
    x = t(0.06)
    chirp = np.sin(2 * np.pi * (f + 2600 * x) * x) * np.exp(-50 * x)
    drops.append((chirp * 0.35, int(RATE * (0.05 + i * 0.09))))
save('water.wav', mix((splash, 0), *drops), 0.38)

# Plant: a soft earthy thump and a small pop.
x = t(0.22)
thump = np.sin(2 * np.pi * (140 - 260 * x) * x) * np.exp(-22 * x)
pop = np.sin(2 * np.pi * 620 * t(0.05)) * np.exp(-70 * t(0.05)) * 0.4
dirt = lowpass(rng.normal(0, 1, len(x)), 0.08) * np.exp(-16 * x) * 0.5
save('plant.wav', mix((thump + dirt, 0), (pop, int(RATE * 0.03))), 0.42)

# Coin: two bright bell notes, a classic pick-up.
save('coin.wav', mix((bell(1318.5, 0.28, 9), 0), (bell(1975.5, 0.42, 7), int(RATE * 0.07))), 0.35)

# Level up: rising major arpeggio with a shimmer.
notes = [523.25, 659.25, 783.99, 1046.5]
parts = [(bell(f, 0.7, 4.5) * (0.8 + 0.1 * i), int(RATE * 0.11 * i)) for i, f in enumerate(notes)]
shimmer = bell(2093, 0.9, 3.5) * 0.35
save('level.wav', mix(*parts, (shimmer, int(RATE * 0.44))), 0.42)

# Cluck: two short pitched bursts shaped like a hen's "buk-buk".
def buk(f0, seconds):
    x = t(seconds)
    f = f0 * (1 + 0.5 * np.exp(-30 * x))
    phase = 2 * np.pi * np.cumsum(f) / RATE
    tone = np.sign(np.sin(phase)) * 0.4 + np.sin(phase * 2) * 0.3
    return lowpass(tone, 0.35) * env(len(x), 0.004, 0.05)


save('cluck.wav', mix((buk(520, 0.09), 0), (buk(600, 0.12), int(RATE * 0.14))), 0.32)

# Moo: low voice with vibrato and a vowel-like low-pass sweep.
x = t(0.9)
f = 118 + 22 * np.sin(np.pi * x / 0.9) + 3 * np.sin(2 * np.pi * 5.5 * x)
phase = 2 * np.pi * np.cumsum(f) / RATE
saw = sum(np.sin(phase * k) / k for k in range(1, 14))
voice = lowpass(saw, 0.09) * env(len(x), 0.12, 0.3)
save('moo.wav', voice, 0.4)

# Tap: a tiny wooden click for opening and buying.
x = t(0.07)
save('tap.wav', np.sin(2 * np.pi * 900 * x) * np.exp(-90 * x) + lowpass(rng.normal(0, 1, len(x)), 0.5) * np.exp(-120 * x) * 0.3, 0.25)

# Birds: a quiet 12-second meadow loop - soft wind and a few chirps, seamless at the seam.
LOOP = 12.0
n = int(RATE * LOOP)
wind = lowpass(rng.normal(0, 1, n), 0.02)
wind = wind / np.abs(wind).max() * 0.12
x = np.arange(n) / RATE
wind *= 0.75 + 0.25 * np.sin(2 * np.pi * x / LOOP)
birds = np.zeros(n)
for k in range(14):
    start = rng.uniform(0.2, LOOP - 1.0)
    base = rng.uniform(2600, 4200)
    for j in range(rng.integers(2, 5)):
        d = rng.uniform(0.05, 0.11)
        tt = t(d)
        f = base * (1 + 0.35 * np.sin(np.pi * tt / d)) + rng.uniform(-200, 200)
        chirp = np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.sin(np.pi * tt / d) ** 2
        i0 = int(RATE * (start + j * rng.uniform(0.09, 0.16)))
        birds[i0:i0 + len(chirp)] += chirp[: max(0, n - i0)] * rng.uniform(0.15, 0.35)
loop = wind + birds
fade = int(RATE * 0.3)
# Crossfade the ends so the loop has no click.
loop[:fade] = loop[:fade] * np.linspace(0, 1, fade) + loop[-fade:] * np.linspace(1, 0, fade)
loop = loop[:-fade]
save('birds.wav', loop, 0.22)
