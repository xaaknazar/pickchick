import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CATALOG_ASSET_KEYS,
  CatalogKitchenRouteSchema,
  CatalogPayloadSchema,
  type CatalogModifier,
  type CatalogPayload,
  type CatalogProduct,
} from './contracts.js';

// Owner-reviewed bar drinks from iiko (docs/operations/iiko-menu-details-2026-09-28.md) that the
// published catalog does not sell standalone. Pure: no network, no clock, input never mutated.
// Owner decision 12.10.2026 («цены делай так как в бэкофисе стоит»): a new drink costs what its
// analog (`price_like`) costs in the given back-office draft, a new combo choice costs what the
// analog choice (`price_delta_like`) of the same group costs. iiko prices stay informational.
export const BAR_DRINKS_FORMAT = 'pickchick-catalog-bar-drinks-v1';
/** Drink choice group of every combo/duo; the Piko flavor change uses the same id. */
export const COMBO_DRINK_GROUP_ID = 'drink';
/** CatalogModifierSchema and the edge MenuSnapshot both cap a group at 20 options. */
export const CATALOG_MAX_GROUP_OPTIONS = 20;
/** CatalogPayloadSchema caps a branch catalog at 100 products. */
export const CATALOG_MAX_PRODUCTS = 100;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const Minor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
const Text = z.string().trim().min(1).max(150);
const IikoSku = z.string().regex(/^[0-9]{5}$/);
/** Exactly one price source: an analog in the back-office draft or an explicit price. */
const oneOf = (like: string, minor: string) => ({
  check: (value: Record<string, unknown>) =>
    (value[like] === undefined) !== (value[minor] === undefined),
  message: `Exactly one of ${like} / ${minor} is required`,
});
const deltaSource = oneOf('price_delta_like', 'price_delta_minor');
const priceSource = oneOf('price_like', 'price_minor');
export const BarDrinkSchema = z
  .strictObject({
    id: Id,
    iiko_sku: IikoSku,
    iiko_name: Text,
    name_ru: Text,
    description_ru: z.string().trim().max(2000),
    /** Product id whose current draft price (and channel prices) the new drink gets. */
    price_like: Id.optional(),
    /** Explicit price; only when no analog is named. */
    price_minor: Minor.optional(),
    /** iiko reference price; informational, never sold. */
    iiko_price_minor: Minor.optional(),
    volume_ml: z.int().min(1).max(100000),
    available: z.boolean(),
    image_asset_key: z.enum(CATALOG_ASSET_KEYS),
    kitchen_route: CatalogKitchenRouteSchema,
    nutrition: z.strictObject({
      energy_kcal: z.number().min(0).max(100000),
      protein_g: z.number().min(0).max(10000),
      fat_g: z.number().min(0).max(10000),
      carbs_g: z.number().min(0).max(10000),
    }),
    nutrition_note: z.string().max(300),
    note: z.string().max(500).optional(),
    /** Choice in every combo drink group; null keeps the drink out of combos. */
    combo_option: z
      .strictObject({
        iiko_sku: IikoSku,
        label_ru: Text,
        /** Choice id of the same combo group whose current surcharge the new choice gets. */
        price_delta_like: Id.optional(),
        /** Explicit surcharge; only when no analog choice is named. */
        price_delta_minor: Minor.optional(),
        /** iiko reference surcharge (group 0007); informational. */
        iiko_price_delta_minor: Minor.optional(),
        available: z.boolean(),
      })
      .refine(deltaSource.check, { message: deltaSource.message })
      .nullable(),
  })
  .refine(priceSource.check, { message: priceSource.message })
  .refine((drink) => drink.price_like !== drink.id, {
    message: 'price_like must name another product',
  });
export const BarDrinksSpecSchema = z
  .strictObject({
    format: z.literal(BAR_DRINKS_FORMAT),
    approved_by_owner: z.boolean(),
    approval_note: z.string().max(1000),
    source: z.string().max(1000),
    category_name_ru: Text,
    drinks: z.array(BarDrinkSchema).min(1).max(40),
  })
  .refine((spec) => new Set(spec.drinks.map((d) => d.id)).size === spec.drinks.length, {
    message: 'Duplicate drink id',
  });
