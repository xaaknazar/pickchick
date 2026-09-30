import type { CatalogPayload } from '@pickchick/catalog-admin/contracts';
export type { CatalogPayload };
export type Product = CatalogPayload['products'][number];
export type Group = Product['modifier_groups'][number];
export type Branch = { id: string; code: string; name: string };
export type Actor = { id: string; name: string };
export type CatalogState = {
  branch: Branch;
  draft: null | {
    revision: number;
    base_version: number;
    updated_at: string;
    updated_by: string;
    payload: CatalogPayload;
  };
  published: null | {
    version: number;
    published_at: string;
    published_by: string;
    payload: CatalogPayload;
  };
};
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const idPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const assetKeys = [
  'generic-drink',
  'shot.jpg',
  ...Array.from({ length: 24 }, (_, i) => `i${i}.jpg`).filter(
    (v) => v !== 'i3.jpg' && v !== 'i21.jpg',
  ),
];
export function toMinor(input: string): string {
  const value = input
    .trim()
    .replace(/[ \u00a0\u202f]/g, '')
    .replace(',', '.');
  if (!/^(0|[1-9]\d{0,16})(\.\d{1,2})?$/.test(value))
    throw new Error('Укажите цену без знака, до двух цифр после запятой.');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > 9999999999999999n) throw new Error('Цена превышает допустимый предел.');
  return result.toString();
}
export function toMajor(minor: string): string {
  if (!/^(0|[1-9]\d{0,15})$/.test(minor) || BigInt(minor) > 9999999999999999n)
    throw new Error('Некорректная цена сервера.');
  const value = BigInt(minor);
  return `${value / 100n}${value % 100n ? `,${(value % 100n).toString().padStart(2, '0')}` : ''}`;
}
export const money = (minor: string) => {
  const [whole, fraction] = toMajor(minor).split(',');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${fraction ? `,${fraction}` : ''} ₸`;
};
export const copy = <T>(value: T): T => structuredClone(value);
export function productIssues(p: Product, payload: CatalogPayload): string[] {
  const errors: string[] = [];
  const text = (value: string, label: string, max: number, required = false) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
      errors.push(`${label}: ${required ? 'обязательное поле, ' : ''}до ${max} символов.`);
  };
  const integer = (n: number, label: string, min: number, max: number) => {
    if (!Number.isInteger(n) || n < min || n > max)
      errors.push(`${label}: целое число от ${min} до ${max}.`);
  };
  const localized = (
    v: { ru: string; kk: string },
    label: string,
    max: number,
    required = false,
  ) => {
    text(v.ru, `${label} · RU`, max, required);
    text(v.kk, `${label} · KZ`, max);
  };
  if (!idPattern.test(p.id)) errors.push('ID: латинские буквы, цифры и дефисы, до 40 символов.');
  localized(p.name, 'Название', 150, true);
  localized(p.description, 'Описание', 2000);
  localized(p.ingredients, 'Состав', 2000);
  localized(p.serving_label, 'Порция', 150, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.sku))
    errors.push('Артикул: латинские буквы, цифры, точка, дефис или подчёркивание; до 64 символов.');
  if (!payload.categories.some((c) => c.id === p.category_id))
    errors.push('Выберите существующую категорию.');
  if (!assetKeys.includes(p.image_asset_key))
    errors.push('Выберите изображение из каталога ресурсов.');
  try {
    toMajor(p.price_minor);
  } catch {
    errors.push('Цена: некорректная сумма.');
  }
  integer(p.prep_minutes, 'Время приготовления', 1, 120);
  for (const key of ['weight_g', 'volume_ml'] as const)
    if (p[key] !== null) integer(p[key]!, key === 'weight_g' ? 'Вес' : 'Объём', 1, 100000);
  if (new Set(p.allergens).size !== p.allergens.length)
    errors.push('Аллергены не должны повторяться.');
  if (
    !['item', 'combo', 'set'].includes(p.kind) ||
    !['unknown', 'declared'].includes(p.allergens_status) ||
    !['unverified', 'operator_entered'].includes(p.nutrition_status) ||
    !['per_serving', 'per_100_g'].includes(p.nutrition.basis) ||
    typeof p.available !== 'boolean' ||
    typeof p.prep_required !== 'boolean'
  )
    errors.push('Проверьте статусы позиции.');
  if (
    p.combo_components.length > 40 ||
    new Set(p.combo_components.map((c) => c.product_id)).size !== p.combo_components.length ||
    (p.kind === 'item' && p.combo_components.length)
  )
    errors.push(
      'Проверьте состав комбо: максимум 40 уникальных компонентов, только для комбо/сетов.',
    );
  if (p.allergens.length > 30 || p.allergens.some((a) => !a.trim() || a.length > 100))
    errors.push('Аллергены: до 30 названий, каждое до 100 символов.');
  for (const key of ['energy_kcal', 'protein_g', 'fat_g', 'carbs_g'] as const)
    if (
      !Number.isFinite(p.nutrition[key]) ||
      p.nutrition[key] < 0 ||
      p.nutrition[key] > (key === 'energy_kcal' ? 100000 : 10000)
    )
      errors.push(`КБЖУ: проверьте ${key}.`);
  if (p.modifier_groups.length > 10) errors.push('Не более 10 групп модификаторов.');
  if (new Set(p.modifier_groups.map((g) => g.id)).size !== p.modifier_groups.length)
    errors.push('ID групп не должны повторяться.');
  for (const g of p.modifier_groups) {
    if (!idPattern.test(g.id)) errors.push('Проверьте ID группы.');
    localized(g.title, 'Группа', 150, true);
    integer(g.min, 'Минимум группы', 0, 100);
    integer(g.max, 'Максимум группы', 1, 100);
    if (g.min > g.max) errors.push('Минимум группы больше максимума.');
    if (!g.options.length || g.options.length > 20)
      errors.push('Группа содержит от 1 до 20 вариантов.');
    if (new Set(g.options.map((o) => o.id)).size !== g.options.length)
      errors.push('ID вариантов внутри группы должны отличаться.');
    for (const o of g.options) {
      if (!idPattern.test(o.id)) errors.push('Проверьте ID варианта.');
      localized(o.label, 'Вариант', 150, true);
      try {
        toMajor(o.price_delta_minor);
      } catch {
        errors.push('Проверьте доплату варианта.');
      }
      integer(o.max_quantity, 'Лимит варианта', 1, 40);
      integer(o.default_quantity, 'По умолчанию', 0, o.max_quantity);
      if (!o.available && o.default_quantity)
        errors.push('Недоступный вариант нельзя выбирать по умолчанию.');
      if (
        typeof o.available !== 'boolean' ||
        (o.nutrition_multiplier !== undefined &&
          (!Number.isFinite(o.nutrition_multiplier) ||
            o.nutrition_multiplier <= 0 ||
            o.nutrition_multiplier > 100))
      )
        errors.push('Проверьте доступность или множитель варианта.');
      if (o.linked_product_id && !payload.products.some((v) => v.id === o.linked_product_id))
        errors.push('Связанная позиция модификатора отсутствует.');
    }
    const defaults = g.options.reduce((n, o) => n + o.default_quantity, 0);
    if (g.options.filter((o) => o.available).reduce((n, o) => n + o.max_quantity, 0) < g.min)
      errors.push('Недостаточно доступных вариантов для минимального выбора.');
    if (defaults > g.max || defaults < g.min)
      errors.push(
        `Группа «${g.title.ru}»: выбор по умолчанию должен соответствовать минимуму/максимуму.`,
      );
  }
  for (const component of p.combo_components) {
    if (
      component.product_id === p.id ||
      !payload.products.some((v) => v.id === component.product_id)
    )
      errors.push('Компонент комбо должен ссылаться на другую существующую позицию.');
    integer(component.quantity, 'Количество компонента', 1, 1000);
  }
  return [...new Set(errors)];
}
export function payloadIssues(p: CatalogPayload): string[] {
  const errors: string[] = [];
  if (new TextEncoder().encode(JSON.stringify(p)).length > 262144)
    errors.push('Каталог превышает 256 КиБ.');
  if (p.products.length < 1 || p.products.length > 100)
    errors.push('В каталоге должно быть от 1 до 100 позиций.');
  if (!['mockup', 'operator'].includes(p.content_source) || typeof p.content_reviewed !== 'boolean')
    errors.push('Некорректный источник данных.');
  if (
    new Set(p.categories.map((c) => c.id)).size !== p.categories.length ||
    p.categories.some(
      (c) =>
        !idPattern.test(c.id) ||
        !c.name.ru.trim() ||
        c.name.ru.length > 150 ||
        typeof c.name.kk !== 'string' ||
        c.name.kk.length > 150,
    )
  )
    errors.push('Проверьте категории.');
  if (
    !Number.isInteger(p.estimated_minutes.min) ||
    !Number.isInteger(p.estimated_minutes.max) ||
    p.estimated_minutes.min < 1 ||
    p.estimated_minutes.max > 120 ||
    p.estimated_minutes.min > p.estimated_minutes.max
  )
    errors.push('Проверьте время приготовления каталога.');
  if (p.categories.length < 1 || p.categories.length > 30)
    errors.push('Допустимо от 1 до 30 категорий.');
  if (
    new Set(p.products.map((v) => v.id)).size !== p.products.length ||
    new Set(p.products.map((v) => v.sku)).size !== p.products.length
  )
    errors.push('ID и артикулы позиций должны быть уникальными.');
  for (const product of p.products)
    errors.push(...productIssues(product, p).map((v) => `${product.name.ru}: ${v}`));
  if (
    p.upsell_product_ids.length > 20 ||
    new Set(p.upsell_product_ids).size !== p.upsell_product_ids.length ||
    p.upsell_product_ids.some((id) => !p.products.some((v) => v.id === id))
  )
    errors.push('Проверьте список рекомендаций.');
  const graph = new Map(
    p.products.map((v) => [
      v.id,
      [
        ...v.combo_components.map((c) => c.product_id),
        ...v.modifier_groups.flatMap((g) =>
          g.options.map((o) => o.linked_product_id).filter((id): id is string => Boolean(id)),
        ),
      ],
    ]),
  );
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (done.has(id)) return true;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) if (!visit(next)) return false;
    visiting.delete(id);
    done.add(id);
    return true;
  };
  if (p.products.some((v) => !visit(v.id)))
    errors.push('Компоненты или модификаторы образуют цикл ссылок.');
  return [...new Set(errors)];
}
export function parsePayload(value: unknown): CatalogPayload {
  try {
    const p = value as CatalogPayload;
    if (
      p.schema_version !== 1 ||
      p.currency !== 'KZT' ||
      !Array.isArray(p.categories) ||
      !Array.isArray(p.products) ||
      !Array.isArray(p.upsell_product_ids) ||
      typeof p.content_reviewed !== 'boolean'
    )
      throw new Error();
    if (payloadIssues(p).length) throw new Error();
    return copy(p);
  } catch {
    throw new Error('INVALID_RESPONSE');
  }
}
export function parseState(value: unknown): CatalogState {
  try {
    const state = value as CatalogState;
    if (!uuidPattern.test(state.branch.id) || typeof state.branch.name !== 'string')
      throw new Error();
    if (state.draft) {
      if (
        !Number.isInteger(state.draft.revision) ||
        state.draft.revision < 1 ||
        !Number.isInteger(state.draft.base_version) ||
        state.draft.base_version < 0
      )
        throw new Error();
      parsePayload(state.draft.payload);
    }
    if (state.published) {
      if (!Number.isInteger(state.published.version) || state.published.version < 1)
        throw new Error();
      parsePayload(state.published.payload);
    }
    return copy(state);
  } catch {
    throw new Error('INVALID_RESPONSE');
  }
}
