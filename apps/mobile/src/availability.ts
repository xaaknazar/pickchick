import type { Product, CartLine } from './model';
export interface Availability {
  enabled: boolean;
  fresh: boolean;
  signature: string;
  products: {
    id: string;
    available: boolean;
    stoppedOptions: { groupId: string; optionId: string }[];
  }[];
}
export function parseAvailability(input: unknown): Availability {
  const v = input as Availability;
  if (
    !v ||
    typeof v.enabled !== 'boolean' ||
    typeof v.fresh !== 'boolean' ||
    typeof v.signature !== 'string' ||
    !(/^[a-f0-9]{64}$/.test(v.signature) || v.signature === 'disabled') ||
    !Array.isArray(v.products) ||
    v.products.length > 2000
  )
    throw Error('INVALID_AVAILABILITY');
  for (const p of v.products) {
    if (
      typeof p.id !== 'string' ||
      typeof p.available !== 'boolean' ||
      !Array.isArray(p.stoppedOptions) ||
      p.stoppedOptions.length > 5000 ||
      p.stoppedOptions.some((o) => typeof o.groupId !== 'string' || typeof o.optionId !== 'string')
    )
      throw Error('INVALID_AVAILABILITY');
  }
  return v;
}
export function withAvailability(products: Product[], state: Availability | null): Product[] {
  if (!state?.enabled) return products;
  return products.map((p) => {
    const current = state.products.find((c) => c.id === p.id);
    if (!current) return { ...p, available: false };
    return {
      ...p,
      available: current.available,
      modifierGroups: p.modifierGroups?.map((g) => ({
        ...g,
        options: g.options.map((o) => ({
          ...o,
          available:
            o.available !== false &&
            !current.stoppedOptions.some((s) => s.groupId === g.id && s.optionId === o.id),
        })),
      })),
    };
  });
}
export function unavailableCartLine(line: CartLine) {
  if (line.product.available === false) return 'Сейчас нет в наличии';
  if (
    line.selections?.some(
      (s) =>
        s.quantity > 0 &&
        line.product.modifierGroups
          ?.find((g) => g.id === s.group_id)
          ?.options.find((o) => o.id === s.option_id)?.available === false,
    )
  )
    return 'Выбранный вариант закончился. Измените состав';
  return null;
}
