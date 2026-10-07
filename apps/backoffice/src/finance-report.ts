import type { FinanceSnapshot } from './finance-model.js';

export type Basis = 'cash' | 'pnl';
export function reportData(d: FinanceSnapshot, basis: Basis) {
  const lines = d.categories
    .map((category) => {
      const matches = d.summaries.filter((s) => s.category_id === category.id);
      const value = matches.reduce(
        (n, s) => n + BigInt(basis === 'pnl' ? s.pnl_minor : s.cash_minor),
        0n,
      );
      return { ...category, value, signed: category.direction === 'in' ? value : -value, matches };
    })
    .filter((c) => basis !== 'pnl' || c.group !== 'none');
  const incoming = lines.filter((c) => c.direction === 'in').reduce((n, c) => n + c.value, 0n);
  const outgoing = lines.filter((c) => c.direction === 'out').reduce((n, c) => n + c.value, 0n);
  const groups: Record<string, bigint> = {};
  for (const c of lines) {
    const key = basis === 'pnl' ? c.group : c.cashflow;
    groups[key] = (groups[key] ?? 0n) + c.signed;
  }
  return { lines, groups, incoming, outgoing, net: incoming - outgoing };
}

// Integer rounding keeps percentages exact even when period totals exceed Number.MAX_SAFE_INTEGER.
export function percent(value: bigint, base: bigint) {
  if (base <= 0n) return '-';
  const absolute = value < 0n ? -value : value;
  const tenths = (absolute * 1000n + base / 2n) / base;
  return `${value < 0n ? '-' : ''}${tenths / 10n},${tenths % 10n}%`;
}
export function chartWidth(value: bigint, maximum: bigint) {
  if (maximum <= 0n || value <= 0n) return 0;
  return Number((value * 10000n) / maximum) / 100;
}

export function timeSeries(d: FinanceSnapshot, basis: Basis, start: string, end: string) {
  if (!d.timeline) return null; // Old API must never masquerade as a zero-data chart.
  const monthly = Date.parse(end) - Date.parse(start) > 45 * 86400000;
  const buckets = new Map<string, { date: string; incoming: bigint; outgoing: bigint }>();
  const cursor = new Date(start + 'T00:00:00Z');
  if (monthly) cursor.setUTCDate(1);
  while (cursor.toISOString().slice(0, 10) <= end) {
    const key = cursor.toISOString().slice(0, monthly ? 7 : 10);
    buckets.set(key, { date: key, incoming: 0n, outgoing: 0n });
    if (monthly) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const point of d.timeline) {
    if (point.basis !== basis || point.date < start || point.date > end) continue;
    const bucket = buckets.get(point.date.slice(0, monthly ? 7 : 10));
    if (bucket) {
      bucket.incoming += BigInt(point.in_minor);
      bucket.outgoing += BigInt(point.out_minor);
    }
  }
  return { monthly, points: [...buckets.values()] };
}