export type BarDrink = z.infer<typeof BarDrinkSchema>;
export type BarDrinksSpec = z.infer<typeof BarDrinksSpecSchema>;
/** Where a price came from: the analog in the input draft, or null for a price in the data. */
export interface BarDrinkPriceFrom {
  product_id: string;
  name: string;
}
export interface BarDrinkDeltaFrom {
  option_id: string;
  label: string;
}
export type BarDrinksChange =
  | {
      kind: 'product_added';
      product_id: string;
      name: string;
      price_minor: string;
      price_from: BarDrinkPriceFrom | null;
      available: boolean;
    }
  | { kind: 'product_available'; product_id: string; from: boolean; to: boolean }
  | {
      kind: 'combo_option_added';
      product_id: string;
      group_id: string;
      option_id: string;
      price_delta_minor: string;
      price_delta_from: BarDrinkDeltaFrom | null;
    };
export interface BarDrinksResult {
  payload: CatalogPayload;
  changes: BarDrinksChange[];
  warnings: string[];
}
export class BarDrinksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarDrinksError';
  }
}

/** Integer minor units as tenge text, without floating point. */
export function formatMinor(minor: string): string {
  const value = BigInt(Minor.parse(minor));
  const rest = value % 100n;
  return `${value / 100n}${rest ? '.' + String(rest).padStart(2, '0') : ''} ₸`;
}
/** Key-order independent JSON: PostgreSQL jsonb returns payload keys in its own order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
export const catalogDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Russian note for the operator: which back-office position a price was copied from. */
export const priceFromNote = (name: string) => `как «${name}» в бэк-офисе`;

interface ResolvedPrice {
  price_minor: string;
  channel_prices_minor: CatalogProduct['channel_prices_minor'];
  from: BarDrinkPriceFrom | null;
}
/** Price of a drink from its analog in the input draft; never a silent fallback. */
function resolvePrice(drink: BarDrink, source: CatalogPayload): ResolvedPrice {
  if (drink.price_like === undefined)
    return { price_minor: drink.price_minor!, channel_prices_minor: undefined, from: null };
  const analog = source.products.find((p) => p.id === drink.price_like);
  if (!analog)
    throw new BarDrinksError(
      `${drink.id}: price analog ${drink.price_like} is not in the back-office draft; add it or name another price_like`,
    );
  return {
    price_minor: analog.price_minor,
    channel_prices_minor:
      analog.channel_prices_minor && structuredClone(analog.channel_prices_minor),
    from: { product_id: analog.id, name: analog.name.ru },
  };
}
/** Surcharge of a combo choice from the analog choice of the same group, before this run. */
function resolveDelta(
  drink: BarDrink,
  original: ReadonlyMap<string, CatalogModifier['options'][number]>,
  where: string,
): { price_delta_minor: string; from: BarDrinkDeltaFrom | null } {
  const option = drink.combo_option!;
  if (option.price_delta_like === undefined)
    return { price_delta_minor: option.price_delta_minor!, from: null };
  const analog = original.get(option.price_delta_like);
  if (!analog)
    throw new BarDrinksError(
      `${where}: no choice ${option.price_delta_like} to price the ${drink.id} choice like; review this combo in the back-office`,
    );
  return {
    price_delta_minor: analog.price_delta_minor,
    from: { option_id: analog.id, label: analog.label.ru },
  };
}

