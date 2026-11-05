#!/usr/bin/env python3
"""Google Play store graphics from the app's own art (lane android, tech-lead review 05.11.2026).

Play Console > Store presence > Main store listing needs, besides the phone screenshots:
- app icon: 512 x 512, 32-bit PNG (with alpha), at most 1 MB, a full square - Google Play adds
  the rounded mask and shadow itself. It is the App Store icon art (apps/mobile/assets/app-icon.png)
  scaled down, so both stores show the same icon;
- feature graphic: 1024 x 500, JPEG or 24-bit PNG (no alpha), at most 15 MB. A DRAFT for the
  owner: the PickChick sticker (the adaptive icon foreground) and the burger, fingers and
  signature sauce cutouts on the brand blue, without text (Play may overlay its own UI, and
  text would need three languages). Key content stays in the middle 80 %.

Outputs (committed): docs/operations/mobile-play-2026-11/graphics/play-icon-512.png and
feature-graphic-1024x500.png. Requires Pillow. Run: python3 scripts/mobile/play_store_graphics.py
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/mobile/assets"
OUTPUT = ROOT / "docs/operations/mobile-play-2026-11/graphics"
ICON_SIZE = 512
FEATURE_SIZE = (1024, 500)
# Brand blue of the icon (android_adaptive_icon.py BACKGROUND) and a deeper shade for the edges.
BLUE = (0, 66, 224)
DEEP_BLUE = (0, 30, 120)


def play_icon():
    icon = Image.open(ASSETS / "app-icon.png").convert("RGBA")
    return icon.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)


def trimmed(path, height):
    """A cutout cropped to its visible pixels and scaled to the given height."""
    image = Image.open(path).convert("RGBA")
    image = image.crop(image.getchannel("A").point(lambda value: 255 if value > 8 else 0).getbbox())
    width = round(image.width * height / image.height)
    return image.resize((width, height), Image.LANCZOS)


def background():
    width, height = FEATURE_SIZE
    canvas = Image.new("RGB", FEATURE_SIZE, DEEP_BLUE)
    # A soft light in the middle: brand blue there, deeper towards the corners.
    glow = Image.new("L", FEATURE_SIZE, 0)
    ImageDraw.Draw(glow).ellipse((60, -120, width - 60, height + 120), fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    return Image.composite(Image.new("RGB", FEATURE_SIZE, BLUE), canvas, glow)


def shadow(item, offset, blur=18, opacity=110):
    """A soft dark shadow of a cutout, the same size as the canvas."""
    layer = Image.new("RGBA", FEATURE_SIZE, (0, 0, 0, 0))
    alpha = item.getchannel("A").point(lambda value: value * opacity // 255)
    silhouette = Image.new("RGBA", item.size, (0, 12, 50, 255))
    silhouette.putalpha(alpha)
    layer.alpha_composite(silhouette, offset)
    return layer.filter(ImageFilter.GaussianBlur(blur))


def place(canvas, item, center, drop=(10, 16)):
    left = round(center[0] - item.width / 2)
    top = round(center[1] - item.height / 2)
    canvas.alpha_composite(shadow(item, (left + drop[0], top + drop[1])))
    canvas.alpha_composite(item, (left, top))


def feature_graphic():
    canvas = background().convert("RGBA")
    sticker = trimmed(ASSETS / "android/adaptive-icon-foreground.png", 270)
    fingers = trimmed(ASSETS / "catalog-cutouts/fingers.png", 220).rotate(-12, Image.BICUBIC, expand=True)
    burger = trimmed(ASSETS / "catalog-cutouts/burger.png", 255)
    sauce = trimmed(ASSETS / "catalog-cutouts/signature-small.png", 128)
    place(canvas, sticker, (272, 250), drop=(8, 12))
    place(canvas, fingers, (590, 300))
    place(canvas, burger, (760, 238))
    place(canvas, sauce, (888, 352), drop=(6, 10))
    return canvas.convert("RGB")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", default=str(OUTPUT), help="Directory for the two PNG files")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    play_icon().save(output / "play-icon-512.png", optimize=True)
    feature_graphic().save(output / "feature-graphic-1024x500.png", optimize=True)
    for name in ("play-icon-512.png", "feature-graphic-1024x500.png"):
        path = output / name
        with Image.open(path) as image:
            print(f"{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}: "
                  f"{image.size[0]}x{image.size[1]} {image.mode} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
