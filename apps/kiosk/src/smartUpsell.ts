/**
 * Smart upsell (kiosk redesign 2026-10-13, docs/design/kiosk-redesign-2026-10-13/README.md §4).
 * Pure rules over catalog products and the cart; the screen only draws the plan.
 *
 * Main dishes are recognised by their catalog product ids (the same ids in the published
 * catalog, the catalog-admin seed and the test catalog):
 * - fingers: Pick/Master/Solo Combo, Фингер Дуо, Микс Дуо, single fingers and the 25-100 sets;
 * - burger: the single burger, Burger Combo, Бургер Дуо and Микс Дуо (it holds both).
 *
 * The large tile on top (the "hero"):
 * - fingers and no burger: the burger, labelled «К ФИНГЕРСАМ»;
 * - burger and no fingers: single fingers, labelled «К БУРГЕРУ»;
 * - both: the lemonade (the drinks hit) when it is not in the order yet;
 * - neither (only sides, sauces or drinks): single fingers, the house dish, then the burger,
 *   then the lemonade.
 * A hero that is stopped or already in the order gives way to the next candidate of its case;
 * when none is left there is no hero and only the rows are shown.
 *
 * Always shown below it, each row without products already in the order (or stopped):
 * - sauces: signature (ХИТ), hot (ОСТРО) and a cheese sauce (НОВЫЙ) only once the catalog has
 *   one (see `isCheeseSauce`; today it has none, so that tile is not shown);
 * - drinks: lemonade (НАШ ЛИМОНАД), iced tea, Coca-Cola; the lemonade leaves the row while it
 *   is the hero.
 * "Already in the order" means the products of the cart when the guest opened the screen: what
 * the guest adds here stays on the screen (green) and can be taken out again.
 */
export const FINGERS_PRODUCT_IDS: readonly string[] = [
  'pick-combo',
  'master-combo',
  'solo-combo',
  'finger-duo',
  'mix-duo',
  'fingers',
  'fingers-25',
  'fingers-50',
  'fingers-75',
  'fingers-100',
];
export const BURGER_PRODUCT_IDS: readonly string[] = [
  'burger',
  'burger-combo',
  'burger-duo',
  'mix-duo',
];
export type UpsellReason = 'fingers' | 'burger' | 'both' | 'neither';
export type UpsellHeroKind = 'burger' | 'fingers' | 'lemonade';
/** Fixed tiles of the rows; `cheese` is whichever cheese sauce the catalog gains. */
export type UpsellTileKey = 'sauce' | 'sauce-hot' | 'cheese' | 'lemonade' | 'iced-tea' | 'cola';
export type UpsellBadgeKind = 'hit' | 'hot' | 'new' | 'lemonade' | 'toFingers' | 'toBurger';
/** The few product fields the rule reads. */
export interface UpsellProduct {
  id: string;
  name: string;
  available?: boolean;
}
export interface UpsellHeroPick<P extends UpsellProduct = UpsellProduct> {
  product: P;
  kind: UpsellHeroKind;
  /** The hero complements the order (burger to fingers, fingers to a burger). */
  pairing: boolean;
  badge: UpsellBadgeKind;
}
export interface UpsellTilePick<P extends UpsellProduct = UpsellProduct> {
  product: P;
  key: UpsellTileKey;
  badge: UpsellBadgeKind | null;
}
export interface UpsellPlan<P extends UpsellProduct = UpsellProduct> {
  reason: UpsellReason;
  hero: UpsellHeroPick<P> | null;
  sauces: UpsellTilePick<P>[];
  drinks: UpsellTilePick<P>[];
}
const HERO_PRODUCT: Record<UpsellHeroKind, string> = {
  burger: 'burger',
  fingers: 'fingers',
  lemonade: 'lemonade',
};
const HERO_ORDER: Record<UpsellReason, UpsellHeroKind[]> = {
  fingers: ['burger', 'lemonade'],
  burger: ['fingers', 'lemonade'],
  both: ['lemonade'],
  neither: ['fingers', 'burger', 'lemonade'],
};
/**
 * A cheese sauce, should the catalog gain one: a sauce (id `sauce-…`, or «соус» / «sauce» /
 * «тұздық» / «тұздығы» in its name) that is cheesy (`cheese` in its id, or «сыр» / «cheese» /
 * «ірімшік» in its name). The signature and hot sauces never count. Heinz cheese portions are
 * modifier options, never products, so they never match.
 */
