// Bento menu presentation (kiosk redesign 2026-10-13, docs/design/kiosk-redesign-2026-10-13,
// section 3). Pure data and geometry only: no React Native, so node tests can load it.
// The catalog carries no "hit" or badge flag (packages/catalog-admin CatalogProductSchema),
// so the owner's choices live here by product id, with a fallback to the catalog order.

/** Rail sections, in rail order (mirrors `categoryKeys` in components/categories.ts). */
export type MenuSection = 'combo' | 'duo' | 'sets' | 'extras' | 'drinks';
/** Dictionary keys (i18n.ts) of the hit labels and card badges. */
export type HitLabel = 'hit' | 'hitDuo' | 'hitSets' | 'hitExtras' | 'hitDrinks';
export type BadgeKind = 'hit' | 'new' | 'spicy' | 'recipe';

/** Owner-approved hit of each section (README "Первая плитка — хит раздела"). */
export const SECTION_HITS: Record<MenuSection, { productId: string; label: HitLabel }> = {
  combo: { productId: 'master-combo', label: 'hit' },
  duo: { productId: 'finger-duo', label: 'hitDuo' },
  sets: { productId: 'fingers-25', label: 'hitSets' },
  extras: { productId: 'burger', label: 'hitExtras' },
  drinks: { productId: 'lemonade', label: 'hitDrinks' },
};
/** Card badges: «ХИТ», «НОВИНКА», «ОСТРОЕ», «СВОЙ РЕЦЕПТ». */
export const PRODUCT_BADGES: Readonly<Record<string, BadgeKind>> = {
  'pick-combo': 'hit',
  'solo-combo': 'new',
  'sauce-hot': 'spicy',
  'iced-tea': 'recipe',
};
export const badgeOf = (productId: string): BadgeKind | undefined =>
  Object.hasOwn(PRODUCT_BADGES, productId) ? PRODUCT_BADGES[productId] : undefined;

interface HitCandidate {
  id: string;
  available?: boolean;
}
/**
 * The section's hit: the configured product while it is on sale; otherwise the first
 * product of the section that is on sale; otherwise (everything stopped) the configured
 * product, or the first one, so the tile still shows what the section offers.
 */
export function sectionHit<T extends HitCandidate>(products: readonly T[], section: MenuSection) {
  const configured = products.find((p) => p.id === SECTION_HITS[section].productId);
  if (configured && configured.available !== false) return configured;
  return products.find((p) => p.available !== false) ?? configured ?? products[0] ?? null;
}

/**
 * Card looks of the bento grid: `large` (2 columns, with description), `medium` (2 columns,
 * no description), `small` (3 columns) and `wide` (the last card stretched over the empty
 * cells of its row: photo left 58 %, text right).
 */
export type CardSize = 'large' | 'medium' | 'small' | 'wide';
export interface BentoCell {
  /** Index into the section's remaining products (the hit is not repeated). */
  item: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  size: CardSize;
}
export interface BentoLayout {
  columns: number;
  /** Row weights in `fr`; row 0 holds the hit across every column. */
  rows: number[];
  cards: BentoCell[];
}
/**
 * Grid rule by the number of products in the section, hit included (README section 3):
 * - 3: 2 columns, rows 0.8fr 1.25fr, two tall cards under the hit;
 * - 4: 2 columns, rows 1fr 1fr 1fr, a tall card on the left over two rows, two on the right;
 * - 5 and more: 3 columns, rows 0.85fr + 1fr per started row of three; when the last row is
 *   not full its last card stretches over the free columns and turns horizontal.
 * One or two products (not in the approved menu) follow the same idea: the hit alone (a third
 * of the height), or the hit and one wide card.
 */
export function bentoLayout(count: number): BentoLayout {
  const rest = Math.max(0, Math.floor(count) - 1);
  if (count < 1) return { columns: 1, rows: [], cards: [] };
  // A lone hit keeps the hit-row height of a full section; the space below stays empty.
  if (rest === 0) return { columns: 1, rows: [1, 2], cards: [] };
  if (rest === 1)
    return {
      columns: 2,
      rows: [0.8, 1.25],
      cards: [{ item: 0, row: 1, col: 0, rowSpan: 1, colSpan: 2, size: 'wide' }],
    };
  if (rest === 2)
    return {
      columns: 2,
      rows: [0.8, 1.25],
      cards: [0, 1].map((item) => ({
        item,
        row: 1,
        col: item,
        rowSpan: 1,
        colSpan: 1,
        size: 'large',
      })),
    };
  if (rest === 3)
    return {
      columns: 2,
      rows: [1, 1, 1],
      cards: [
        { item: 0, row: 1, col: 0, rowSpan: 2, colSpan: 1, size: 'large' },
        { item: 1, row: 1, col: 1, rowSpan: 1, colSpan: 1, size: 'medium' },
        { item: 2, row: 2, col: 1, rowSpan: 1, colSpan: 1, size: 'medium' },
      ],
    };
  const lines = Math.ceil(rest / 3);
  const cards: BentoCell[] = [];
  for (let item = 0; item < rest; item++) {
    const row = 1 + Math.floor(item / 3);
    const col = item % 3;
    const last = item === rest - 1;
    const colSpan = last ? 3 - col : 1;
    cards.push({ item, row, col, rowSpan: 1, colSpan, size: colSpan > 1 ? 'wide' : 'small' });
  }
  return { columns: 3, rows: [0.85, ...Array.from({ length: lines }, () => 1)], cards };
}

