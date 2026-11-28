import { readFileSync } from 'node:fs';

const glyphs = JSON.parse(readFileSync(new URL('./glyphs.json', import.meta.url), 'utf8'));

/** Russian, Kazakh and English copy of the souvenir slip. Only one language reaches paper. */
export const slipCopy = Object.freeze({
  ru: {
    kicker: 'ФОТО НА ПАМЯТЬ',
    title: ['Хрустящий момент', 'на память'],
    wish: 'Приятного аппетита!',
  },
  kk: { kicker: 'ЕСТЕЛІККЕ ФОТО', title: ['Қытырлақ сәт —', 'тәтті естелік'], wish: 'Ас болсын!' },
  en: {
    kicker: 'PHOTO TO REMEMBER',
    title: ['A crispy moment', 'to remember'],
    wish: 'Enjoy your meal!',
  },
});

const escapeXml = (value) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Width in dots of `text` set in `face` at `size` px with `tracking` em/1000 between letters. */
export function measure(face, text, size, tracking = 0) {
  const table = glyphs[face];
  let width = 0;
  for (const ch of text) width += ((table[ch] ?? table['?'])[0] + tracking) * (size / 1000);
  return Math.max(0, width - (tracking * size) / 1000);
}

/** Outlined lettering: no system font, printer code page or font install is involved. */
export function textPath(
  face,
  text,
  size,
  x,
  baseline,
  { tracking = 0, anchor = 'start', fill = 'black' } = {},
) {
  const table = glyphs[face];
  const width = measure(face, text, size, tracking);
  let left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  const scale = size / 1000;
  const parts = [];
  for (const ch of text) {
    const [advance, d] = table[ch] ?? table['?'];
    if (d)
      parts.push(
        `<path transform="translate(${left.toFixed(2)} ${baseline}) scale(${scale})" d="${d}"/>`,
      );
    left += (advance + tracking) * scale;
  }
  return `<g fill="${fill}" aria-label="${escapeXml(text)}">${parts.join('')}</g>`;
}

/** Fit a text into `max` dots by shrinking the size; returns the size used. */
export function fit(face, text, size, max, tracking = 0) {
  let s = size;
  while (s > 10 && measure(face, text, s, tracking) > max) s -= 1;
  return s;
}

/** Almaty date and time of the shot, e.g. `26.11.2026` and `14:32`. */
export function stamp(date = new Date(), timeZone = 'Asia/Almaty') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.day}.${parts.month}.${parts.year}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * Layout of the slip for a printable width. All boxes are integral dots so the photograph,
 * the mark and the lettering are dithered separately and never bleed into each other.
 */
export function slipLayout(width) {
  const margin = Math.round(width * 0.05);
  const inner = width - margin * 2;
  const logoWidth = Math.round(width * 0.36);
  const logoHeight = Math.round((logoWidth * 481) / 519);
  const top = Math.round(margin * 0.9);
  const kickerTop = top + logoHeight + Math.round(width * 0.055);
  const frameTop = kickerTop + Math.round(width * 0.06);
  const border = Math.max(4, Math.round(width / 96));
  const pad = Math.round(width * 0.018);
  const photoWidth = inner - (border + pad) * 2;
  const photoHeight = Math.round((photoWidth * 3) / 4);
  const frameHeight = photoHeight + (border + pad) * 2;
  const captionTop = frameTop + frameHeight + Math.round(width * 0.075);
  const footerTop = captionTop + Math.round(width * 0.31);
  const height = footerTop + Math.round(width * 0.12);
  return {
    width,
    height,
    margin,
    inner,
    logo: { left: Math.round((width - logoWidth) / 2), top, width: logoWidth, height: logoHeight },
    kickerTop,
    frame: {
      left: margin,
      top: frameTop,
      width: inner,
      height: frameHeight,
      border,
      radius: Math.round(width * 0.035),
    },
    photo: {
      left: margin + border + pad,
      top: frameTop + border + pad,
      width: photoWidth,
      height: photoHeight,
    },
    captionTop,
    footerTop,
  };
}

