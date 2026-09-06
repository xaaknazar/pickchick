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
  if (new Set(cart.items.map((line) => line.variant_id)).size !== cart.items.length)
    throw new OrderError('INVALID_REQUEST');
  const index = new Map(menu.items.map((item) => [item.variant_id, item]));
  if (index.size !== menu.items.length) throw new OrderError('CONFLICT');
  let total = 0n;
  const lines = cart.items.map((line) => {
    const item = index.get(line.variant_id);
    if (!item) throw new OrderError('INVALID_REQUEST');
    const lineTotal = BigInt(item.price_minor) * BigInt(line.quantity);
    total += lineTotal;
    if (total > 9223372036854775807n) throw new OrderError('INVALID_REQUEST');
    return {
      product_id: item.product_id,
      variant_id: item.variant_id,
      name: item.name,
      quantity: line.quantity,
      unit_price_minor: item.price_minor,
      total_minor: lineTotal.toString(),
    };
  });
  return {
    lines,
    subtotal_minor: total.toString(),
    total_minor: total.toString(),
    discount_minor: '0',
    currency: 'KZT',
  };
}
