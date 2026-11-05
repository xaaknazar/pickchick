#!/usr/bin/env python3
"""Android adaptive icon layers from the App Store icon art (apps/mobile/assets/app-icon.png).

The iOS icon is the orange PickChick sticker on the brand blue. Android masks a 108 dp layer to a
circle, squircle or rounded square and only guarantees the centre 66 dp circle, so the sticker is
keyed out of the blue and scaled until every sticker pixel lies inside that safe circle. The blue
becomes the adaptive background colour (`android.adaptiveIcon.backgroundColor` in app.json).

Outputs (committed, 1024 px = 108 dp):
- adaptive-icon-foreground.png - the sticker on transparency;
- adaptive-icon-monochrome.png - Android 13 themed icon: the sticker silhouette with the white
  lettering and rooster cut out (the launcher tints it);
- notification-icon.png - the same silhouette for the push notification status bar icon.

`--preview DIR` also writes the icon under the common launcher masks for a visual check (not
committed). Requires Pillow. Run: python3 scripts/mobile/android_adaptive_icon.py
"""

import argparse
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "apps/mobile/assets/app-icon.png"
OUTPUT = ROOT / "apps/mobile/assets/android"
SIZE = 1024
# Brand blue of the App Store icon background (sampled; the art has a faint gradient).
BACKGROUND = (0, 66, 224)
# Android: 108 dp layer, 66 dp guaranteed safe circle. Keep a small margin inside it.
SAFE_RADIUS = SIZE * 33 / 108
MARGIN = 0.97


def sticker_alpha(image):
    """Soft alpha: 0 on the blue background, 255 on the sticker, a ramp across the edge."""
    pixels = image.load()
    alpha = Image.new("L", image.size, 0)
    out = alpha.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b = pixels[x, y]
            distance = math.sqrt((r - BACKGROUND[0]) ** 2 + (g - BACKGROUND[1]) ** 2
                                 + (b - BACKGROUND[2]) ** 2)
            out[x, y] = max(0, min(255, int((distance - 40) * 255 / 120)))
    return alpha


def white_alpha(image):
    """The white lettering and rooster inside the sticker."""
    red, green, blue = image.split()
    # White has every channel high; orange (low blue) and the blue background do not.
    low = ImageChops.darker(ImageChops.darker(red, green), blue)
    return low.point(lambda value: max(0, min(255, (value - 170) * 4))).filter(
        ImageFilter.GaussianBlur(0.6))


def farthest_radius(alpha):
    """Largest distance from the canvas centre to a visible sticker pixel."""
    box = alpha.point(lambda value: 255 if value > 24 else 0)
    pixels = box.load()
    centre = (box.width / 2, box.height / 2)
    best = 0.0
    for y in range(0, box.height, 2):
        for x in range(0, box.width, 2):
            if pixels[x, y]:
                best = max(best, math.hypot(x - centre[0], y - centre[1]))
    return best


