import { object, type Data } from './operations-model.js';
export type StockKind = 'receipt' | 'waste' | 'count';
export type StockLine = { ingredient_id: string; quantity: string; unit: string; cost: string };
const limit = 999999999999999n;
export function stockQuantity(value: string, unit: string, base: string): string {
  if (!(unit === base || (base === 'g' && unit === 'kg') || (base === 'ml' && unit === 'l')))
    throw new Error('Единица не соответствует ингредиенту.');
  const scale = unit === 'kg' || unit === 'l' ? 3 : 0;
  return decimal(
    value,
    scale,
    scale ? 'Не больше трёх знаков после запятой.' : 'Введите целое количество в учётной единице.',
  );
}
function decimal(value: string, scale: number, error: string) {
  const m = value
    .trim()
    .replace(',', '.')
    .match(/^(\d+)(?:\.(\d+))?$/);
  if (!m || (m[2]?.length ?? 0) > scale) throw new Error(error);
  const n = BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt((m[2] ?? '').padEnd(scale, '0') || '0');
  if (n > limit) throw new Error('Количество или стоимость слишком велики.');
  return n.toString();
}
export const stockMoney = (v: string) =>
  decimal(v, 2, 'Введите стоимость в тенге, максимум два знака после запятой.');
export function displayQuantity(value: unknown, base: unknown) {
  const n = BigInt(String(value ?? 0));
  if (base !== 'g' && base !== 'ml') return `${n.toLocaleString('ru-RU')} шт`;
  const a = n < 0n ? -n : n;
  const fraction = (a % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${(a / 1000n).toLocaleString('ru-RU')}${fraction ? ',' + fraction : ''} ${base === 'g' ? 'кг' : 'л'}`;
}
export function stockPreview(kind: StockKind, lines: StockLine[], stock: Data[]) {
  if (!lines.length) throw new Error('Добавьте хотя бы один ингредиент.');
  const seen = new Set<string>();
  return lines.map((line) => {
    if (seen.has(line.ingredient_id))
      throw new Error('Ингредиент повторяется. Объедините его в одну строку.');
    seen.add(line.ingredient_id);
    const b = stock.find((v) => v['id'] === line.ingredient_id);
    if (!b) throw new Error('Выберите ингредиент.');
    const p = object(b['payload']);
    const quantity = stockQuantity(line.quantity, line.unit, String(p['unit']));
    const q = BigInt(String(b['quantity'] ?? 0)),
      v = BigInt(String(b['value_minor'] ?? 0)),
      n = BigInt(quantity);
    if (kind !== 'count' && !n) throw new Error('Количество должно быть больше нуля.');
    const delta = kind === 'receipt' ? n : kind === 'waste' ? -n : n - q;
    if (q + delta < 0n) throw new Error(`${p['name']}: недостаточно остатка для списания.`);
    const explicitCost = kind === 'receipt' || (kind === 'count' && q === 0n && n > 0n);
    const value = explicitCost ? stockMoney(line.cost) : '0';
    const dv =
      delta > 0n
        ? kind === 'count' && q > 0n
          ? (v * delta) / q
          : BigInt(value)
        : delta === -q
          ? -v
          : q
            ? (v * delta) / q
            : 0n;
    if (q + delta > limit || v + dv > limit)
      throw new Error('Итоговый остаток или стоимость слишком велики.');
    return {
      command: {
        ingredient_id: line.ingredient_id,
        quantity,
        value_minor: value,
        expected_revision: Number(b['revision'] ?? 0),
      },
      name: String(p['name']),
      unit: String(p['unit']),
      before: q.toString(),
      after: (q + delta).toString(),
      delta: delta.toString(),
      value_delta: dv.toString(),
    };
  });
}
export function stockFilter(stock: Data[], query: string, mode: string) {
  const search = query.trim().toLocaleLowerCase('ru');
  return stock
    .filter((r) => {
      const p = object(r['payload']),
        q = BigInt(String(r['quantity'] ?? 0));
      return (
        String(p['name']).toLocaleLowerCase('ru').includes(search) &&
        (mode === 'all' ||
          (mode === 'inactive'
            ? !p['active']
            : p['active'] &&
              (mode === 'active' ||
                (mode === 'zero' ? q === 0n : q < BigInt(String(p['minimum'] ?? 0))))))
      );
    })
    .sort((a, b) =>
      String(object(a['payload'])['name']).localeCompare(
        String(object(b['payload'])['name']),
        'ru',
      ),
    );
}
export function inventoryCsv(rows: string[][]) {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((v) => '"' + (/^[\s]*[=+@-]/.test(v) ? "'" + v : v).replaceAll('"', '""') + '"')
          .join(';'),
      )
      .join('\r\n')
  );
}