export interface BentoFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BentoGeometry {
  hit: BentoFrame | null;
  cards: (BentoFrame & BentoCell)[];
  /** Height of the whole grid; more than the viewport means the section scrolls. */
  height: number;
}
/**
 * Pixel frames for a layout in a `width` x `height` viewport. Rows share the height by their
 * `fr` weights, so the grid stretches with the screen; the hit row keeps at least `minHit`
 * and the card rows share the rest. When that would make a card row lower than `minRow`, the
 * section scrolls instead, with roomier rows (`scrollRow` per `fr`) rather than squeezed ones.
 */
export function bentoGeometry(
  layout: BentoLayout,
  width: number,
  height: number,
  gap: number,
  minRow: number,
  minHit: number,
  scrollRow = minRow,
): BentoGeometry {
  const { rows, columns } = layout;
  if (!rows.length) return { hit: null, cards: [], height: 0 };
  const total = rows.reduce((sum, weight) => sum + weight, 0);
  const free = height - gap * (rows.length - 1);
  // The hit takes its share (at least `minHit`); the card rows share what is left.
  const hit = Math.max((rows[0]! * Math.max(0, free)) / total, minHit);
  const cardWeights = rows.slice(1);
  const cardFr = (free - hit) / Math.max(1e-9, total - rows[0]!);
  const fits = cardWeights.every((weight) => weight * cardFr >= minRow);
  const heights = fits
    ? [hit, ...cardWeights.map((weight) => weight * cardFr)]
    : [
        Math.max(rows[0]! * scrollRow, minHit),
        ...cardWeights.map((weight) => Math.max(weight * scrollRow, minRow)),
      ];
  // Edges are rounded from exact running sums, so cells meet the gap and the grid's own
  // edges to the pixel whatever the fr unit is.
  const top = (row: number) =>
    heights.slice(0, row).reduce((sum, rowHeight) => sum + rowHeight + gap, 0);
  const column = (width - gap * (columns - 1)) / columns;
  const left = (col: number) => col * (column + gap);
  const cards = layout.cards.map((cell) => {
    const x = Math.round(left(cell.col));
    const y = Math.round(top(cell.row));
    const last = cell.row + cell.rowSpan - 1;
    return {
      ...cell,
      x,
      y,
      width: Math.round(left(cell.col + cell.colSpan - 1) + column) - x,
      height: Math.round(top(last) + heights[last]!) - y,
    };
  });
  return {
    hit: { x: 0, y: 0, width, height: Math.round(heights[0]!) },
    cards,
    height: Math.round(top(rows.length - 1) + heights[rows.length - 1]!),
  };
}

/** Average advance of Montserrat 900 per letter (Cyrillic and Latin lowercase, digits), in em. */
const LETTER = 0.7;
/** The widest single word is measured more cautiously (capitals, wide Cyrillic letters). */
const WIDE_LETTER = 0.74;
/** Lines a greedy word wrap needs for `text` with `perLine` letters per line. */
function wrappedLines(text: string, perLine: number) {
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = used ? used + 1 + word.length : word.length;
    if (used && next > perLine) {
      lines += 1;
      used = word.length;
    } else used = next;
  }
  return lines;
}
/**
 * Type size for a product name in a text column `width` points wide: the largest size from
 * `base` down to `min` at which no word is wider than the column (no break inside a word) and
 * the name takes at most `lines` lines. A name that still does not fit at `min` gets one more
 * line instead of an ellipsis. Before the column is measured (`width` 0) the base size is used.
 */
export function fitTitle(text: string, width: number, base: number, min: number, lines = 2) {
  if (!(width > 0)) return { size: base, lines };
  const longest = Math.max(1, ...text.split(/\s+/).map((word) => word.length));
  for (let size = Math.floor(base); size >= Math.ceil(min); size--) {
    const fitsWord = longest * size * WIDE_LETTER <= width;
    if (fitsWord && wrappedLines(text, width / (size * LETTER)) <= lines) return { size, lines };
  }
  const size = Math.max(1, Math.min(Math.floor(min), Math.floor(width / (longest * WIDE_LETTER))));
  return { size, lines: Math.max(lines, wrappedLines(text, width / (size * LETTER))) };
}