def layers():
    art = Image.open(SOURCE).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    alpha = sticker_alpha(art)
    # Centre the sticker's bounding box before scaling, so the safe circle is used evenly.
    left, top, right, bottom = alpha.point(lambda value: 255 if value > 24 else 0).getbbox()
    shift = (SIZE / 2 - (left + right) / 2, SIZE / 2 - (top + bottom) / 2)
    art = ImageChops.offset(art, round(shift[0]), round(shift[1]))
    alpha = ImageChops.offset(alpha, round(shift[0]), round(shift[1]))
    scale = MARGIN * SAFE_RADIUS / farthest_radius(alpha)
    foreground = art.convert("RGBA")
    foreground.putalpha(alpha)
    side = round(SIZE * scale)
    small = foreground.resize((side, side), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(small, ((SIZE - side) // 2, (SIZE - side) // 2))
    # Monochrome: silhouette minus the white artwork.
    white = white_alpha(art.resize((side, side), Image.LANCZOS))
    silhouette = alpha.resize((side, side), Image.LANCZOS)
    mono_alpha = ImageChops.subtract(silhouette, white)
    mono = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glyph = Image.new("RGBA", (side, side), (255, 255, 255, 255))
    glyph.putalpha(mono_alpha)
    mono.alpha_composite(glyph, ((SIZE - side) // 2, (SIZE - side) // 2))
    return canvas, mono, scale


def masks():
    """Launcher masks over the 108 dp layer (visible 72 dp viewport)."""
    viewport = SIZE * 72 / 108
    inset = (SIZE - viewport) / 2
    shapes = {}
    for name in ("circle", "squircle", "rounded-square", "teardrop"):
        mask = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(mask)
        box = (inset, inset, SIZE - inset, SIZE - inset)
        if name == "circle":
            draw.ellipse(box, fill=255)
        elif name == "rounded-square":
            draw.rounded_rectangle(box, radius=viewport * 0.16, fill=255)
        elif name == "squircle":
            draw.rounded_rectangle(box, radius=viewport * 0.38, fill=255)
        else:
            draw.rounded_rectangle(box, radius=viewport * 0.5, fill=255)
            draw.rectangle((SIZE / 2, SIZE / 2, SIZE - inset, SIZE - inset), fill=255)
        shapes[name] = mask
    return shapes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", help="Directory for masked previews (outside Git)")
    args = parser.parse_args()
    foreground, monochrome, scale = layers()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    foreground.save(OUTPUT / "adaptive-icon-foreground.png", optimize=True)
    monochrome.save(OUTPUT / "adaptive-icon-monochrome.png", optimize=True)
    # Status bar icon of push notifications: white silhouette on transparency, 96 px (24 dp
    # at xxxhdpi), the sticker filling 22 dp of it.
    mark = monochrome.crop(monochrome.getchannel("A").getbbox())
    side = round(96 * 22 / 24)
    mark.thumbnail((side, side), Image.LANCZOS)
    notification = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    notification.alpha_composite(mark, ((96 - mark.width) // 2, (96 - mark.height) // 2))
    notification.save(OUTPUT / "notification-icon.png", optimize=True)
    print(f"sticker scale {scale:.3f}; safe radius {SAFE_RADIUS:.0f} px of {SIZE}")
    if args.preview:
        preview = Path(args.preview)
        preview.mkdir(parents=True, exist_ok=True)
        tiles = []
        for name, mask in masks().items():
            icon = Image.new("RGBA", (SIZE, SIZE), BACKGROUND + (255,))
            icon.alpha_composite(foreground)
            shaped = Image.new("RGBA", (SIZE, SIZE), (236, 236, 236, 255))
            shaped.paste(icon, (0, 0), mask)
            tiles.append(shaped.crop((170, 170, SIZE - 170, SIZE - 170)))
            themed = Image.new("RGBA", (SIZE, SIZE), (236, 236, 236, 255))
            tinted = Image.new("RGBA", (SIZE, SIZE), (214, 227, 255, 255))
            tinted.alpha_composite(Image.composite(
                Image.new("RGBA", (SIZE, SIZE), (24, 52, 120, 255)),
                Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), monochrome.getchannel("A")))
            themed.paste(tinted, (0, 0), mask)
            tiles.append(themed.crop((170, 170, SIZE - 170, SIZE - 170)))
        sheet = Image.new("RGBA", (tiles[0].width * 4, tiles[0].height * 2), (236, 236, 236, 255))
        for index, tile in enumerate(tiles):
            column, row = index // 2, index % 2
            sheet.paste(tile, (column * tile.width, row * tile.height))
        sheet.save(preview / "adaptive-icon-masks.png")
        for size in (48, 72, 96, 144, 192):
            small = sheet.resize((sheet.width * size // tiles[0].width,
                                  sheet.height * size // tiles[0].height), Image.LANCZOS)
            small.save(preview / f"adaptive-icon-masks-{size}px.png")
        print(f"previews in {preview}")


if __name__ == "__main__":
    main()
