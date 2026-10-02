import type { Product, CartLine } from './model';
export interface Availability {
  enabled: boolean;
  orderingOpen?: boolean;
  hours?: { openingTime: string; closingTime: string; timeZone: string };
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
    (v.orderingOpen !== undefined && typeof v.orderingOpen !== 'boolean') ||
    (v.hours !== undefined &&
      (!v.hours ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.hours.openingTime) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.hours.closingTime) ||
        typeof v.hours.timeZone !== 'string')) ||
    typeof v.signature !== 'string' ||
    !(/^[a-f0-9]{64}$/.test(v.signature) || v.signature === 'disabled') ||
    !Array.isArray(v.products) ||
    v.products.length > 2000
  )
    throw Error('INVALID_AVAILABILITY');
  for (const p of v.products) {
    if (
      !p ||
      typeof p !== 'object' ||
      typeof p.id !== 'string' ||
      typeof p.available !== 'boolean' ||
      !Array.isArray(p.stoppedOptions) ||
      p.stoppedOptions.length > 5000 ||
      p.stoppedOptions.some(
        (o) =>
          !o ||
          typeof o !== 'object' ||
          typeof o.groupId !== 'string' ||
          typeof o.optionId !== 'string',
      )
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

export type AvailabilityStatus =
  'checking' | 'current' | 'stale' | 'offline' | 'error' | 'disabled' | 'closed';
export type AvailabilityReadState = {
  data: Availability | null;
  status: 'checking' | 'online' | 'offline' | 'error';
};
export function availabilityStatus(state: AvailabilityReadState): AvailabilityStatus {
  if (state.status !== 'online') return state.status;
  if (!state.data) return 'checking';
  if (!state.data.enabled) return 'disabled';
  if (state.data.orderingOpen === false) return 'closed';
  return state.data.fresh ? 'current' : 'stale';
}
/** Design samples never consume a live restaurant's availability or retained hours. */
export function catalogAvailability(state: AvailabilityReadState, serverCatalog: boolean) {
  const status = serverCatalog ? availabilityStatus(state) : undefined;
  return {
    availabilityFresh:
      status === undefined || status === 'disabled' ? undefined : status === 'current',
    availabilityStatus: status,
    availabilityHours: serverCatalog ? state.data?.hours : undefined,
  };
}
export function availabilityMessage(
  status?: AvailabilityStatus,
  hours?: Availability['hours'],
): string | null {
  if (status === 'closed')
    return hours
      ? `Ресторан сейчас закрыт. Принимаем заказы с ${hours.openingTime} до ${hours.closingTime}.`
      : 'Ресторан сейчас закрыт.';
  if (status === 'checking') return 'Проверяем доступность блюд.';
  if (status === 'offline')
    return 'Не удалось связаться с сервером. Проверьте интернет - связь проверяется автоматически.';
  if (status === 'stale') return 'Нет свежих данных от ресторана. Проверяем связь автоматически.';
  if (status === 'error') return 'Не удалось проверить доступность блюд. Повторите проверку.';
  return null;
}
