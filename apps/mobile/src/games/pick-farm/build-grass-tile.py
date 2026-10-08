"""Original PICK FARM grass: one seamless top-down cell tile, repeated everywhere.

Usage: python3 build-grass-tile.py <assets-dir>
Writes grass-tile.png (one cell, 192x192) and grass-block.png (the same tile repeated
8x8, 1536x1536) used to cover the ground with few image views. Deterministic (seeded).
Pillow + NumPy: periodic value noise for colour, wrapped brush strokes for blades.
"""
import math
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
TILE = 192
SCALE = 4  # draw at 4x, downsample for soft painted edges
S = TILE * SCALE
rng = random.Random(20261006)
np_rng = np.random.default_rng(20261006)


def periodic_noise(size, cells):
    """Tileable value noise: random lattice that wraps, smooth (cosine) interpolation."""
    grid = np_rng.random((cells, cells))
    coords = np.arange(size) / size * cells
    i0 = np.floor(coords).astype(int) % cells
    i1 = (i0 + 1) % cells
    t = coords - np.floor(coords)
    t = (1 - np.cos(t * math.pi)) / 2
    a = grid[i0][:, i0] * (1 - t)[None, :] + grid[i0][:, i1] * t[None, :]
    b = grid[i1][:, i0] * (1 - t)[None, :] + grid[i1][:, i1] * t[None, :]
    return a * (1 - t)[:, None] + b * t[:, None]


noise = sum(periodic_noise(S, c) * w for c, w in [(4, 0.25), (8, 0.35), (16, 0.25), (32, 0.15)])
noise = (noise - noise.min()) / (noise.max() - noise.min())

# Warm meadow palette sampled to sit between the soil and the painted plants.
dark = np.array([104, 150, 46], float)
mid = np.array([128, 174, 58], float)
light = np.array([156, 196, 76], float)
k = noise[..., None]
base = np.where(k < 0.5, dark + (mid - dark) * (k / 0.5), mid + (light - mid) * ((k - 0.5) / 0.5))
img = Image.fromarray(base.clip(0, 255).astype('uint8'), 'RGB').convert('RGBA')

layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(layer)


def wrapped(points_fn):
    for ox in (-S, 0, S):
        for oy in (-S, 0, S):
            points_fn(ox, oy)


# Grass tufts: 3-5 tapered blades from one root, dark at the root, light at the tip.
for _ in range(260):
    x, y = rng.uniform(0, S), rng.uniform(0, S)
    shade = rng.uniform(0, 1)
    root = (int(78 + 20 * shade), int(118 + 22 * shade), 36, 170)
    tip = (int(170 + 30 * shade), int(206 + 20 * shade), int(88 + 20 * shade), 150)
    blades = []
    for _ in range(rng.randint(3, 5)):
        # The ground plane is rotated 45 degrees: plane up-left becomes screen up.
        angle = -3 * math.pi / 4 + rng.uniform(-0.75, 0.75)
        length = rng.uniform(16, 30)
        bend = rng.uniform(-0.4, 0.4)
        blades.append((angle, length, bend))

    def tuft(ox, oy, x=x, y=y, blades=blades, root=root, tip=tip):
        for angle, length, bend in blades:
            for seg in range(5):
                f0, f1 = seg / 5, (seg + 1) / 5
                a0, a1 = angle + bend * f0, angle + bend * f1
                p0 = (x + ox + math.cos(a0) * length * f0, y + oy + math.sin(a0) * length * f0)
                p1 = (x + ox + math.cos(a1) * length * f1, y + oy + math.sin(a1) * length * f1)
                c = tuple(int(root[i] + (tip[i] - root[i]) * f1) for i in range(4))
                draw.line([p0, p1], fill=c, width=max(1, round(5 * (1 - f0 * 0.8))))

    wrapped(tuft)

