"""Render the static dark-navy restaurant map used by the mobile M05 screen.

The image is built from standard OpenStreetMap raster tiles (data (c) OpenStreetMap
contributors, ODbL; tiles from tile.openstreetmap.org). Only the handful of tiles
around the restaurant is requested, once, with a descriptive User-Agent, and kept
in a local cache so a re-run does not hit the tile server again (see
https://operations.osmfoundation.org/policies/tiles/).

The pin is NOT baked into the image: the app draws it on top at the position
projected from `config/restaurant-locations.json` with the metadata JSON written
next to the image. The app also shows the "(c) OpenStreetMap" attribution.

Usage (from the repository root, Pillow required):
    python3 scripts/mobile/render-static-map.py
    python3 scripts/mobile/render-static-map.py --cache /tmp/osm-tiles --offline
"""

import argparse
import io
import json
import math
import time
import urllib.request
from datetime import date
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "apps/mobile/assets/maps"
LOGO = ROOT / "design/prototype/assets/mockup/logo.png"
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
USER_AGENT = (
    "PickChick-static-map-generator/1.0 "
    "(+https://github.com/xaaknazar/pickchick; one-off static app asset)"
)
TILE = 256

# Luma of the OSM Carto tile (0 = black text, 1 = white road) -> navy palette.
# Bright land/roads become the dark app background, dark labels become light.
RAMP = [
    (0.00, (0x8C, 0x9C, 0xC4)),  # darkest label cores
    (0.25, (0x56, 0x67, 0x91)),  # grey area labels
    (0.50, (0x34, 0x45, 0x6F)),  # POI icons, purple labels
    (0.70, (0x18, 0x28, 0x50)),  # road casings, outlines
    (0.823, (0x0D, 0x1D, 0x44)),  # buildings: slightly raised blocks
    (0.876, (0x09, 0x18, 0x3B)),  # residential land: the base tone
    (0.90, (0x06, 0x13, 0x33)),  # parks sink a little
    (0.94, (0x08, 0x17, 0x3A)),  # plain land
    (1.00, (0x05, 0x13, 0x35)),  # white streets and avenues
]
BACKGROUND = (0x04, 0x14, 0x3A)  # app background: the top fades into it under the controls
TOP_FADE = 90  # points


def world_pixel(lat, lon, zoom):
    scale = TILE * 2**zoom
    x = (lon + 180) / 360 * scale
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * scale
    return x, y