function drinkProduct(drink: BarDrink, categoryId: string, price: ResolvedPrice): CatalogProduct {
  const text = (ru: string) => ({ ru, kk: '' });
  return {
    id: drink.id,
    sku: drink.id,
    name: text(drink.name_ru),
    // Existing drinks repeat the short description as their composition line.
    description: text(drink.description_ru),
    category_id: categoryId,
    price_minor: price.price_minor,
    ...(price.channel_prices_minor ? { channel_prices_minor: price.channel_prices_minor } : {}),
    image_asset_key: drink.image_asset_key,
    kitchen_route: drink.kitchen_route,
    available: drink.available,
    prep_required: false,
    prep_minutes: 1,
    serving_label: text(`${drink.volume_ml} мл`),
    weight_g: null,
    volume_ml: drink.volume_ml,
    ingredients: text(drink.description_ru),
    allergens: [],
    allergens_status: 'unknown',
    nutrition: { basis: 'per_serving', ...drink.nutrition },
    nutrition_status: 'unverified',
    kind: 'item',
    combo_components: [],
    modifier_groups: [],
  };
}
function comboOption(
  drink: BarDrink,
  group: CatalogModifier,
  priceDeltaMinor: string,
): CatalogModifier['options'][number] {
  const option = drink.combo_option!;
  return {
    id: drink.id,
    label: { ru: option.label_ru, kk: '' },
    price_delta_minor: priceDeltaMinor,
    default_quantity: 0,
    max_quantity: Math.min(40, group.max),
    available: option.available,
    // Combos are not expanded into components; a linked product would need its own kitchen
    // route (cloud-kitchen taskPlan) and would block publication while it is unavailable.
    linked_product_id: null,
  };
}

/**
 * Adds every missing drink of the reviewed spec as a standalone product of the named category,
 * placed after that category's last product; an existing drink only gets the reviewed
 * availability. With `comboOptions`, every combo drink group receives the missing choices.
 * Prices come from the analogs in the input draft (`price_like`, per group `price_delta_like`);
 * a missing analog stops the run. Existing prices, names and options are reported, never
 * overwritten. Idempotent.
 */
export function withBarDrinks(
  input: unknown,
  specInput: unknown,
  options: { comboOptions: boolean },
): BarDrinksResult {
  const payload = CatalogPayloadSchema.parse(structuredClone(input));
  const spec = BarDrinksSpecSchema.parse(specInput);
  // Analogs are read from the draft as given, never from products this run adds.
  const source = structuredClone(payload);
  const categories = payload.categories.filter((c) => c.name.ru === spec.category_name_ru);
  if (categories.length !== 1)
    throw new BarDrinksError(
      `Expected one category «${spec.category_name_ru}», found ${categories.length}`,
    );
  const category = categories[0]!;
  const changes: BarDrinksChange[] = [];
  const warnings: string[] = [];
  let insertAt = payload.products.findLastIndex((p) => p.category_id === category.id) + 1;
  if (insertAt === 0) insertAt = payload.products.length;
  for (const drink of spec.drinks) {
    const price = resolvePrice(drink, source);
    const existing = payload.products.find((p) => p.id === drink.id);
    if (existing) {
      if (existing.category_id !== category.id || existing.kind !== 'item')
        throw new BarDrinksError(`Product ${drink.id} exists outside «${category.name.ru}»`);
      if (
        existing.price_minor !== price.price_minor ||
        canonicalJson(existing.channel_prices_minor ?? {}) !==
          canonicalJson(price.channel_prices_minor ?? {})
      )
        warnings.push(
          `${drink.id}: catalog price ${formatMinor(existing.price_minor)} differs from ${formatMinor(price.price_minor)} ${price.from ? `(${priceFromNote(price.from.name)})` : 'in the data file'}; not changed`,
        );
      if (existing.name.ru !== drink.name_ru)
        warnings.push(`${drink.id}: catalog name «${existing.name.ru}» kept`);
      if (existing.available !== drink.available) {
        changes.push({
          kind: 'product_available',
          product_id: drink.id,
          from: existing.available,
          to: drink.available,
        });
        existing.available = drink.available;
      }
      continue;
    }
    if (payload.products.some((p) => p.sku === drink.id))
      throw new BarDrinksError(`SKU ${drink.id} is already used by another product`);
    payload.products.splice(insertAt++, 0, drinkProduct(drink, category.id, price));
    changes.push({
      kind: 'product_added',
      product_id: drink.id,
      name: drink.name_ru,
      price_minor: price.price_minor,
      price_from: price.from,
      available: drink.available,
    });
  }
  if (payload.products.length > CATALOG_MAX_PRODUCTS)
    throw new BarDrinksError(
      `${payload.products.length} products exceed the catalog limit of ${CATALOG_MAX_PRODUCTS}`,
    );
  if (options.comboOptions) {
    const choices = spec.drinks.filter((d) => d.combo_option);
    let groups = 0;
    for (const product of payload.products)
      for (const group of product.modifier_groups) {
        if (group.id !== COMBO_DRINK_GROUP_ID) continue;
        groups++;
        // The group's choices as given: this run's additions never serve as an analog.
        const original = new Map(group.options.map((o) => [o.id, o] as const));
        const where = `${product.id}/${group.id}`;
        for (const drink of choices) {
          const delta = resolveDelta(drink, original, where);
          const current = group.options.find((o) => o.id === drink.id);
          if (current) {
            if (
              current.price_delta_minor !== delta.price_delta_minor ||
              current.label.ru !== drink.combo_option!.label_ru
            )
              warnings.push(
                `${where}/${drink.id}: existing choice «${current.label.ru}» +${formatMinor(current.price_delta_minor)} kept (expected «${drink.combo_option!.label_ru}» +${formatMinor(delta.price_delta_minor)}${delta.from ? `, ${priceFromNote(delta.from.label)}` : ''})`,
              );
            continue;
          }
          group.options.push(comboOption(drink, group, delta.price_delta_minor));
          changes.push({
            kind: 'combo_option_added',
            product_id: product.id,
            group_id: group.id,
            option_id: drink.id,
            price_delta_minor: delta.price_delta_minor,
            price_delta_from: delta.from,
          });
        }
        if (group.options.length > CATALOG_MAX_GROUP_OPTIONS)
          throw new BarDrinksError(
            `${product.id}/${group.id}: ${group.options.length} choices exceed the limit of ${CATALOG_MAX_GROUP_OPTIONS}; decide which choices to drop first`,
          );
      }
    if (!groups) warnings.push(`No «${COMBO_DRINK_GROUP_ID}» groups: combo choices unchanged`);
  }
  if (changes.length) payload.content_source = 'operator';
  return { payload: CatalogPayloadSchema.parse(payload), changes, warnings };
}

