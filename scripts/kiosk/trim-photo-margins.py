"""Trim the plain studio margins of the kiosk v3 card photos (kiosk redesign 2026-10-13).

The bento menu shows each photo with `contain` in the space above a card's text strip
(docs/design/kiosk-redesign-2026-10-13/README.md, "Карточка позиции"), so wide white or
transparent borders only shrink the food. This crops every photo of
apps/kiosk/assets/v3/photos to its subject plus a small even margin. Nothing is generated,
retouched or resized: the kept pixels are the original ones, re-encoded as WebP.

Reproducible: the originals are read from git at SOURCE_REV (the revision before the trim),
their SHA-256 must match the provenance file, and the crop boxes are recomputed from them.

Usage (from the repository root, Pillow with WebP required):
    python3 scripts/kiosk/trim-photo-margins.py            # rewrite photos + provenance
    python3 scripts/kiosk/trim-photo-margins.py --check    # verify boxes, write nothing
"""

import argparse
import hashlib
import io
import json
import re
import subprocess
from pathlib import Path

import PIL
from PIL import Image, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
PHOTOS = 'apps/kiosk/assets/v3/photos'
PROVENANCE = ROOT / PHOTOS / 'trim-provenance.json'
# Last revision with the untrimmed originals (kiosk redesign brief commit).
SOURCE_REV = 'd85541b1503fa90f7b99d424b51d69578a9c4d3e'
# A pixel belongs to the backdrop when every channel is within TOLERANCE of the corner colour
# (studio white or the cream of a few shots); cut-outs use their alpha channel instead.
TOLERANCE = 12
ALPHA = 16
# Kept around the subject on every side, as a share of the subject's longer side.
MARGIN = 0.03
# Margins thinner than this (share of the side) are left alone: no re-encode for nothing.
MINIMUM_TRIM = 0.02
QUALITY = 90


def original(name):
    return subprocess.run(['git', 'show', f'{SOURCE_REV}:{PHOTOS}/{name}'], cwd=ROOT,
                          capture_output=True, check=True).stdout


def subject_box(image):
    if image.mode == 'RGBA':
        mask = image.getchannel('A').point(lambda a: 255 if a > ALPHA else 0)
    else:
        rgb = image.convert('RGB')
        w, h = rgb.size
        corners = [rgb.getpixel(p) for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]]
        backdrop = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
        diff = ImageChops.difference(rgb, Image.new('RGB', rgb.size, backdrop))
        mask = diff.convert('L').point(lambda d: 255 if d > TOLERANCE else 0)
    # Ignore single specks of encoder noise: a speck must survive a 5 px minimum filter.
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    return mask.getbbox()


def crop_box(image):
    w, h = image.size
    box = subject_box(image)
    if not box:
        return None
    left, top, right, bottom = box
    pad = round(max(right - left, bottom - top) * MARGIN)
    box = (max(0, left - pad), max(0, top - pad), min(w, right + pad), min(h, bottom + pad))
    margins = [box[0] / w, box[1] / h, (w - box[2]) / w, (h - box[3]) / h]
    return box if max(margins) >= MINIMUM_TRIM else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='verify only, write nothing')
    args = parser.parse_args()
    names = subprocess.run(['git', 'ls-tree', '--name-only', f'{SOURCE_REV}:{PHOTOS}'], cwd=ROOT,
                           capture_output=True, check=True, text=True).stdout.split()
    recorded = json.loads(PROVENANCE.read_text()) if PROVENANCE.exists() else None
    known = {p['name']: p for p in recorded['photos']} if recorded else {}
    photos = []
    for name in sorted(n for n in names if n.endswith('.webp')):
        data = original(name)
        source_sha = hashlib.sha256(data).hexdigest()
        if name in known:
            assert known[name]['source_sha256'] == source_sha, f'{name}: original changed'
        image = Image.open(io.BytesIO(data))
        image.load()
        box = crop_box(image)
        entry = {'name': name, 'source_sha256': source_sha, 'source_size': list(image.size)}
        target = ROOT / PHOTOS / name
        if box is None:
            entry.update({'trimmed': False})
            if not args.check:
                target.write_bytes(data)
        else:
            entry.update({'trimmed': True, 'crop_ltrb': list(box),
                          'output_size': [box[2] - box[0], box[3] - box[1]]})
            if not args.check:
                out = io.BytesIO()
                image.crop(box).save(out, 'WEBP', quality=QUALITY, method=6,
                                     **({'exact': True} if image.mode == 'RGBA' else {}))
                target.write_bytes(out.getvalue())
        if name in known and known[name].get('crop_ltrb') != entry.get('crop_ltrb'):
            raise SystemExit(f'{name}: crop box differs from the recorded one')
        if not args.check:
            entry['output_sha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
        elif name in known:
            entry['output_sha256'] = known[name].get('output_sha256')
        photos.append(entry)
    result = {
        'method': 'Crop to the subject (corner-colour backdrop or alpha) plus a 3 % margin; '
                  'original pixels, no generation, retouching or resizing; WebP q90.',
        'script': 'scripts/kiosk/trim-photo-margins.py',
        'source_rev': SOURCE_REV,
        'pillow': PIL.__version__,
        'photos': photos,
    }
    if args.check:
        print(json.dumps({'checked': len(photos),
                          'trimmed': sum(p['trimmed'] for p in photos)}))
    else:
        text = json.dumps(result, ensure_ascii=False, indent=2)
        # Number pairs on one line, as the repository's Prettier writes them.
        text = re.sub(r'\[\s+(-?\d+),\s+(-?\d+)(?:,\s+(-?\d+),\s+(-?\d+))?\s+\]',
                      lambda m: '[' + ', '.join(g for g in m.groups() if g is not None) + ']',
                      text)
        PROVENANCE.write_text(text + '\n')
        print(json.dumps({'written': len(photos),
                          'trimmed': sum(p['trimmed'] for p in photos)}))


if __name__ == '__main__':
    main()
