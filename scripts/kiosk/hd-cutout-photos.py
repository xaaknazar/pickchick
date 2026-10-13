#!/usr/bin/env python3
"""Sharper kiosk photos from the owner-commissioned HD catalog set (apps/mobile/assets/catalog-hd,
catalog-options; see their README): the subject is cut out with rembg (isnet-general-use), cropped
to it plus a 3 % margin and scaled to at most MAX px on the long side.

- options/*: transparent WebP (the combo option tiles and sheets show them on white or cream);
- photos/*: the same cut-out flattened onto pure white, like the v3 shots they replace (menu cards
  blend them with multiply), only sharper.

Toast and wedges keep their v3 shots: the cut-out drops the white paper liner and leaves its
logos floating. No generation or retouching here: background removal, crop and resize of existing pixels only.
Re-run: pip install "rembg[cpu]"; python3 scripts/kiosk/hd-cutout-photos.py
Writes apps/kiosk/assets/v3/hd-cutout-provenance.json.
"""
import hashlib
import json
from pathlib import Path

from PIL import Image
from rembg import new_session, remove

ROOT = Path(__file__).resolve().parents[2]
MOBILE = ROOT / 'apps/mobile/assets'
KIOSK = ROOT / 'apps/kiosk/assets/v3'
MODEL = 'isnet-general-use'
MAX = 900
MARGIN = 0.03
# target (relative to apps/kiosk/assets/v3) -> source (relative to apps/mobile/assets), mode
JOBS = [
    ('options/lemonade.webp', 'catalog-hd/lemonade.png', 'alpha'),
    ('options/cola-can.webp', 'catalog-hd/cola.png', 'alpha'),
    ('options/iced-tea.webp', 'catalog-hd/iced-tea.png', 'alpha'),
    ('options/water.webp', 'catalog-hd/water.png', 'alpha'),
    ('options/piko.webp', 'catalog-options/piko.png', 'alpha'),
    ('options/coleslaw.webp', 'catalog-hd/coleslaw.png', 'alpha'),
    ('photos/lemonade.webp', 'catalog-hd/lemonade.png', 'white'),
    ('photos/cola.webp', 'catalog-hd/cola.png', 'white'),
    ('photos/fuse-peach.webp', 'catalog-hd/fuse-peach.png', 'white'),
    ('photos/iced-tea.webp', 'catalog-hd/iced-tea.png', 'white'),
    ('photos/water.webp', 'catalog-hd/water.png', 'white'),
    ('photos/piko.webp', 'catalog-options/piko.png', 'white'),
    ('photos/sauce.webp', 'catalog-hd/sauce.png', 'white'),
    ('photos/sauce-hot.webp', 'catalog-hd/sauce-hot.png', 'white'),
    ('photos/burger.webp', 'catalog-hd/burger.png', 'white'),
    ('photos/coleslaw.webp', 'catalog-hd/coleslaw.png', 'white'),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cut(session, source: Path, mode: str) -> Image.Image:
    image = remove(Image.open(source).convert('RGB'), session=session, post_process_mask=True)
    alpha = image.getchannel('A').point(lambda a: 255 if a > 8 else 0)
    left, top, right, bottom = alpha.getbbox()
    pad = round(MARGIN * max(right - left, bottom - top))
    box = (max(0, left - pad), max(0, top - pad), min(image.width, right + pad),
           min(image.height, bottom + pad))
    image = image.crop(box)
    scale = min(1, MAX / max(image.size))
    if scale < 1:
        image = image.resize((round(image.width * scale), round(image.height * scale)),
                             Image.Resampling.LANCZOS)
    if mode == 'white':
        flat = Image.new('RGBA', image.size, (255, 255, 255, 255))
        flat.alpha_composite(image)
        return flat.convert('RGB')
    return image


def main():
    session = new_session(MODEL)
    model_file = Path.home() / '.u2net' / f'{MODEL}.onnx'
    if not model_file.exists():
        model_file = Path.home() / '.rembg/models' / MODEL / f'{MODEL}.onnx'
    records = []
    for target, source, mode in JOBS:
        src, out = MOBILE / source, KIOSK / target
        image = cut(session, src, mode)
        image.save(out, 'WEBP', quality=90, method=6)
        records.append({'target': target, 'source': f'apps/mobile/assets/{source}',
                        'source_sha256': sha(src), 'mode': mode, 'output_size': list(image.size),
                        'output_sha256': sha(out)})
        print(target, image.size, image.mode)
    (KIOSK / 'hd-cutout-provenance.json').write_text(json.dumps({
        'method': __doc__.strip().split('\n\n')[0],
        'script': 'scripts/kiosk/hd-cutout-photos.py',
        'model': MODEL,
        'model_sha256': sha(model_file) if model_file.exists() else None,
        'max_px': MAX,
        'margin': MARGIN,
        'photos': records,
    }, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
