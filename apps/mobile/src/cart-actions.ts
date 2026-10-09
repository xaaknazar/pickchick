import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import type { CartLine, Product } from './model';
import { selectionKey, defaultSelections, lineUnitPrice, validSelections } from './domain.ts';

/** Add all configurations or none. Never replace an existing basket or use historic prices. */
export function mergeCartLines(cart: CartLine[], additions: CartLine[], products: Product[]) {
  let next = [...cart];
  for (const line of additions) {
    const product = products.find(
      (p) => p.id === line.product.id && p.source === line.product.source,
    );
    if (
      !product ||
      lineUnitPrice(line) !== lineUnitPrice({ ...line, product }) ||
      !validSelections(product, line.selections ?? []) ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      next.some((l) => l.product.source !== product.source)
    )
      return null;
    const existing = next.find(
      (l) =>
        l.product.id === product.id && selectionKey(l.selections) === selectionKey(line.selections),
    );
    const quantity = (existing?.quantity ?? 0) + line.quantity;
    if (quantity > 20) return null;
    const updated = {
      ...existing,
      ...line,
      key: existing?.key ?? line.key,
      product,
      quantity,
      issue: undefined,
    };
    next = existing ? next.map((l) => (l === existing ? updated : l)) : [...next, updated];
    if (next.length > 11) return null;
  }
  return next;
}

export function repeatOrderPlan(order: TestOrder, products: Product[]) {
  const lines: CartLine[] = [];
  const changes: { name: string; reason: string; before?: string; after?: string }[] = [];
  for (const saved of order.snapshot.lines) {
    const product = products.find((p) => p.id === saved.id);
    if (!product) {
      changes.push({ name: saved.name, reason: 'Сейчас нет в меню' });
      continue;
    }
    const selections =
      'selections' in saved
        ? saved.selections.map(({ group_id, option_id, quantity }) => ({
            group_id,
            option_id,
            quantity,
          }))
        : [];
    if (!validSelections(product, selections)) {
      changes.push({
        name: saved.name,
        reason: 'Состав изменился. Выберите это блюдо заново в меню',
      });
      continue;
    }
    const line = { product, selections, quantity: saved.quantity };
    const after = (BigInt(lineUnitPrice(line)) * BigInt(line.quantity)).toString();
    if (after !== saved.line_total_minor)
      changes.push({
        name: saved.name,
        reason: 'Новая цена',
        before: saved.line_total_minor,
        after,
      });
    lines.push(line);
  }
  return { lines, changes };
}

/** Complements the actual basket, including paid modifiers; only published SKUs are used. */
export function cartRecommendations(cart: CartLine[], products: Product[]): CartLine[] {
  const present = new Set(cart.map((l) => l.product.id));
  for (const line of cart)
    for (const choice of line.selections ?? []) {
      if (choice.quantity > 0 && choice.group_id === 'extras') present.add(choice.option_id);
    }
  const burger = cart.some((l) => /burger|mix-duo/.test(l.product.id));
  const fingers = cart.some((l) =>
    /finger|pick-combo|master-combo|solo-combo|mix-duo/.test(l.product.id),
  );
  if (burger) present.add('burger');
  if (fingers) present.add('fingers');
  const ids = [
    ...(burger && !fingers ? ['fingers'] : fingers && !burger ? ['burger'] : []),
    'wedges',
    'coleslaw',
    'toast',
    ...products.filter((product) => product.category === 'Напитки').map((product) => product.id),
  ];
  return [...new Set(ids)]
    .filter((id) => !present.has(id))
    .flatMap((id) => {
      const product = products.find((p) => p.id === id);
      if (!product) return [];
      const selections = defaultSelections(product);
      const line = { product, selections, quantity: 1 };
      return validSelections(product, selections) && mergeCartLines(cart, [line], products)
        ? [line]
        : [];
    });
}