# Soft clover-like dabs break up the strokes without forming a recognisable motif.
for _ in range(40):
    x, y = rng.uniform(0, S), rng.uniform(0, S)
    r = rng.uniform(6, 14)
    color = rng.choice([(120, 166, 54, 60), (160, 198, 80, 50), (96, 138, 44, 50)])

    def dab(ox, oy, x=x, y=y, r=r, color=color):
        draw.ellipse((x - r + ox, y - r * 0.8 + oy, x + r + ox, y + r * 0.8 + oy), fill=color)

    wrapped(dab)

layer = layer.filter(ImageFilter.GaussianBlur(0.8))
img = Image.alpha_composite(img, layer)
tile = img.resize((TILE, TILE), Image.LANCZOS).convert('RGB')
OUT.mkdir(parents=True, exist_ok=True)
tile.save(OUT / 'grass-tile.png', optimize=True)

# Variants share the tile's wrapped base; extra details stay inside a margin, so any two
# variants still meet seamlessly. 0 plain, 1 wildflowers, 2 clover, 3 pebbles.
MARGIN = 34 * SCALE


def interior():
    return rng.uniform(MARGIN, S - MARGIN), rng.uniform(MARGIN, S - MARGIN)


def variant(kind):
    out = img.copy()
    extra = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(extra)
    if kind == 1:
        petal = rng.choice([(255, 252, 238), (255, 226, 92), (250, 196, 214)])
        cx, cy = interior()
        for _ in range(7):
            x = min(S - MARGIN, max(MARGIN, cx + rng.uniform(-110, 110)))
            y = min(S - MARGIN, max(MARGIN, cy + rng.uniform(-90, 90)))
            d.line([(x, y), (x - 8, y + 34)], fill=(84, 128, 40, 230), width=7)
            for a in range(5):
                ang = a * 2 * math.pi / 5 + rng.uniform(0, 1)
                px, py = x + math.cos(ang) * 13, y + math.sin(ang) * 13
                d.ellipse((px - 12, py - 12, px + 12, py + 12), fill=petal + (250,))
            d.ellipse((x - 8, y - 8, x + 8, y + 8), fill=(236, 170, 40, 255))
    elif kind == 2:
        for _ in range(3):
            cx, cy = interior()
            for _ in range(14):
                x, y = cx + rng.uniform(-60, 60), cy + rng.uniform(-40, 40)
                for a in range(3):
                    ang = a * 2 * math.pi / 3 + rng.uniform(0, 0.5)
                    px, py = x + math.cos(ang) * 9, y + math.sin(ang) * 9
                    d.ellipse((px - 9, py - 8, px + 9, py + 8), fill=(70, 124, 38, 170))
    elif kind == 3:
        for _ in range(5):
            x, y = interior()
            r = rng.uniform(14, 26)
            d.ellipse((x - r, y - r * 0.7 + 4, x + r, y + r * 0.7 + 4), fill=(60, 80, 30, 90))
            g = rng.randint(150, 190)
            d.ellipse((x - r, y - r * 0.7, x + r, y + r * 0.7), fill=(g, g - 6, g - 20, 255))
            d.ellipse((x - r * 0.5, y - r * 0.5, x + r * 0.1, y - r * 0.1), fill=(235, 230, 214, 150))
    extra = extra.filter(ImageFilter.GaussianBlur(0.9))
    return Image.alpha_composite(out, extra).resize((TILE, TILE), Image.LANCZOS).convert('RGB')


tiles = [tile] + [variant(k) for k in (1, 2, 3)]
block = Image.new('RGB', (TILE * 8, TILE * 8))
for by in range(8):
    for bx in range(8):
        r = rng.random()
        block.paste(tiles[0 if r < 0.55 else 1 if r < 0.7 else 2 if r < 0.87 else 3], (bx * TILE, by * TILE))
block.save(OUT / 'grass-block.png', optimize=True)
print('grass tile', tile.size, 'block', block.size)