/** Vector part of the slip (frame, lettering, details); white where the photo and the logo go. */
export function slipSvg(layout, { locale = 'ru', point = '', when = stamp() } = {}) {
  const copy = slipCopy[locale];
  const { width, height, margin, inner, frame, kickerTop, captionTop, footerTop } = layout;
  const u = width / 576;
  const cx = width / 2;
  const kickerSize = Math.round(17 * u);
  const kickerTrack = 260;
  const kickerWidth = measure('title', copy.kicker, kickerSize, kickerTrack);
  const rule = (y, x1, x2) =>
    `<rect x="${x1}" y="${y}" width="${Math.max(0, x2 - x1)}" height="${Math.max(2, Math.round(2 * u))}"/>`;
  const gap = Math.round(14 * u);
  const titleSize = fit('title', copy.title[0], Math.round(40 * u), inner);
  const titleSize2 = Math.min(titleSize, fit('title', copy.title[1], Math.round(40 * u), inner));
  const wishSize = Math.round(24 * u);
  const smallSize = Math.round(19 * u);
  // Corner ticks of a viewfinder inside the frame: the "shot" look without covering faces.
  const tick = Math.round(26 * u);
  const tw = Math.max(3, Math.round(4 * u));
  const fx1 = frame.left + frame.border + Math.round(18 * u);
  const fy1 = frame.top + frame.border + Math.round(18 * u);
  const fx2 = frame.left + frame.width - frame.border - Math.round(18 * u);
  const fy2 = frame.top + frame.height - frame.border - Math.round(18 * u);
  const corner = (x, y, dx, dy) =>
    `<path d="M${x} ${y + dy * tick}V${y}H${x + dx * tick}" fill="none" stroke="white" stroke-width="${tw}" stroke-linecap="square"/>`;
  const dashY = footerTop - Math.round(24 * u);
  const dashes = [];
  for (let x = margin; x < width - margin; x += Math.round(14 * u))
    dashes.push(
      `<rect x="${x}" y="${dashY}" width="${Math.round(7 * u)}" height="${Math.max(2, Math.round(2 * u))}"/>`,
    );
  const left = point ? `PickChick · ${point}` : 'PickChick';
  const right = `${when.date}  ${when.time}`;
  const leftSize = fit('text', left, smallSize, inner - measure('text', right, smallSize) - 16 * u);
  const halfway = (kickerWidth + gap * 2) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="white"/>
<g fill="black">
${rule(kickerTop - Math.round(7 * u), margin, cx - halfway)}
${rule(kickerTop - Math.round(7 * u), cx + halfway, width - margin)}
</g>
${textPath('title', copy.kicker, kickerSize, cx, kickerTop, { tracking: kickerTrack, anchor: 'middle' })}
<rect x="${frame.left + frame.border / 2}" y="${frame.top + frame.border / 2}" width="${frame.width - frame.border}" height="${frame.height - frame.border}" rx="${frame.radius}" fill="none" stroke="black" stroke-width="${frame.border}"/>
${textPath('title', copy.title[0], titleSize, cx, captionTop + Math.round(titleSize * 0.8), { anchor: 'middle' })}
${textPath('title', copy.title[1], titleSize2, cx, captionTop + Math.round(titleSize * 0.8 + titleSize2 * 1.12), { anchor: 'middle' })}
${textPath('text', copy.wish, wishSize, cx, captionTop + Math.round(titleSize * 0.8 + titleSize2 * 1.12 + wishSize * 1.7), { anchor: 'middle' })}
<g fill="black">${dashes.join('')}</g>
${textPath('text', left, leftSize, margin, footerTop + Math.round(smallSize * 0.9))}
${textPath('text', right, smallSize, width - margin, footerTop + Math.round(smallSize * 0.9), { anchor: 'end' })}
${textPath('text', 'pickchick.kz', Math.round(17 * u), cx, footerTop + Math.round(smallSize * 0.9 + 34 * u), { anchor: 'middle', tracking: 40 })}
</svg>`.replace(
    '</svg>',
    `<g id="viewfinder">${corner(fx1, fy1, 1, 1)}${corner(fx2, fy1, -1, 1)}${corner(fx1, fy2, 1, -1)}${corner(fx2, fy2, -1, -1)}</g></svg>`,
  );
}

/** Only the viewfinder ticks: drawn over the photograph after it is placed. */
export function viewfinderSvg(svg, layout) {
  const ticks = svg.match(/<g id="viewfinder">[\s\S]*?<\/g>/)[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">${ticks}</svg>`;
}
