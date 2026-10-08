"""Original PICK FARM watering can. Usage: python3 build-watering-can.py <out.png>
Pillow shapes with cylindrical shading; the light noise layer is random per build."""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

def layer():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))

def shaded_fill(mask, base, light, dark, axis_x0, axis_x1):
    # horizontal cylindrical shading across [axis_x0, axis_x1]
    grad = Image.new('RGBA', (S, S))
    px = grad.load()
    import math
    for x in range(S):
        t = (x - axis_x0) / max(1, (axis_x1 - axis_x0))
        t = min(1, max(0, t))
        # highlight around t=0.28, darker toward right edge
        h = math.exp(-((t - 0.28) ** 2) / 0.02)
        d = t ** 2.2
        r = base[0] + (light[0] - base[0]) * h * 0.85 + (dark[0] - base[0]) * d
        g = base[1] + (light[1] - base[1]) * h * 0.85 + (dark[1] - base[1]) * d
        b = base[2] + (light[2] - base[2]) * h * 0.85 + (dark[2] - base[2]) * d
        col = (int(r), int(g), int(b), 255)
        for y in range(S):
            px[x, y] = col
    out = layer()
    out.paste(grad, (0, 0), mask)
    return out

BASE, LIGHT, DARK = (58, 140, 128), (168, 222, 205), (22, 66, 62)
RIM = (36, 92, 86)
# --- spout (behind body) ---
sp = Image.new('L', (S, S), 0)
d = ImageDraw.Draw(sp)
d.polygon([(600, 640), (640, 560), (900, 330), (930, 365)], fill=255)
d.polygon([(600, 640), (930, 365), (905, 330), (640, 560)], fill=255)
spout = shaded_fill(sp, BASE, LIGHT, DARK, 600, 930)
img = Image.alpha_composite(img, spout)
# rose (sprinkler head)
rose = layer(); dr = ImageDraw.Draw(rose)
dr.ellipse((862, 262, 972, 382), fill=(44, 108, 100, 255))
dr.ellipse((878, 276, 962, 370), fill=(120, 190, 176, 255))
for (x, y) in [(902, 300), (930, 304), (912, 326), (940, 330), (922, 350), (900, 344)]:
    dr.ellipse((x - 6, y - 6, x + 6, y + 6), fill=(30, 74, 68, 255))
rose = rose.rotate(-28, center=(917, 322))
img = Image.alpha_composite(img, rose)
# --- handle (behind body top) ---
hd = layer(); dh = ImageDraw.Draw(hd)
dh.arc((280, 170, 620, 600), start=180, end=360, fill=(36, 96, 88, 255), width=44)
dh.arc((292, 182, 608, 588), start=195, end=285, fill=(110, 186, 170, 255), width=9)
img = Image.alpha_composite(img, hd)
# --- body ---
bm = Image.new('L', (S, S), 0); db = ImageDraw.Draw(bm)
db.rounded_rectangle((250, 380, 650, 800), radius=60, fill=255)
db.ellipse((250, 330, 650, 450), fill=255)
db.ellipse((250, 740, 650, 850), fill=255)
body = shaded_fill(bm, BASE, LIGHT, DARK, 250, 650)
img = Image.alpha_composite(img, body)
# top opening rim
top = layer(); dt = ImageDraw.Draw(top)
dt.ellipse((262, 336, 638, 446), fill=RIM + (255,))
dt.ellipse((290, 352, 610, 432), fill=(18, 52, 50, 255))
dt.ellipse((300, 380, 600, 436), fill=(60, 120, 170, 255))  # water inside
dt.ellipse((340, 392, 470, 418), fill=(150, 200, 230, 200))
img = Image.alpha_composite(img, top)
# bands
bd = layer(); dbd = ImageDraw.Draw(bd)
dbd.arc((250, 470, 650, 560), start=0, end=180, fill=RIM + (255,), width=14)
dbd.arc((250, 700, 650, 800), start=0, end=180, fill=RIM + (255,), width=14)
img = Image.alpha_composite(img, bd)
# leaf emblem
lf = layer(); dl = ImageDraw.Draw(lf)
dl.ellipse((380, 560, 470, 650), fill=(246, 214, 120, 255))
dl.polygon([(425, 575), (450, 610), (425, 640), (400, 610)], fill=(92, 150, 64, 255))
img = Image.alpha_composite(img, lf)
# soft ground shadow
sh = Image.new('RGBA', (S, S), (0, 0, 0, 0)); ds = ImageDraw.Draw(sh)
ds.ellipse((230, 800, 690, 880), fill=(20, 40, 20, 90))
sh = sh.filter(ImageFilter.GaussianBlur(18))
img = Image.alpha_composite(sh, img)
import random
noise = Image.effect_noise((S, S), 22).convert('L')
tex = Image.merge('RGBA', [noise, noise, noise, img.split()[3].point(lambda a: int(a * 0.10))])
img = Image.alpha_composite(img, tex)
img = img.crop((200, 120, 1000, 900)).resize((256, 249), Image.LANCZOS)
img.save(__import__('sys').argv[1] if len(__import__('sys').argv) > 1 else 'watering-can.png')
print(img.size)
