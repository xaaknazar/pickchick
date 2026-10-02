import { z } from 'zod';
import { CommerceError } from './model.js';

const time = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
export const RestaurantHoursSchema = z
  .strictObject({
    openingTime: time,
    closingTime: time,
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
  })
  .refine(
    (value) => value.openingTime !== value.closingTime,
    'Opening and closing times must differ',
  );
export type RestaurantHours = z.infer<typeof RestaurantHoursSchema>;
export function restaurantHoursFromEnv(env: NodeJS.ProcessEnv) {
  const values = [
    env.CUSTOMER_KASPI_OPENING_TIME,
    env.CUSTOMER_KASPI_CLOSING_TIME,
    env.CUSTOMER_KASPI_TIMEZONE,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  const result = RestaurantHoursSchema.safeParse({
    openingTime: values[0],
    closingTime: values[1],
    timeZone: values[2],
  });
  if (!result.success) throw new CommerceError('INVALID');
  return result.data;
}
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
/** Daily local opening inclusive, closing exclusive; midnight belongs to the next day. */
export function restaurantOrderingOpen(hours: RestaurantHours | undefined, now: Date) {
  if (!hours) return true;
  if (!Number.isFinite(now.getTime())) throw new CommerceError('INVALID');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const current =
    Number(parts.find((part) => part.type === 'hour')!.value) * 60 +
    Number(parts.find((part) => part.type === 'minute')!.value);
  const opening = minutes(hours.openingTime),
    closing = minutes(hours.closingTime);
  return opening < closing
    ? current >= opening && current < closing
    : current >= opening || current < closing;
}
export function assertRestaurantOrderingOpen(hours: RestaurantHours | undefined, now: Date) {
  if (!restaurantOrderingOpen(hours, now)) throw new CommerceError('RESTAURANT_CLOSED');
}