export function isCheeseSauce(product: UpsellProduct): boolean {
  const name = product.name.toLowerCase();
  const sauce = /^sauce-/.test(product.id) || /соус|sauce|тұзды[қғ]/.test(name);
  const cheese = /cheese/.test(product.id) || /сыр|cheese|ірімшік/.test(name);
  return sauce && cheese && product.id !== 'sauce' && product.id !== 'sauce-hot';
}
/** Which mains the order holds, by the cart's product ids when the screen opened. */
export function upsellReason(baseProductIds: readonly string[]): UpsellReason {
  const fingers = baseProductIds.some((id) => FINGERS_PRODUCT_IDS.includes(id));
  const burger = baseProductIds.some((id) => BURGER_PRODUCT_IDS.includes(id));
  return fingers && burger ? 'both' : fingers ? 'fingers' : burger ? 'burger' : 'neither';
}
/** The upsell screen's content for this catalog and the order as the guest brought it. */
export function planUpsell<P extends UpsellProduct>(
  products: readonly P[],
  baseProductIds: readonly string[],
): UpsellPlan<P> {
  const reason = upsellReason(baseProductIds);
  const offered = (id: string | undefined) => {
    const product = id === undefined ? undefined : products.find((p) => p.id === id);
    return product && product.available !== false && !baseProductIds.includes(product.id)
      ? product
      : undefined;
  };
  let hero: UpsellHeroPick<P> | null = null;
  for (const kind of HERO_ORDER[reason]) {
    const product = offered(HERO_PRODUCT[kind]);
    if (!product) continue;
    const pairing =
      (reason === 'fingers' && kind === 'burger') || (reason === 'burger' && kind === 'fingers');
    hero = {
      product,
      kind,
      pairing,
      badge: pairing
        ? kind === 'burger'
          ? 'toFingers'
          : 'toBurger'
        : kind === 'lemonade'
          ? 'lemonade'
          : 'hit',
    };
    break;
  }
  const tile = (
    key: UpsellTileKey,
    id: string | undefined,
    badge: UpsellBadgeKind | null,
  ): UpsellTilePick<P>[] => {
    const product = offered(id);
    return product && product.id !== hero?.product.id ? [{ product, key, badge }] : [];
  };
  return {
    reason,
    hero,
    sauces: [
      ...tile('sauce', 'sauce', 'hit'),
      ...tile('sauce-hot', 'sauce-hot', 'hot'),
      ...tile('cheese', products.find(isCheeseSauce)?.id, 'new'),
    ],
    drinks: [
      ...tile('lemonade', 'lemonade', 'lemonade'),
      ...tile('iced-tea', 'iced-tea', null),
      ...tile('cola', 'cola', null),
    ],
  };
}
/** «Pick Combo» or «Pick Combo +2»: the first product of the order and how many more. */
export function orderSummary(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (!unique.length) return '';
  return unique.length > 1 ? `${unique[0]} +${unique.length - 1}` : unique[0]!;
}
/**
 * «Burger Combo + Соус фирменный ×2»: the order's products in cart order; lines of one product
 * with different choices count together.
 */
export function orderLines(lines: readonly { name: string; quantity: number }[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.name, (counts.get(line.name) ?? 0) + line.quantity);
  return [...counts]
    .map(([name, quantity]) => (quantity > 1 ? `${name} ×${quantity}` : name))
    .join(' + ');
}
/**
 * The upsell's «К оплате» goes straight to the Kaspi QR when Kaspi QR is the kiosk's only way
 * to pay (commercial mode, methods exactly ['kaspi']); any choice (QR and invoice, the test
 * simulator's Kaspi and card) keeps the existing payment-method screen.
 */
export function paysDirectly(
  commercial: boolean | undefined,
  methods: readonly string[] | undefined,
): boolean {
  const offered = methods ?? ['kaspi'];
  return !!commercial && offered.length === 1 && offered[0] === 'kaspi';
}
/** A cart line as the upsell remembers it: its id and quantity. */
export interface UpsellLine {
  lineId: string;
  quantity: number;
}
/**
 * «Без допов» (owner bug report 2026-10-13: extras added on the upsell were still ordered): the
 * quantities that put the cart back to what it held when the guest opened the upsell. Every line
 * added or grown during this visit returns to its opening quantity (0 takes it out); lines the
 * guest brought keep theirs, and a line lowered meanwhile is never raised again.
 */
export function upsellUndo(
  opened: readonly UpsellLine[],
  now: readonly UpsellLine[],
): UpsellLine[] {
  const before = new Map(opened.map((line) => [line.lineId, line.quantity]));
  return now.flatMap((line) => {
    const target = before.get(line.lineId) ?? 0;
    return line.quantity > target ? [{ lineId: line.lineId, quantity: target }] : [];
  });
}
/**
 * Applies `upsellUndo` with the cart's own quantity operation (the model's `updateQuantity`),
 * one line after another. Stops at the first refusal (false), so the guest never goes on to
 * payment with a half-undone cart; true when the cart is back as it was.
 */
export async function undoUpsellAdds(
  model: { updateQuantity(lineId: string, quantity: number): Promise<boolean> },
  opened: readonly UpsellLine[],
  now: readonly UpsellLine[],
): Promise<boolean> {
  for (const step of upsellUndo(opened, now))
    if (!(await model.updateQuantity(step.lineId, step.quantity))) return false;
  return true;
}
