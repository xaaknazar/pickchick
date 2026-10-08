"""Original PICK FARM v3 artwork: coop, barn, chicken, cow, goods icons, sale sign, scenery.

Usage: python3 build-v3-art.py <assets-dir>
Deterministic (seeded). Pillow + NumPy only: shapes in a small isometric helper (the game's
2:1 projection), painted with gradients, soft shadows and a light brush-noise layer, drawn
at 4x and downsampled. No third-party artwork is used.
"""
import math
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
OUT.mkdir(parents=True, exist_ok=True)
rng = random.Random(20261007)
np_rng = np.random.default_rng(20261007)
SS = 4  # supersampling


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w * SS, h * SS
        self.img = Image.new('RGBA', (self.w, self.h), (0, 0, 0, 0))

    def layer(self):
        return Image.new('RGBA', (self.w, self.h), (0, 0, 0, 0))

    def mask(self, draw_fn):
        m = Image.new('L', (self.w, self.h), 0)
        draw_fn(ImageDraw.Draw(m))
        return m

    def paint(self, mask, top, bottom=None, axis='y', box=None, grain=10):
        """Fill a mask with a linear gradient (top->bottom or left->right) plus brush grain."""
        bottom = bottom or top
        bb = box or mask.getbbox()
        if not bb:
            return
        x0, y0, x1, y1 = bb
        if axis == 'y':
            t = np.clip((np.arange(self.h) - y0) / max(1, y1 - y0), 0, 1)[:, None]
            t = np.repeat(t, self.w, axis=1)
        else:
            t = np.clip((np.arange(self.w) - x0) / max(1, x1 - x0), 0, 1)[None, :]
            t = np.repeat(t, self.h, axis=0)
        a = np.array(top[:3], float)
        b = np.array(bottom[:3], float)
        rgb = a[None, None] + (b - a)[None, None] * t[..., None]
        if grain:
            noise = np_rng.normal(0, grain, (self.h // 4 + 1, self.w // 4 + 1))
            noise = np.kron(noise, np.ones((4, 4)))[: self.h, : self.w]
            rgb = rgb + noise[..., None]
        alpha = np.array(mask, float) * ((top[3] if len(top) > 3 else 255) / 255)
        out = np.dstack([rgb.clip(0, 255), alpha]).astype('uint8')
        self.img = Image.alpha_composite(self.img, Image.fromarray(out, 'RGBA'))

    def poly(self, pts, top, bottom=None, axis='y', grain=10):
        self.paint(self.mask(lambda d: d.polygon(pts, fill=255)), top, bottom, axis, grain=grain)

    def draw(self, fn, blur=0):
        l = self.layer()
        fn(ImageDraw.Draw(l))
        if blur:
            l = l.filter(ImageFilter.GaussianBlur(blur * SS))
        self.img = Image.alpha_composite(self.img, l)

    def shadow(self, box, alpha=90, blur=10):
        def fn(d):
            d.ellipse([v * SS for v in box], fill=(24, 44, 16, alpha))

        l = self.layer()
        fn(ImageDraw.Draw(l))
        l = l.filter(ImageFilter.GaussianBlur(blur * SS))
        self.img = Image.alpha_composite(l, self.img) if False else Image.alpha_composite(self.img, l)

    def save(self, name, anchor=None):
        """Crop to content and downsample. `anchor` (a supersampled point, e.g. the yard's
        back corner) is reported in output pixels so the game can place the art exactly."""
        bb = self.img.getbbox()
        img = self.img.crop(bb)
        img = img.resize((max(1, img.width // SS), max(1, img.height // SS)), Image.LANCZOS)
        img.save(OUT / name, optimize=True)
        extra = ''
        if anchor:
            extra = f' anchor=({(anchor[0] - bb[0]) / SS:.1f}, {(anchor[1] - bb[1]) / SS:.1f})'
        print(name, img.size, extra)
        return img


class Iso:
    """Game projection: x to the lower right, y to the lower left, 2:1, z up."""

    def __init__(self, ox, oy, unit):
        self.ox, self.oy, self.u = ox * SS, oy * SS, unit * SS

    def p(self, x, y, z=0):
        return (self.ox + (x - y) * self.u, self.oy + (x + y) * self.u / 2 - z * self.u)


def shade(c, k):
    return tuple(int(max(0, min(255, v * k))) for v in c[:3]) + tuple(c[3:])


def box(cv, iso, x0, y0, x1, y1, z0, z1, top, left, right, grain=10):
    """Visible faces of a box: top, front-left (y=y1, lit) and front-right (x=x1, shade)."""
    P = iso.p
    cv.poly([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], left, shade(left, 0.82), grain=grain)
    cv.poly([P(x1, y1, z0), P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1)], right, shade(right, 0.8), grain=grain)
    if top:
        cv.poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], top, shade(top, 0.92), grain=grain)


def planks_left(cv, iso, x0, x1, y, z0, z1, step, color, width=1.2):
    """Horizontal plank seams on a front-left face."""
    def fn(d):
        z = z0 + step
        while z < z1 - 0.01:
            d.line([iso.p(x0, y, z), iso.p(x1, y, z)], fill=color, width=int(width * SS))
            z += step
    cv.draw(fn)


def planks_right(cv, iso, y0, y1, x, z0, z1, step, color, width=1.2):
    def fn(d):
        z = z0 + step
        while z < z1 - 0.01:
            d.line([iso.p(x, y1, z), iso.p(x, y0, z)], fill=color, width=int(width * SS))
            z += step
    cv.draw(fn)


def fence(cv, iso, a, b, posts, height, wood=(196, 150, 96, 255), rails=2):
    """Fence along a ground segment a->b with posts and rails."""
    (ax, ay), (bx, by) = a, b
    for i in range(posts + 1):
        t = i / posts
        x, y = ax + (bx - ax) * t, ay + (by - ay) * t
        s = 0.07
        box(cv, iso, x - s, y - s, x + s, y + s, 0, height + 0.06, shade(wood, 1.1), wood, shade(wood, 0.72), grain=6)
    for r in range(rails):
        z = height * (0.45 + 0.45 * r / max(1, rails - 1)) if rails > 1 else height * 0.7

        def fn(d, z=z):
            d.line([iso.p(ax, ay, z), iso.p(bx, by, z)], fill=shade(wood, 0.62), width=int(3.2 * SS))
            d.line([iso.p(ax, ay, z + 0.035), iso.p(bx, by, z + 0.035)], fill=shade(wood, 1.12), width=int(2.4 * SS))
        cv.draw(fn)


def yard(cv, iso, w, d, top, bottom, specks):
    P = iso.p
    cv.poly([P(0, 0), P(w, 0), P(w, d), P(0, d)], top, bottom, grain=12)

    def fn(dr):
        for _ in range(int(w * d * 22)):
            x, y = rng.uniform(0.1, w - 0.1), rng.uniform(0.1, d - 0.1)
            px, py = P(x, y)
            c = rng.choice(specks)
            ang = rng.uniform(0, math.pi)
            L = rng.uniform(4, 9) * SS
            dr.line([(px, py), (px + math.cos(ang) * L, py + math.sin(ang) * L * 0.5)], fill=c, width=int(1.4 * SS))
    cv.draw(fn, blur=0.2)


def gable_roof(cv, iso, x0, y0, x1, y1, z, rise, over, tile, gable_color, ridge_axis='x'):
    """Gable roof with the ridge along x; overhang `over`. Front-left slope and right gable."""
    P = iso.p
    ym = (y0 + y1) / 2
    # gable triangle on the right end (x = x1)
    cv.poly([P(x1, y1, z), P(x1, y0, z), P(x1, ym, z + rise)], gable_color, shade(gable_color, 0.85))
    # front slope
    pts = [P(x0 - over, y1 + over, z - over * 0.6), P(x1 + over, y1 + over, z - over * 0.6),
           P(x1 + over, ym, z + rise), P(x0 - over, ym, z + rise)]
    cv.poly(pts, shade(tile, 1.15), shade(tile, 0.85))
    # tile rows
    def fn(d):
        n = 6
        for i in range(1, n):
            t = i / n
            yy = ym + (y1 + over - ym) * t
            zz = z + rise - (rise + over * 0.6) * t
            d.line([P(x0 - over, yy, zz), P(x1 + over, yy, zz)], fill=shade(tile[:3], 0.7) + (200,), width=int(1.6 * SS))
        for i in range(1, 12):
            xx = x0 - over + (x1 - x0 + 2 * over) * i / 12
            d.line([P(xx, ym, z + rise), P(xx, y1 + over, z - over * 0.6)], fill=shade(tile[:3], 0.78) + (110,), width=int(1 * SS))
    cv.draw(fn)
    # back slope visible sliver behind ridge
    cv.poly([P(x0 - over, ym, z + rise), P(x1 + over, ym, z + rise), P(x1 + over, ym - 0.08, z + rise - 0.05),
             P(x0 - over, ym - 0.08, z + rise - 0.05)], shade(tile, 0.6))
    # right edge of the front slope (fascia) in front of the gable
    def fascia(d):
        d.line([P(x1 + over, y1 + over, z - over * 0.6), P(x1 + over, ym, z + rise)], fill=(250, 244, 226, 255), width=int(3 * SS))
        d.line([P(x1 + over, ym, z + rise), P(x1 + over, y0 - over, z - over * 0.6)], fill=(236, 228, 206, 255), width=int(3 * SS))
        d.line([P(x0 - over, ym, z + rise), P(x1 + over, ym, z + rise)], fill=shade(tile, 0.55), width=int(3 * SS))
    cv.draw(fascia)


def soft_shadow(cv, iso, pts, alpha=80, blur=6):
    l = cv.layer()
    ImageDraw.Draw(l).polygon([iso.p(*p) for p in pts], fill=(30, 50, 20, alpha))
    l = l.filter(ImageFilter.GaussianBlur(blur * SS))
    cv.img = Image.alpha_composite(cv.img, l)


def window(cv, iso, face, a, b, z0, z1, frame=(250, 244, 230, 255)):
    """Window on a face: face='left' (y fixed=a[1], x from a[0] to b[0]) or 'right'."""
    P = iso.p
    if face == 'left':
        y = a[1]
        quad = [P(a[0], y, z0), P(b[0], y, z0), P(b[0], y, z1), P(a[0], y, z1)]
        mid = [P((a[0] + b[0]) / 2, y, z0), P((a[0] + b[0]) / 2, y, z1)]
        midz = [P(a[0], y, (z0 + z1) / 2), P(b[0], y, (z0 + z1) / 2)]
    else:
        x = a[0]
        quad = [P(x, a[1], z0), P(x, b[1], z0), P(x, b[1], z1), P(x, a[1], z1)]
        mid = [P(x, (a[1] + b[1]) / 2, z0), P(x, (a[1] + b[1]) / 2, z1)]
        midz = [P(x, a[1], (z0 + z1) / 2), P(x, b[1], (z0 + z1) / 2)]
    cv.poly(quad, (60, 92, 120, 255), (120, 170, 196, 255))

    def fn(d):
        d.polygon(quad, outline=frame, width=int(2.6 * SS))
        d.line(mid, fill=frame, width=int(2 * SS))
        d.line(midz, fill=frame, width=int(2 * SS))
    cv.draw(fn)


# --------------------------------------------------------------------------------------------
def build_coop():
    W, D = 3.0, 2.4
    cv = Canvas(330, 300)
    iso = Iso(165, 70, 52)
    yard(cv, iso, W, D, (214, 190, 120, 255), (190, 160, 92, 255),
         [(236, 210, 130, 220), (170, 130, 70, 160), (246, 226, 160, 200)])
    # back fences
    fence(cv, iso, (0, 0), (W, 0), 6, 0.42)
    fence(cv, iso, (0, 0), (0, D), 5, 0.42)
    # coop house: raised on legs at the back-left corner
    hx0, hy0, hx1, hy1 = 0.15, 0.15, 1.65, 1.15
    soft_shadow(cv, iso, [(hx0, hy0 + 0.2), (hx1 + 0.3, hy0 + 0.2), (hx1 + 0.3, hy1 + 0.35), (hx0, hy1 + 0.35)], 90, 5)
    wood = (200, 120, 70, 255)
    for (x, y) in [(hx0 + 0.08, hy1 - 0.08), (hx1 - 0.08, hy1 - 0.08), (hx1 - 0.08, hy0 + 0.08)]:
        box(cv, iso, x - 0.06, y - 0.06, x + 0.06, y + 0.06, 0, 0.32, None, (120, 80, 50, 255), (90, 60, 40, 255))
    box(cv, iso, hx0, hy0, hx1, hy1, 0.3, 1.25, None, wood, shade(wood, 0.78))
    planks_left(cv, iso, hx0, hx1, hy1, 0.3, 1.25, 0.16, (130, 70, 40, 200))
    planks_right(cv, iso, hy0, hy1, hx1, 0.3, 1.25, 0.16, (110, 60, 36, 200))
    # trim
    def trim(d):
        P = iso.p
        for pts in ([P(hx0, hy1, 0.3), P(hx0, hy1, 1.25)], [P(hx1, hy1, 0.3), P(hx1, hy1, 1.25)],
                    [P(hx1, hy0, 0.3), P(hx1, hy0, 1.25)]):
            d.line(pts, fill=(250, 240, 220, 255), width=int(3 * SS))
    cv.draw(trim)
    # little arched door on the front-left face
    P = iso.p
    door = [P(0.95, hy1, 0.3), P(1.35, hy1, 0.3), P(1.35, hy1, 0.78), P(1.15, hy1, 0.9), P(0.95, hy1, 0.78)]
    cv.poly(door, (60, 36, 24, 255), (36, 22, 14, 255))
    window(cv, iso, 'left', (0.35, hy1), (0.72, hy1), 0.72, 1.05)
    window(cv, iso, 'right', (hx1, 0.45), (hx1, 0.85), 0.72, 1.02)
    # ramp from the door to the yard
    cv.poly([P(0.98, hy1, 0.3), P(1.32, hy1, 0.3), P(1.32, hy1 + 0.75, 0), P(0.98, hy1 + 0.75, 0)],
            (210, 160, 100, 255), (170, 120, 70, 255))
    def ramp(d):
        for i in range(1, 5):
            t = i / 5
            d.line([P(0.98, hy1 + 0.75 * t, 0.3 * (1 - t)), P(1.32, hy1 + 0.75 * t, 0.3 * (1 - t))],
                   fill=(120, 80, 46, 255), width=int(2 * SS))
    cv.draw(ramp)
    gable_roof(cv, iso, hx0, hy0, hx1, hy1, 1.25, 0.62, 0.12, (196, 64, 48, 255), (220, 170, 110, 255))
    # nest box with straw on the right side
    box(cv, iso, hx1, 0.35, hx1 + 0.38, 0.95, 0.42, 0.78, (230, 196, 120, 255), (196, 130, 80, 255), (150, 96, 60, 255))
    # straw piles and a feeder trough in the yard
    for (x, y, r) in [(2.5, 0.5, 0.28), (2.2, 0.32, 0.2)]:
        cx, cy = P(x, y)
        cv.draw(lambda d, cx=cx, cy=cy, r=r: d.ellipse((cx - r * iso.u, cy - r * iso.u * 0.55, cx + r * iso.u, cy + r * iso.u * 0.45), fill=(232, 200, 110, 255)))
    box(cv, iso, 1.9, 1.75, 2.75, 1.95, 0, 0.16, (120, 84, 50, 255), (170, 120, 70, 255), (130, 90, 56, 255))
    cv.poly([P(1.95, 1.8, 0.16), P(2.7, 1.8, 0.16), P(2.7, 1.9, 0.16), P(1.95, 1.9, 0.16)], (236, 176, 70, 255))
    # front fences
    fence(cv, iso, (W, 0), (W, D), 5, 0.42)
    fence(cv, iso, (0, D), (W, D), 6, 0.42)
    return cv.save('coop.png', iso.p(0, 0))


def build_barn():
    W, D = 3.6, 3.0
    cv = Canvas(400, 380)
    iso = Iso(200, 92, 52)
    yard(cv, iso, W, D, (176, 162, 104, 255), (150, 134, 84, 255),
         [(214, 196, 130, 200), (120, 100, 60, 150), (106, 140, 60, 140)])
    fence(cv, iso, (0, 0), (W, 0), 6, 0.52, wood=(170, 130, 90, 255), rails=3)
    fence(cv, iso, (0, 0), (0, D), 5, 0.52, wood=(170, 130, 90, 255), rails=3)
    hx0, hy0, hx1, hy1 = 0.15, 0.15, 2.25, 1.55
    soft_shadow(cv, iso, [(hx0, hy0 + 0.2), (hx1 + 0.4, hy0 + 0.2), (hx1 + 0.4, hy1 + 0.45), (hx0, hy1 + 0.45)], 90, 6)
    red = (178, 50, 44, 255)
    box(cv, iso, hx0, hy0, hx1, hy1, 0, 1.45, None, red, shade(red, 0.76))
    # vertical boards
    def boards(d):
        P = iso.p
        n = 14
        for i in range(1, n):
            x = hx0 + (hx1 - hx0) * i / n
            d.line([P(x, hy1, 0), P(x, hy1, 1.45)], fill=(130, 34, 30, 180), width=int(1.2 * SS))
        for i in range(1, 9):
            y = hy0 + (hy1 - hy0) * i / 9
            d.line([P(hx1, y, 0), P(hx1, y, 1.45)], fill=(110, 28, 26, 180), width=int(1.2 * SS))
        white = (250, 246, 236, 255)
        for pts in ([P(hx0, hy1, 0), P(hx0, hy1, 1.45)], [P(hx1, hy1, 0), P(hx1, hy1, 1.45)],
                    [P(hx1, hy0, 0), P(hx1, hy0, 1.45)], [P(hx0, hy1, 1.45), P(hx1, hy1, 1.45)],
                    [P(hx1, hy1, 1.45), P(hx1, hy0, 1.45)]):
            d.line(pts, fill=white, width=int(3.4 * SS))
    cv.draw(boards)
    P = iso.p
    # big double door with white X braces on the front-left face
    dx0, dx1 = 0.85, 1.6
    cv.poly([P(dx0, hy1, 0), P(dx1, hy1, 0), P(dx1, hy1, 1.0), P(dx0, hy1, 1.0)], (150, 40, 36, 255), (120, 30, 28, 255))
    def door(d):
        white = (250, 246, 236, 255)
        dm = (dx0 + dx1) / 2
        w = int(3 * SS)
        d.polygon([P(dx0, hy1, 0), P(dx1, hy1, 0), P(dx1, hy1, 1.0), P(dx0, hy1, 1.0)], outline=white, width=w)
        d.line([P(dm, hy1, 0), P(dm, hy1, 1.0)], fill=white, width=w)
        for a, b in ((dx0, dm), (dm, dx1)):
            d.line([P(a, hy1, 0), P(b, hy1, 1.0)], fill=white, width=w)
            d.line([P(a, hy1, 1.0), P(b, hy1, 0)], fill=white, width=w)
    cv.draw(door)
    # hay loft window
    cv.poly([P(1.05, hy1, 1.12), P(1.4, hy1, 1.12), P(1.4, hy1, 1.38), P(1.05, hy1, 1.38)], (90, 60, 30, 255))
    cv.draw(lambda d: d.polygon([P(1.05, hy1, 1.12), P(1.4, hy1, 1.12), P(1.4, hy1, 1.38), P(1.05, hy1, 1.38)],
                               outline=(250, 246, 236, 255), width=int(2.4 * SS)))
    cv.poly([P(1.08, hy1, 1.13), P(1.37, hy1, 1.13), P(1.3, hy1, 1.24), P(1.12, hy1, 1.22)], (236, 196, 96, 255))
    window(cv, iso, 'right', (hx1, 0.5), (hx1, 0.95), 0.62, 1.0)
    gable_roof(cv, iso, hx0, hy0, hx1, hy1, 1.45, 0.85, 0.14, (88, 70, 66, 255), (178, 50, 44, 255))
    # gable trim and round vent on the right gable
    def vent(d):
        cx, cy = P(hx1, (hy0 + hy1) / 2, 1.78)
        r = 0.16 * iso.u
        d.ellipse((cx - r * 0.7, cy - r, cx + r * 0.7, cy + r), fill=(250, 246, 236, 255))
        d.ellipse((cx - r * 0.5, cy - r * 0.75, cx + r * 0.5, cy + r * 0.75), fill=(70, 40, 30, 255))
    cv.draw(vent)
    # hay bales and a water trough in the yard
    for (x, y) in [(2.85, 0.45), (3.15, 0.75)]:
        box(cv, iso, x - 0.22, y - 0.16, x + 0.22, y + 0.16, 0, 0.3, (236, 206, 112, 255), (220, 184, 92, 255), (190, 150, 70, 255))
        def straw(d, x=x, y=y):
            for i in range(4):
                z = 0.06 + i * 0.06
                d.line([P(x - 0.22, y + 0.16, z), P(x + 0.22, y + 0.16, z)], fill=(200, 160, 70, 200), width=int(1 * SS))
        cv.draw(straw)
    box(cv, iso, 2.5, 2.2, 3.3, 2.55, 0, 0.22, (110, 120, 128, 255), (150, 160, 168, 255), (110, 118, 126, 255))
    cv.poly([P(2.55, 2.25, 0.22), P(3.25, 2.25, 0.22), P(3.25, 2.5, 0.22), P(2.55, 2.5, 0.22)], (96, 160, 200, 255), (140, 200, 230, 255))
    fence(cv, iso, (W, 0), (W, D), 5, 0.52, wood=(170, 130, 90, 255), rails=3)
    fence(cv, iso, (0, D), (W, D), 6, 0.52, wood=(170, 130, 90, 255), rails=3)
    return cv.save('barn.png', iso.p(0, 0))


def build_chicken():
    cv = Canvas(120, 120)
    s = SS
    cv.shadow((28, 98, 92, 112), alpha=80, blur=3)
    # legs
    cv.draw(lambda d: [d.line([(x * s, 82 * s), (x * s - 2 * s, 100 * s)], fill=(236, 150, 40, 255), width=int(3.4 * s)) for x in (52, 64)])
    cv.draw(lambda d: [d.line([(x * s - 8 * s, 101 * s), (x * s + 4 * s, 101 * s)], fill=(236, 150, 40, 255), width=int(3 * s)) for x in (52, 64)])
    # tail
    cv.poly([(18 * s, 30 * s), (36 * s, 52 * s), (30 * s, 74 * s), (12 * s, 50 * s)], (250, 250, 244, 255), (214, 210, 196, 255))
    cv.poly([(26 * s, 24 * s), (42 * s, 48 * s), (24 * s, 52 * s)], (240, 238, 230, 255), (200, 196, 182, 255))
    # body
    body = cv.mask(lambda d: d.ellipse((22 * s, 40 * s, 92 * s, 92 * s), fill=255))
    cv.paint(body, (255, 255, 250, 255), (206, 200, 186, 255))
    # head and neck
    head = cv.mask(lambda d: (d.ellipse((66 * s, 18 * s, 96 * s, 50 * s), fill=255), d.polygon([(70 * s, 40 * s), (92 * s, 40 * s), (88 * s, 66 * s), (66 * s, 62 * s)], fill=255)))
    cv.paint(head, (255, 255, 252, 255), (226, 222, 210, 255))
    # comb, wattle, beak, eye
    cv.draw(lambda d: [d.ellipse((x * s, y * s, (x + 11) * s, (y + 12) * s), fill=(220, 40, 40, 255)) for x, y in [(70, 10), (78, 7), (86, 11)]])
    cv.draw(lambda d: d.ellipse((90 * s, 38 * s, 99 * s, 52 * s), fill=(214, 36, 36, 255)))
    cv.poly([(94 * s, 28 * s), (108 * s, 33 * s), (94 * s, 38 * s)], (250, 196, 60, 255), (226, 150, 30, 255))
    cv.draw(lambda d: (d.ellipse((84 * s, 25 * s, 91 * s, 32 * s), fill=(30, 26, 24, 255)), d.ellipse((86 * s, 26 * s, 88 * s, 28 * s), fill=(255, 255, 255, 255))))
    # wing
    wing = cv.mask(lambda d: d.chord((36 * s, 50 * s, 78 * s, 84 * s), 180, 360 + 40, fill=255))
    cv.paint(wing, (240, 236, 224, 255), (196, 190, 176, 255))
    cv.draw(lambda d: [d.arc((40 * s, (54 + i * 7) * s, 76 * s, (78 + i * 4) * s), 200, 330, fill=(190, 184, 170, 255), width=int(1.6 * s)) for i in range(3)])
    return cv.save('chicken.png')


def build_cow():
    cv = Canvas(200, 160)
    s = SS
    cv.shadow((30, 136, 176, 154), alpha=80, blur=4)
    # legs (back pair darker)
    for x, dark in [(56, True), (128, True), (46, False), (118, False)]:
        c = (200, 196, 190, 255) if dark else (244, 242, 236, 255)
        cv.draw(lambda d, x=x, c=c: (d.rounded_rectangle((x * s, 96 * s, (x + 14) * s, 142 * s), radius=5 * s, fill=c),
                                     d.rounded_rectangle((x * s, 134 * s, (x + 14) * s, 146 * s), radius=3 * s, fill=(70, 56, 50, 255))))
    # tail
    cv.draw(lambda d: (d.line([(30 * s, 60 * s), (20 * s, 104 * s)], fill=(220, 214, 206, 255), width=int(4 * s)),
                       d.ellipse((14 * s, 100 * s, 26 * s, 116 * s), fill=(60, 50, 46, 255))))
    # body with patches clipped to it
    body = cv.mask(lambda d: d.rounded_rectangle((30 * s, 48 * s, 150 * s, 112 * s), radius=30 * s, fill=255))
    cv.paint(body, (255, 255, 252, 255), (214, 210, 204, 255))
    spots = cv.mask(lambda d: [d.ellipse((x * s, y * s, (x + w) * s, (y + h) * s), fill=255)
                               for x, y, w, h in [(44, 50, 36, 28), (92, 70, 40, 30), (60, 86, 24, 18), (118, 50, 22, 18)]])
    spots = Image.fromarray(np.minimum(np.array(spots), np.array(body)).astype('uint8'), 'L')
    cv.paint(spots, (48, 42, 40, 255), (28, 24, 22, 255))
    # udder
    cv.draw(lambda d: d.ellipse((92 * s, 104 * s, 116 * s, 120 * s), fill=(244, 170, 170, 255)))
    # head
    head = cv.mask(lambda d: d.rounded_rectangle((136 * s, 30 * s, 182 * s, 84 * s), radius=18 * s, fill=255))
    cv.paint(head, (255, 255, 252, 255), (220, 216, 208, 255))
    cv.draw(lambda d: d.ellipse((150 * s, 28 * s, 176 * s, 52 * s), fill=(48, 42, 40, 255)))
    # horns and ears
    cv.draw(lambda d: (d.polygon([(142 * s, 34 * s), (136 * s, 18 * s), (148 * s, 30 * s)], fill=(246, 230, 196, 255)),
                       d.polygon([(176 * s, 34 * s), (184 * s, 18 * s), (172 * s, 30 * s)], fill=(246, 230, 196, 255)),
                       d.ellipse((124 * s, 36 * s, 142 * s, 48 * s), fill=(236, 226, 216, 255)),
                       d.ellipse((178 * s, 36 * s, 196 * s, 48 * s), fill=(214, 204, 194, 255))))
    # muzzle, nostrils, eyes
    muzzle = cv.mask(lambda d: d.rounded_rectangle((140 * s, 62 * s, 184 * s, 90 * s), radius=13 * s, fill=255))
    cv.paint(muzzle, (250, 196, 190, 255), (226, 150, 146, 255))
    cv.draw(lambda d: (d.ellipse((150 * s, 72 * s, 156 * s, 78 * s), fill=(150, 80, 80, 255)), d.ellipse((168 * s, 72 * s, 174 * s, 78 * s), fill=(150, 80, 80, 255)),
                       d.ellipse((146 * s, 50 * s, 154 * s, 58 * s), fill=(28, 24, 22, 255)), d.ellipse((166 * s, 50 * s, 174 * s, 58 * s), fill=(28, 24, 22, 255)),
                       d.ellipse((148 * s, 51 * s, 151 * s, 54 * s), fill=(255, 255, 255, 255)), d.ellipse((168 * s, 51 * s, 171 * s, 54 * s), fill=(255, 255, 255, 255))))
    # bell
    cv.draw(lambda d: (d.line([(140 * s, 86 * s), (178 * s, 86 * s)], fill=(160, 60, 40, 255), width=int(3 * s)),
                       d.ellipse((152 * s, 86 * s, 166 * s, 100 * s), fill=(240, 196, 70, 255))))
    return cv.save('cow.png')


def build_egg():
    cv = Canvas(96, 96)
    s = SS
    cv.shadow((22, 80, 74, 92), alpha=70, blur=3)
    egg = cv.mask(lambda d: d.ellipse((24 * s, 10 * s, 72 * s, 84 * s), fill=255))
    cv.paint(egg, (255, 248, 232, 255), (228, 204, 168, 255), axis='x', grain=4)
    cv.draw(lambda d: d.ellipse((34 * s, 20 * s, 48 * s, 40 * s), fill=(255, 255, 255, 190)), blur=1.2)
    return cv.save('egg.png')


def build_milk():
    cv = Canvas(96, 120)
    s = SS
    cv.shadow((20, 104, 76, 116), alpha=70, blur=3)
    bottle = cv.mask(lambda d: (d.rounded_rectangle((24 * s, 40 * s, 72 * s, 110 * s), radius=12 * s, fill=255),
                                d.polygon([(34 * s, 22 * s), (62 * s, 22 * s), (72 * s, 46 * s), (24 * s, 46 * s)], fill=255)))
    cv.paint(bottle, (255, 255, 255, 255), (220, 228, 236, 255), axis='x', grain=3)
    cv.draw(lambda d: d.rounded_rectangle((32 * s, 8 * s, 64 * s, 24 * s), radius=4 * s, fill=(60, 120, 200, 255)))
    cv.draw(lambda d: d.rounded_rectangle((24 * s, 62 * s, 72 * s, 88 * s), radius=2 * s, fill=(70, 130, 210, 255)))
    cv.draw(lambda d: d.ellipse((40 * s, 66 * s, 56 * s, 84 * s), fill=(255, 255, 255, 255)))
    cv.draw(lambda d: d.rounded_rectangle((30 * s, 44 * s, 36 * s, 104 * s), radius=3 * s, fill=(255, 255, 255, 170)), blur=0.8)
    return cv.save('milk.png')


def build_sign():
    cv = Canvas(150, 140)
    s = SS
    cv.shadow((40, 122, 110, 136), alpha=80, blur=3)
    for x in (52, 98):
        post = cv.mask(lambda d, x=x: d.rounded_rectangle((x * s, 40 * s, (x + 10) * s, 130 * s), radius=3 * s, fill=255))
        cv.paint(post, (150, 100, 60, 255), (100, 66, 40, 255), axis='x')
    board = cv.mask(lambda d: d.rounded_rectangle((14 * s, 14 * s, 136 * s, 86 * s), radius=10 * s, fill=255))
    cv.paint(board, (232, 186, 120, 255), (196, 140, 80, 255))
    cv.draw(lambda d: [d.line([(18 * s, y * s), (132 * s, y * s)], fill=(176, 120, 70, 180), width=int(1.4 * s)) for y in (38, 62)])
    cv.draw(lambda d: d.rounded_rectangle((14 * s, 14 * s, 136 * s, 86 * s), radius=10 * s, outline=(120, 76, 44, 255), width=int(3 * s)))
    cv.draw(lambda d: [d.ellipse((x * s, 20 * s, (x + 6) * s, 26 * s), fill=(96, 70, 50, 255)) for x in (22, 122)])
    return cv.save('sale-sign.png', (75 * SS, 130 * SS))


def blob(d, cx, cy, r, color, k=0.86):
    d.ellipse((cx - r, cy - r * k, cx + r, cy + r * k), fill=color)


def build_bush(name, seed, w=150, h=110, berries=None):
    r = random.Random(seed)
    cv = Canvas(w, h)
    s = SS
    cv.shadow((10, h - 30, w - 10, h - 4), alpha=90, blur=4)
    parts = []
    for _ in range(14):
        x = r.uniform(30, w - 30)
        y = r.uniform(34, h - 34)
        parts.append((x, y, r.uniform(16, 28)))
    parts.sort(key=lambda p: p[1])
    for x, y, rad in parts:
        cv.draw(lambda d, x=x, y=y, rad=rad: blob(d, x * s, (y + 3) * s, rad * s, (52, 98, 34, 255)))
        m = cv.mask(lambda d, x=x, y=y, rad=rad: blob(d, x * s, y * s, rad * s, 255))
        cv.paint(m, (132, 182, 70, 255), (66, 118, 40, 255), grain=3)
        cv.draw(lambda d, x=x, y=y, rad=rad: blob(d, (x - rad * 0.3) * s, (y - rad * 0.4) * s, rad * 0.45 * s, (176, 214, 108, 120)), blur=1.5)
    if berries:
        for _ in range(12):
            x, y = r.uniform(30, w - 30), r.uniform(28, h - 36)
            cv.draw(lambda d, x=x, y=y: (d.ellipse(((x - 4) * s, (y - 4) * s, (x + 4) * s, (y + 4) * s), fill=berries),
                                         d.ellipse(((x - 2) * s, (y - 3) * s, (x) * s, (y - 1) * s), fill=(255, 255, 255, 200))))
    return cv.save(name)


def build_rock(name, seed):
    r = random.Random(seed)
    cv = Canvas(110, 80)
    s = SS
    cv.shadow((8, 50, 104, 76), alpha=90, blur=3)
    pts = []
    for i in range(9):
        a = math.pi + i * math.pi / 8
        rad = r.uniform(34, 46)
        pts.append(((55 + math.cos(a) * rad) * s, (58 + math.sin(a) * rad * 0.9) * s))
    pts += [(96 * s, 62 * s), (14 * s, 62 * s)]
    cv.poly(pts, (196, 196, 186, 255), (120, 120, 116, 255))
    cv.draw(lambda d: d.polygon([(30 * s, 34 * s), (56 * s, 22 * s), (70 * s, 30 * s), (44 * s, 44 * s)], fill=(236, 236, 226, 120)), blur=1.5)
    cv.draw(lambda d: [d.ellipse(((x - 6) * s, (y - 3) * s, (x + 6) * s, (y + 3) * s), fill=(118, 160, 64, 200)) for x, y in [(36, 30), (44, 28), (70, 52)]])
    return cv.save(name)


def build_flowers(name, seed, colors):
    r = random.Random(seed)
    cv = Canvas(110, 80)
    s = SS
    cv.shadow((10, 52, 100, 76), alpha=50, blur=4)
    for _ in range(16):
        x, y = r.uniform(18, 92), r.uniform(28, 64)
        c = r.choice(colors)
        cv.draw(lambda d, x=x, y=y: d.line([(x * s, y * s), ((x + r.uniform(-3, 3)) * s, (y + 14) * s)], fill=(70, 120, 40, 255), width=int(2 * s)))
        cv.draw(lambda d, x=x, y=y: blob(d, (x - 6) * s, (y + 8) * s, 5 * s, (90, 150, 50, 255), 0.5))
        for a in range(5):
            ang = a * 2 * math.pi / 5
            px, py = x + math.cos(ang) * 4.5, y + math.sin(ang) * 3.6
            cv.draw(lambda d, px=px, py=py, c=c: d.ellipse(((px - 3.6) * s, (py - 3.2) * s, (px + 3.6) * s, (py + 3.2) * s), fill=c))
        cv.draw(lambda d, x=x, y=y: d.ellipse(((x - 2) * s, (y - 2) * s, (x + 2) * s, (y + 2) * s), fill=(250, 210, 80, 255)))
    return cv.save(name)


def build_tree(name, seed, w=220, h=260, tone=1.0):
    r = random.Random(seed)
    cv = Canvas(w, h)
    s = SS
    cx = w / 2
    cv.shadow((cx - 70, h - 34, cx + 70, h - 6), alpha=90, blur=5)
    trunk = cv.mask(lambda d: d.polygon([((cx - 12) * s, (h - 20) * s), ((cx + 12) * s, (h - 20) * s), ((cx + 7) * s, (h - 96) * s), ((cx - 7) * s, (h - 96) * s)], fill=255))
    cv.paint(trunk, (140, 96, 60, 255), (90, 60, 40, 255), axis='x')
    parts = []
    for _ in range(34):
        a = r.uniform(0, 2 * math.pi)
        d = r.uniform(0, 1) ** 0.5
        parts.append((cx + math.cos(a) * d * 58, h - 140 + math.sin(a) * d * 52, r.uniform(28, 42)))
    parts.sort(key=lambda p: p[1])
    base = tuple(int(c * tone) for c in (122, 174, 66))
    dark = tuple(int(c * tone) for c in (54, 100, 38))
    for x, y, rad in parts:
        cv.draw(lambda d, x=x, y=y, rad=rad: blob(d, x * s, (y + 4) * s, rad * s, dark + (255,), 0.9))
        m = cv.mask(lambda d, x=x, y=y, rad=rad: blob(d, x * s, y * s, rad * s, 255, 0.9))
        cv.paint(m, base + (255,), dark + (255,), grain=3)
        cv.draw(lambda d, x=x, y=y, rad=rad: blob(d, (x - rad * 0.35) * s, (y - rad * 0.4) * s, rad * 0.4 * s, (186, 222, 120, 110)), blur=2)
    return cv.save(name)


def build_pond():
    cv = Canvas(300, 170)
    iso = Iso(150, 20, 48)
    P = iso.p
    pts = []
    for i in range(24):
        a = i * 2 * math.pi / 24
        rad = 1.15 + 0.18 * math.sin(a * 3 + 1) + 0.08 * math.cos(a * 5)
        pts.append(P(1.5 + math.cos(a) * rad, 1.5 + math.sin(a) * rad))
    cv.poly(pts, (150, 136, 100, 255), (120, 108, 80, 255))
    inner = []
    for i in range(24):
        a = i * 2 * math.pi / 24
        rad = 1.0 + 0.16 * math.sin(a * 3 + 1) + 0.07 * math.cos(a * 5)
        inner.append(P(1.5 + math.cos(a) * rad, 1.5 + math.sin(a) * rad))
    cv.poly(inner, (64, 128, 170, 255), (110, 180, 214, 255))
    cv.draw(lambda d: [d.arc((P(1.1 + i * 0.3, 1.1)[0] - 40, P(1.1, 1.1 + i * 0.3)[1] - 10, P(1.1 + i * 0.3, 1.1)[0] + 40, P(1.1, 1.1 + i * 0.3)[1] + 10), 200, 340, fill=(220, 240, 250, 160), width=int(2 * SS)) for i in range(3)], blur=0.4)
    for (x, y) in [(1.0, 1.9), (2.0, 1.3)]:
        cx, cy = P(x, y)
        cv.draw(lambda d, cx=cx, cy=cy: (d.ellipse((cx - 30, cy - 14, cx + 30, cy + 14), fill=(84, 150, 60, 255)),
                                        d.pieslice((cx - 30, cy - 14, cx + 30, cy + 14), 300, 330, fill=(64, 128, 170, 255))))
    cx, cy = P(1.0, 1.9)
    cv.draw(lambda d: [d.ellipse((cx - 10 + dx, cy - 12 + dy, cx + 10 + dx, cy + dy), fill=(250, 200, 220, 255)) for dx, dy in [(-8, 0), (8, 0), (0, -6)]])
    # reeds and rocks on the far rim
    for i in range(10):
        a = math.pi * 1.1 + i * 0.09
        bx, by = P(1.5 + math.cos(a) * 1.25, 1.5 + math.sin(a) * 1.25)
        cv.draw(lambda d, bx=bx, by=by, i=i: d.line([(bx, by), (bx + (i % 3 - 1) * 8, by - 70 - (i % 4) * 12)], fill=(76, 120, 46, 255), width=int(2.4 * SS)))
        if i % 3 == 0:
            cv.draw(lambda d, bx=bx, by=by, i=i: d.ellipse((bx + (i % 3 - 1) * 8 - 6, by - 90 - (i % 4) * 12, bx + (i % 3 - 1) * 8 + 6, by - 60 - (i % 4) * 12), fill=(120, 80, 50, 255)))
    return cv.save('pond.png', iso.p(1.5, 1.5))


build_coop()
build_barn()
build_chicken()
build_cow()
build_egg()
build_milk()
build_sign()
build_bush('bush-a.png', 1)
build_bush('bush-b.png', 2, berries=(214, 40, 60, 255))
build_rock('rock.png', 3)
build_flowers('flowers-a.png', 4, [(255, 250, 240, 255), (250, 220, 90, 255)])
build_flowers('flowers-b.png', 5, [(236, 120, 170, 255), (180, 140, 230, 255), (255, 250, 240, 255)])
build_tree('tree-round.png', 6)
build_tree('tree-dark.png', 7, tone=0.82)
build_pond()