def fetch_tile(z, x, y, cache, offline):
    path = cache / f"{z}_{x}_{y}.png"
    if not path.exists():
        if offline:
            raise SystemExit(f"Missing cached tile {path} and --offline was given")
        request = urllib.request.Request(
            TILE_URL.format(z=z, x=x, y=y), headers={"User-Agent": USER_AGENT}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise SystemExit(f"Tile {z}/{x}/{y}: HTTP {response.status}")
            path.write_bytes(response.read())
        time.sleep(0.5)  # be gentle with the volunteer-run tile servers
    return Image.open(io.BytesIO(path.read_bytes())).convert("RGB")


def ramp_lut():
    lut = []
    for value in range(256):
        t = value / 255
        for (t0, c0), (t1, c1) in zip(RAMP, RAMP[1:]):
            if t0 <= t <= t1:
                k = (t - t0) / (t1 - t0) if t1 > t0 else 0
                lut.append(tuple(round(a + (b - a) * k) for a, b in zip(c0, c1)))
                break
    return lut


def recolour(image):
    luma = image.convert("L")
    lut = ramp_lut()
    channels = [luma.point([colour[i] for colour in lut]) for i in range(3)]
    return Image.merge("RGB", channels)


def fade_top(image, scale):
    """Darken the strip under the status bar and map controls, as in the approved mockup."""
    height = round(TOP_FADE * scale)
    mask = Image.new("L", (1, height))
    for y in range(height):
        mask.putpixel((0, y), round(255 * 0.8 * (1 - y / height) ** 1.5))
    shade = Image.new("RGB", image.size, BACKGROUND)
    full = Image.new("L", image.size, 0)
    full.paste(mask.resize((image.size[0], height)), (0, 0))
    return Image.composite(shade, image, full)


def render(args):
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    wx, wy = world_pixel(args.lat, args.lon, args.zoom)
    tile_px_per_pt = 1 / args.points_per_tile_pixel
    width_tp = round(args.width * tile_px_per_pt)
    height_tp = round(args.height * tile_px_per_pt)
    x0 = round(wx - args.width / 2 * tile_px_per_pt)
    y0 = round(wy - args.anchor_y * tile_px_per_pt)
    tx0, ty0 = x0 // TILE, y0 // TILE
    tx1, ty1 = (x0 + width_tp - 1) // TILE, (y0 + height_tp - 1) // TILE
    canvas = Image.new("RGB", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            tile = fetch_tile(args.zoom, tx, ty, cache, args.offline)
            canvas.paste(tile, ((tx - tx0) * TILE, (ty - ty0) * TILE))
    left, top = x0 - tx0 * TILE, y0 - ty0 * TILE
    crop = canvas.crop((left, top, left + width_tp, top + height_tp))
    size = (round(args.width * args.scale), round(args.height * args.scale))
    image = fade_top(recolour(crop.resize(size, Image.LANCZOS)), args.scale)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / f"{args.name}.webp"
    # Lossy WebP keeps the soft navy gradients small (~50 KB); expo-image decodes it everywhere.
    image.save(target, "WEBP", quality=args.quality, method=6)
    metadata = {
        "image": target.name,
        "source": "OpenStreetMap standard tiles (tile.openstreetmap.org), recoloured",
        "attribution": "© OpenStreetMap",
        "licence": "ODbL - © OpenStreetMap contributors",
        "generated": args.generated,
        "zoom": args.zoom,
        "width": args.width,
        "height": args.height,
        "pointsPerTilePixel": args.points_per_tile_pixel,
        # The top-left corner in world pixels at `zoom`, so any coordinate can be projected.
        "originWorldPixel": {"x": x0, "y": y0},
        "center": {"latitude": args.lat, "longitude": args.lon},
    }
    (OUT_DIR / f"{args.name}.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{target.relative_to(ROOT)} {image.size[0]}x{image.size[1]} {target.stat().st_size} bytes")


def closed_logo(args):
    """Grey copy of the supplied brand logo for the closed-restaurant pin."""
    logo = Image.open(LOGO).convert("RGBA")
    grey = logo.convert("L").convert("RGBA")
    grey.putalpha(logo.getchannel("A"))
    target = OUT_DIR / "pin-logo-closed.png"
    grey.resize((args.logo_size, args.logo_size), Image.LANCZOS).save(target, optimize=True)
    print(f"{target.relative_to(ROOT)} {target.stat().st_size} bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--name", default="abay-plaza")
    parser.add_argument("--lat", type=float, default=43.226274)
    parser.add_argument("--lon", type=float, default=76.860865)
    parser.add_argument("--zoom", type=int, default=16)
    parser.add_argument("--width", type=float, default=393, help="points")
    parser.add_argument("--height", type=float, default=320, help="points")
    parser.add_argument("--anchor-y", type=float, default=158, help="restaurant y, points")
    parser.add_argument("--points-per-tile-pixel", type=float, default=0.61)
    parser.add_argument("--scale", type=int, default=3)
    parser.add_argument("--quality", type=int, default=85, help="WebP quality")
    parser.add_argument("--logo-size", type=int, default=96)
    parser.add_argument("--generated", default=date.today().isoformat())
    parser.add_argument("--cache", default=str(Path.home() / ".cache/pickchick-osm-tiles"))
    parser.add_argument("--offline", action="store_true", help="use cached tiles only")
    args = parser.parse_args()
    render(args)
    closed_logo(args)


if __name__ == "__main__":
    main()
