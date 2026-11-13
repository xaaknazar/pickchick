#!/usr/bin/env python3
"""Original, deterministic Pick Box Foley; no recordings or third-party samples."""
import math
import random
import struct
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'apps/mobile/assets/games/pick-box/audio'
ROOT.mkdir(parents=True, exist_ok=True)
RATE = 22050
for name, duration in [('drop', .13), ('impact', .18), ('perfect', .32), ('miss', .25), ('peak', .56), ('collapse', .65)]:
    rng = random.Random('pick-box-1113-' + name)
    samples = []
    previous = 0.0
    for index in range(round(RATE * duration)):
        t = index / RATE
        progress = t / duration
        envelope = min(1, t / .007) * (1 - progress) ** 2
        noise = rng.uniform(-1, 1)
        previous = previous * .7 + noise * .3
        if name == 'drop':
            value = previous * .5 + math.sin(2 * math.pi * (380 * t - 800 * t * t)) * .1
        elif name == 'impact':
            value = previous * .65 + math.sin(2 * math.pi * 115 * t) * .3
        elif name == 'perfect':
            value = sum(math.sin(2 * math.pi * hz * t) for hz in [660, 880, 1320]) * .13
        elif name == 'miss':
            value = math.sin(2 * math.pi * (280 * t - 300 * t * t)) * .22 + previous * .15
        elif name == 'peak':
            hz = [523.25, 659.25, 783.99, 1046.5][min(3, int(progress * 4))]
            value = math.sin(2 * math.pi * hz * t) * .28 * math.sin(math.pi * ((progress * 4) % 1))
        else:
            value = previous * .7 + math.sin(2 * math.pi * 72 * t) * .2
            envelope *= .65 + .35 * math.cos(2 * math.pi * 8 * t)
        samples.append(struct.pack('<h', round(max(-1, min(1, value * envelope)) * 26000)))
    with wave.open(str(ROOT / (name + '.wav')), 'wb') as output:
        output.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        output.writeframes(b''.join(samples))
print('Generated 6 original mono WAV effects.')
