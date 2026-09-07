import { TestSelectionSchema, testLineId } from '@pickchick/test-order-flow/contracts';
import type { KioskProduct, KioskSelection } from './model';

export { testLineId };
export function defaultSelections(product: KioskProduct): KioskSelection[] {
  return product.modifier_groups.flatMap((group) =>
    group.options
      .filter((option) => option.available && option.default_quantity > 0)
      .map((option) => ({
        group_id: group.id,
        option_id: option.id,
        quantity: option.default_quantity,
      })),
  );
}
export function validSelections(product: KioskProduct, selections: KioskSelection[]): boolean {
  if (
    !Array.isArray(selections) ||
    selections.length > 40 ||
    selections.some((selection) => !TestSelectionSchema.safeParse(selection).success)
  )
    return false;
  if (new Set(selections.map((s) => `${s.group_id}:${s.option_id}`)).size !== selections.length)
    return false;
  if (
    selections.some(
      (selection) =>
        !product.modifier_groups.some(
          (group) =>
            group.id === selection.group_id &&
            group.options.some(
              (option) =>
                option.id === selection.option_id &&
                option.available &&
                selection.quantity <= option.max_quantity,
            ),
        ),
    )
  )
    return false;
  return product.modifier_groups.every((group) => {
    const quantity = selections
      .filter((selection) => selection.group_id === group.id)
      .reduce((total, selection) => total + selection.quantity, 0);
    return quantity >= group.min && quantity <= group.max;
  });
}
/** Preview only. The authoritative price is the API's immutable quote. */
export function selectedPriceMinor(product: KioskProduct, selections: KioskSelection[]): string {
  if (!validSelections(product, selections)) throw new Error('INVALID_SELECTIONS');
  return (
    BigInt(product.price_minor) +
    selections.reduce((sum, selection) => {
      const option = product.modifier_groups
        .find((group) => group.id === selection.group_id)!
        .options.find((option) => option.id === selection.option_id)!;
      return sum + BigInt(option.price_delta_minor) * BigInt(selection.quantity);
    }, 0n)
  ).toString();
}
export function money(minor: string): string {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(minor)) throw new Error('INVALID_MONEY');
  const amount = BigInt(minor);
  const fraction = amount % 100n;
  return `${(amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${fraction ? `,${fraction.toString().padStart(2, '0')}` : ''} ₸`;
}
