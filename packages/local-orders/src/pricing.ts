import { CartSchema, MenuSnapshotSchema } from '@pickchick/contracts';
import type { Quote } from '@pickchick/contracts';
import { OrderError } from './errors.js';

export function priceCart(
  menuInput: unknown,
  cartInput: unknown,
): Pick<Quote, 'lines' | 'subtotal_minor' | 'discount_minor' | 'total_minor' | 'currency'> {
  const menu = MenuSnapshotSchema.parse(menuInput);
  const parsed = CartSchema.safeParse(cartInput);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  const cart = parsed.data;
  if (cart.release_id !== menu.release_id) throw new OrderError('MENU_CHANGED');
  const identities = new Set<string>();
  const index = new Map(menu.items.map((item) => [item.variant_id, item]));
  if (index.size !== menu.items.length) throw new OrderError('CONFLICT');
  let total = 0n;
  const lines = cart.items.map((line) => {
    const item = index.get(line.variant_id);
    if (!item) throw new OrderError('INVALID_REQUEST');
    const selected = [...(line.modifiers ?? [])].sort((a, b) =>
      (a.group_id + a.option_id).localeCompare(b.group_id + b.option_id),
    );
    const identity = JSON.stringify([
      line.variant_id,
      selected.map((option) => [option.group_id, option.option_id, option.quantity ?? 1]),
    ]);
    if (identities.has(identity)) throw new OrderError('INVALID_REQUEST');
    identities.add(identity);
    const selectionIds = new Set(selected.map((option) => option.group_id + option.option_id));
    if (selectionIds.size !== selected.length) throw new OrderError('INVALID_REQUEST');
    const groups = new Map((item.modifier_groups ?? []).map((group) => [group.id, group]));
    for (const group of groups.values()) {
      const count = selected
        .filter((option) => option.group_id === group.id)
        .reduce((sum, option) => sum + (option.quantity ?? 1), 0);
      if (count < group.min_selected || count > group.max_selected)
        throw new OrderError('INVALID_REQUEST');
    }
    const modifiers = selected.map((selection) => {
      const group = groups.get(selection.group_id);
      const option = group?.options.find((candidate) => candidate.id === selection.option_id);
      if (
        !group ||
        !option ||
        option.available === false ||
        (selection.quantity ?? 1) > (option.max_quantity ?? 1)
      )
        throw new OrderError('INVALID_REQUEST');
      return {
        ...selection,
        quantity: selection.quantity ?? 1,
        group_name: group.name,
        name: option.name,
        price_minor: option.price_minor,
      };
    });
    const unitPrice = modifiers.reduce(
      (sum, option) => sum + BigInt(option.price_minor) * BigInt(option.quantity),
      BigInt(item.price_minor),
    );
    const lineTotal = unitPrice * BigInt(line.quantity);
    total += lineTotal;
    if (total > 9223372036854775807n) throw new OrderError('INVALID_REQUEST');
    return {
      product_id: item.product_id,
      variant_id: item.variant_id,
      name: item.name,
      quantity: line.quantity,
      unit_price_minor: unitPrice.toString(),
      total_minor: lineTotal.toString(),
      ...(modifiers.length ? { modifiers } : {}),
    };
  });
  const result = {
    lines,
    subtotal_minor: total.toString(),
    total_minor: total.toString(),
    discount_minor: '0' as const,
    currency: 'KZT' as const,
  };
  // Leave room for quote metadata and its durable event under the 96 KiB
  // POS transport bound. Reject before a quote/order can become undeliverable.
  if (Buffer.byteLength(JSON.stringify(result)) > 60 * 1024)
    throw new OrderError('INVALID_REQUEST');
  return result;
}
