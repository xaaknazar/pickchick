import { defaultSelections, validSelections, cartLineKey } from './domain.ts';
import type { CartLine, ModifierGroup, Product, Selection } from './model';

export const photoProductIds = [
  'pick-combo',
  'master-combo',
  'burger-combo',
  'solo-combo',
  'finger-duo',
  'burger-duo',
  'mix-duo',
  'fingers-25',
  'fingers-50',
  'fingers-75',
  'fingers-100',
  'fingers',
  'toast',
  'coleslaw',
  'wedges',
  'sauce',
  'sauce-hot',
  'burger',
  'lemonade',
  'cola',
  'fuse-peach',
  'iced-tea',
  'water',
  'piko',
];
/**
 * The photo product page is used for every seeded product and for any product the back-office
 * gave an uploaded photo (media map hero), so new published products get the same design.
 */
export const hasPhotoPilot = (product: string | { id: string; media?: { hero?: string } }) =>
  typeof product === 'string'
    ? photoProductIds.includes(product)
    : photoProductIds.includes(product.id) || typeof product.media?.hero === 'string';
export const isComboProduct = (id: string) =>
  id.endsWith('-combo') || id.endsWith('-duo') || /^fingers-(25|50|75|100)$/.test(id);

/** Allow incomplete required groups while editing, but keep catalog maxima and stop-list. */
export function setPhotoChoice(
  selections: Selection[],
  group: ModifierGroup,
  optionId: string,
  quantity: number,
): Selection[] {
  const option = group.options.find((o) => o.id === optionId);
  if (!option || !Number.isInteger(quantity) || quantity < 0) return selections;
  const previous =
    selections.find((s) => s.group_id === group.id && s.option_id === optionId)?.quantity ?? 0;
  const others = selections
    .filter((s) => s.group_id === group.id && s.option_id !== optionId)
    .reduce((n, s) => n + s.quantity, 0);
  if (
    quantity > previous &&
    (option.available === false ||
      quantity > (option.max_quantity ?? group.max) ||
      (group.max !== 1 && others + quantity > group.max))
  )
    return selections;
  return [
    ...selections.filter(
      (s) => s.group_id !== group.id || (group.max !== 1 && s.option_id !== optionId),
    ),
    ...(quantity ? [{ group_id: group.id, option_id: optionId, quantity }] : []),
  ];
}

/** Expand the saved quantities into individual replaceable combo slots. */
export function comboSlots(group: ModifierGroup, selections: Selection[]): (string | null)[] {
  const selected = selections
    .filter((s) => s.group_id === group.id)
    .flatMap((s) => Array.from({ length: s.quantity }, () => s.option_id));
  return Array.from({ length: group.min }, (_, index) => selected[index] ?? null);
}

/** Replace one included item without losing the other drink/sauce or paid extras. */
export function replaceComboSlot(
  selections: Selection[],
  group: ModifierGroup,
  index: number,
  optionId: string,
): Selection[] {
  const option = group.options.find((o) => o.id === optionId);
  if (!option || option.available === false || index < 0 || index >= group.min) return selections;
  const slots = comboSlots(group, selections);
  slots[index] = optionId;
  if (slots.filter((id) => id === optionId).length > (option.max_quantity ?? group.max))
    return selections;
  const counts = new Map<string, number>();
  for (const id of slots) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [
    ...selections.filter((s) => s.group_id !== group.id),
    ...Array.from(counts, ([option_id, quantity]) => ({ group_id: group.id, option_id, quantity })),
  ];
}

/** Update a paid extra without altering included choices or exceeding catalog limits. */
export function setExtraQuantity(
  selections: Selection[],
  group: ModifierGroup,
  optionId: string,
  quantity: number,
): Selection[] {
  const option = group.options.find((o) => o.id === optionId);
  if (!option || !Number.isInteger(quantity) || quantity < 0) return selections;
  const previous =
    selections.find((s) => s.group_id === group.id && s.option_id === optionId)?.quantity ?? 0;
  const others = selections
    .filter((s) => s.group_id === group.id && s.option_id !== optionId)
    .reduce((n, s) => n + s.quantity, 0);
  if (
    quantity > previous &&
    (option.available === false ||
      quantity > (option.max_quantity ?? group.max) ||
      others + quantity > group.max)
  )
    return selections;
  if (others + quantity < group.min) return selections;
  return [
    ...selections.filter((s) => !(s.group_id === group.id && s.option_id === optionId)),
    ...(quantity ? [{ group_id: group.id, option_id: optionId, quantity }] : []),
  ];
}

/** Show the full extras catalog; the included small signature sauce is replaced by 300 ml. */
export function recommendedExtras(group: ModifierGroup, selections: Selection[]) {
  const order = ['fingers', 'toast', 'coleslaw', 'wedges'];
  return group.options
    .filter(
      (o) =>
        o.id !== 'sauce' ||
        selections.some((s) => s.group_id === group.id && s.option_id === o.id && s.quantity > 0),
    )
    .sort(
      (a, b) =>
        (order.includes(a.id) ? order.indexOf(a.id) : 99) -
        (order.includes(b.id) ? order.indexOf(b.id) : 99),
    );
}

/** Use the catalog's actual 300 ml product variant, never relabel a 60 ml modifier. */
export function largeSauceOffer(products: Product[]): CartLine | null {
  const product = products.find((p) => p.id === 'sauce');
  const sizes = product?.modifierGroups?.find((g) => g.id === 'size');
  const size = sizes?.options.find(
    (o) => /^(?:0[,.]3\s*л|300\s*мл)$/i.test(o.label.trim()) && o.available !== false,
  );
  if (!product || !sizes || !size) return null;
  const selections = [
    ...defaultSelections(product).filter((s) => s.group_id !== sizes.id),
    { group_id: sizes.id, option_id: size.id, quantity: 1 },
  ];
  return validSelections(product, selections) ? { product, selections, quantity: 1 } : null;
}

/** Companion products keep their real SKU, variant, availability and price. */
export function comboCompanions(productId: string, products: Product[]): CartLine[] {
  if (!isComboProduct(productId)) return [];
  const burger = productId === 'finger-duo' ? products.find((p) => p.id === 'burger') : undefined;
  const selections = burger ? defaultSelections(burger) : [];
  const sauce = largeSauceOffer(products);
  return [
    ...(burger && validSelections(burger, selections)
      ? [{ product: burger, selections, quantity: 1 }]
      : []),
    ...(sauce ? [sauce] : []),
  ];
}

/** Preflight all resulting lines, including a separately priced large sauce. */
export function photoCartLimit(
  cart: CartLine[],
  main: CartLine,
  editing?: CartLine,
  extra?: CartLine | CartLine[],
): string | null {
  const projected = cart.filter((line) => !editing || cartLineKey(line) !== cartLineKey(editing));
  const quantities = new Map(projected.map((line) => [cartLineKey(line), line.quantity]));
  for (const line of [main, ...(Array.isArray(extra) ? extra : extra ? [extra] : [])]) {
    const key = cartLineKey(line);
    const quantity = (quantities.get(key) ?? 0) + line.quantity;
    if (quantity > 20) return 'Можно добавить до 20 одинаковых позиций.';
    quantities.set(key, quantity);
  }
  return quantities.size > 11 ? 'В корзине уже 11 разных позиций.' : null;
}
