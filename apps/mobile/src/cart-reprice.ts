import { cartLineKey, cartTotal, lineUnitPrice, validSelections } from './domain.ts';
import type { CartLine, Product, Selection } from './model';

export const PRICES_UPDATED = 'Цены обновились. Проверьте итоговую сумму перед оплатой';

/** Keep the customer's choices that still exist; never substitute a different paid option. */
export function retainSelections(product: Product, selections: Selection[]): Selection[] {
  return selections.filter((selection) => {
    const group = product.modifierGroups?.find((value) => value.id === selection.group_id);
    const option = group?.options.find((value) => value.id === selection.option_id);
    return (
      option && option.available !== false && selection.quantity <= (option.max_quantity ?? 40)
    );
  });
}

export function repriceCart(cart: CartLine[], products: Product[]) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const changes = {
    priceChanged: [] as string[],
    /** Lines removed because a chosen option left the menu (owner decision, no substitute). */
    removed: [] as string[],
    unavailable: [] as string[],
    oldTotal: cart
      .reduce(
        (sum, line) =>
          sum + BigInt(line.previousUnitPriceMinor ?? lineUnitPrice(line)) * BigInt(line.quantity),
        0n,
      )
      .toString(),
    newTotal: '0',
  };
  const next = cart.flatMap((line): CartLine[] => {
    const key = cartLineKey(line);
    const product = byId.get(line.product.id);
    if (!product || product.available === false) {
      changes.unavailable.push(key);
      // A removed dish stays visible until the customer removes it; it cannot be ordered.
      return [
        {
          ...line,
          key,
          product: product ?? { ...line.product, available: false },
          issue: 'unavailable',
        },
      ];
    }
    const selections = retainSelections(product, line.selections ?? []);
    // A line whose chosen option disappeared (or no longer forms a valid choice) is removed
    // entirely. Nothing is substituted; the total change is reported by the price notice only.
    if (
      selections.length !== (line.selections?.length ?? 0) ||
      !validSelections(product, selections)
    ) {
      changes.removed.push(key);
      return [];
    }
    const oldPrice = lineUnitPrice(line);
    const updated: CartLine = { ...line, key, product, selections, issue: undefined };
    if (oldPrice !== lineUnitPrice(updated)) {
      updated.previousUnitPriceMinor = line.previousUnitPriceMinor ?? oldPrice;
    }
    if (updated.previousUnitPriceMinor === lineUnitPrice(updated))
      updated.previousUnitPriceMinor = undefined;
    if (updated.previousUnitPriceMinor !== undefined) changes.priceChanged.push(key);
    return [updated];
  });
  changes.newTotal = cartTotal(next);
  return { cart: next, changes };
}