/**
 * Diff annotations for added drinks and choices whose price came from a back-office analog:
 * product id, or `<product>/<group>/<option>` for a combo choice -> «как «…» в бэк-офисе».
 */
export function barDrinkPriceNotes(changes: readonly BarDrinksChange[]): Map<string, string> {
  const notes = new Map<string, string>();
  for (const change of changes)
    if (change.kind === 'product_added' && change.price_from)
      notes.set(change.product_id, priceFromNote(change.price_from.name));
    else if (change.kind === 'combo_option_added' && change.price_delta_from)
      notes.set(
        `${change.product_id}/${change.group_id}/${change.option_id}`,
        priceFromNote(change.price_delta_from.label),
      );
  return notes;
}

/** «Name» price (or «Name» - price (как «…» в бэк-офисе) for a priced-like drink), category, state. */
const describeProduct = (p: CatalogProduct, categories: Map<string, string>, note?: string) => {
  const channels = Object.entries(p.channel_prices_minor ?? {})
    .map(([channel, minor]) => `${channel} ${formatMinor(minor!)}`)
    .join(', ');
  const price = `${formatMinor(p.price_minor)}${channels ? ` (${channels})` : ''}`;
  return `«${p.name.ru}» ${note ? `- ${price} (${note})` : price}, ${categories.get(p.category_id) ?? p.category_id}, ${p.available ? 'в продаже' : 'скрыта'}`;
};
const describeOption = (o: CatalogModifier['options'][number], note?: string) =>
  `«${o.label.ru}» ${note ? `- доплата +${formatMinor(o.price_delta_minor)} (${note})` : `+${formatMinor(o.price_delta_minor)}`}${o.available ? '' : ' (стоп)'}`;

/**
 * Human-readable difference between two catalog payloads (e.g. published -> to be published).
 * Identical option changes in many products are listed once with all product ids. `notes`
 * (see barDrinkPriceNotes) say where the price of an added product or choice was taken from.
 */
