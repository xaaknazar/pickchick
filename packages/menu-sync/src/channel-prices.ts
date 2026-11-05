import type { SalesChannel } from '@pickchick/contracts';

/** Cutover Аг4 (contracts section 5.3). Owner after D0: cloud lane. Pure, synchronous. */
export function channelItemPriceMinor(
  item: { price_minor: string; aggregator_prices_minor?: { yandex_eda?: string; glovo?: string } },
  channel: SalesChannel,
): string | null {
  if (channel === 'hall') return item.price_minor;
  return item.aggregator_prices_minor?.[channel] ?? null;
}
/** P0 rule (contracts section 9, q.10): an option surcharge is the hall surcharge everywhere. */
export function channelOptionPriceMinor(
  option: { price_minor: string },
  channel: SalesChannel,
): string {
  void channel;
  return option.price_minor;
}