export function describeCatalogDiff(
  beforeInput: unknown,
  afterInput: unknown,
  notes: ReadonlyMap<string, string> = new Map(),
): string[] {
  const before = CatalogPayloadSchema.parse(beforeInput),
    after = CatalogPayloadSchema.parse(afterInput);
  const lines: string[] = [];
  const names = new Map([...before.categories, ...after.categories].map((c) => [c.id, c.name.ru]));
  for (const key of ['content_source', 'content_reviewed', 'estimated_minutes'] as const)
    if (canonicalJson(before[key]) !== canonicalJson(after[key]))
      lines.push(`~ ${key}: ${canonicalJson(before[key])} -> ${canonicalJson(after[key])}`);
  if (canonicalJson(before.categories) !== canonicalJson(after.categories))
    lines.push(
      `~ categories: ${before.categories.map((c) => c.name.ru).join(', ')} -> ${after.categories.map((c) => c.name.ru).join(', ')}`,
    );
  if (canonicalJson(before.upsell_product_ids) !== canonicalJson(after.upsell_product_ids))
    lines.push(
      `~ upsell: ${before.upsell_product_ids.join(', ')} -> ${after.upsell_product_ids.join(', ')}`,
    );
  const old = new Map(before.products.map((p) => [p.id, p]));
  const next = new Map(after.products.map((p) => [p.id, p]));
  const grouped = new Map<string, string[]>();
  const group = (line: string, productId: string) =>
    grouped.set(line, [...(grouped.get(line) ?? []), productId]);
  for (const p of after.products) {
    const was = old.get(p.id);
    if (!was) {
      lines.push(`+ ${p.id} ${describeProduct(p, names, notes.get(p.id))}`);
      continue;
    }
    const fields: string[] = [];
    for (const key of Object.keys({ ...was, ...p }) as (keyof CatalogProduct)[]) {
      if (key === 'modifier_groups' || canonicalJson(was[key]) === canonicalJson(p[key])) continue;
      if (key === 'price_minor')
        fields.push(`цена ${formatMinor(was.price_minor)} -> ${formatMinor(p.price_minor)}`);
      else if (key === 'available') fields.push(p.available ? 'в продаже' : 'скрыта');
      else fields.push(key);
    }
    if (fields.length) lines.push(`~ ${p.id} «${p.name.ru}»: ${fields.join(', ')}`);
    const oldGroups = new Map(was.modifier_groups.map((g) => [g.id, g]));
    for (const g of p.modifier_groups) {
      const og = oldGroups.get(g.id);
      oldGroups.delete(g.id);
      if (!og) {
        group(`+ группа ${g.id} «${g.title.ru}»`, p.id);
        continue;
      }
      if (og.min !== g.min || og.max !== g.max || og.title.ru !== g.title.ru)
        group(`~ группа ${g.id}: ${og.min}-${og.max} -> ${g.min}-${g.max}`, p.id);
      const oldOptions = new Map(og.options.map((o) => [o.id, o]));
      g.options.forEach((o, index) => {
        const oo = oldOptions.get(o.id);
        oldOptions.delete(o.id);
        if (!oo)
          group(
            `+ ${g.id}: ${o.id} ${describeOption(o, notes.get(`${p.id}/${g.id}/${o.id}`))}`,
            p.id,
          );
        else if (canonicalJson(oo) !== canonicalJson(o))
          group(`~ ${g.id}: ${o.id} ${describeOption(oo)} -> ${describeOption(o)}`, p.id);
        else if (og.options[index]?.id !== o.id) group(`~ ${g.id}: порядок выбора`, p.id);
      });
      for (const o of oldOptions.values()) group(`- ${g.id}: ${o.id} ${describeOption(o)}`, p.id);
    }
    for (const g of oldGroups.values()) group(`- группа ${g.id} «${g.title.ru}»`, p.id);
  }
  for (const p of before.products)
    if (!next.has(p.id)) lines.push(`- ${p.id} ${describeProduct(p, names)}`);
  const order = (a: CatalogPayload) =>
    a.products.map((p) => p.id).filter((id) => old.has(id) && next.has(id));
  if (order(before).join() !== order(after).join()) lines.push('~ порядок существующих позиций');
  for (const [line, products] of grouped) lines.push(`${line} [${products.join(', ')}]`);
  return lines;
}
