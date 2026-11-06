import { z } from 'zod';
import { localCatalogId } from '@pickchick/menu-sync';
import { Recipe, StopCatalogRef } from './model.js';

/**
 * Automatic consumption by sales (Ск2; lane bo-ui, design-bo-ui.md 3, 5.3, 5.5;
 * design-backoffice.md 4): pure part. Nothing here reads the database.
 *
 * A sold line is turned into stock needs by the menu-stock links of the branch (the chef's
 * table, approved through the manager):
 * - a product uses its own link; a combo or set without its own link takes its catalog
 *   combo_components (times their quantity), recursively up to 5 levels;
 * - a chosen option uses its own link; without one, the product it points to (linked_product_id,
 *   or the catalog product whose slug is the option slug, the menu-sync combo stop rule);
 * - a link line is a stock item (`ingredient_id`, consumed as is) or the output of a production
 *   recipe (`recipe_output_id`, a TTK output). An output is consumed by its recipe's stock_policy:
 *   `explode` (the default) writes off the recipe lines times quantity / yield, recursively up to
 *   6 levels, nested outputs by their own policy; `stock` writes off the output item itself.
 * Every quantity is an exact fraction (BigInt); one half-up rounding per ingredient per order.
 * A missing or unapproved link, an unknown catalog item or a broken recipe is a problem: the
 * order is blocked with its reasons and nothing of it is written off.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
/** `product` or `product:group:option`, as bo_menu_stock_links.catalog_key (cloud075). */
export const CatalogKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}(?::[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39})?$/);
export type CatalogRef = { product_id: string; group_id?: string; option_id?: string };
export const catalogKey = (ref: {
  product_id: string;
  group_id?: string | undefined;
  option_id?: string | undefined;
}) =>
  ref.group_id !== undefined && ref.option_id !== undefined
    ? `${ref.product_id}:${ref.group_id}:${ref.option_id}`
    : ref.product_id;

const revision = z.number().int().min(0).max(2147483646);
/** Quantity of one link line in the base unit of the stock item (g, ml, pcs) per sold unit. */
export const LinkQuantitySchema = z.string().regex(/^[1-9][0-9]{0,8}$/);
export const MenuLinkLineSchema = z.union([
  z.strictObject({ ingredient_id: z.uuid(), quantity: LinkQuantitySchema }),
  z.strictObject({ recipe_output_id: z.uuid(), quantity: LinkQuantitySchema }),
]);
export type MenuLinkLine = z.infer<typeof MenuLinkLineSchema>;
export const lineTarget = (line: MenuLinkLine) =>
  'ingredient_id' in line ? line.ingredient_id : line.recipe_output_id;
const linkLines = z
  .array(MenuLinkLineSchema)
  .max(50)
  .refine((lines) => new Set(lines.map(lineTarget)).size === lines.length);
/** One link of a catalog product or option (design-bo-ui 5.3). effect none = no lines. */
export const MenuLinkSaveCommand = z
  .strictObject({
    type: z.literal('menu_link_save'),
    catalog_ref: StopCatalogRef,
    effect: z.enum(['consume', 'none']),
    lines: linkLines,
    expected_revision: revision,
  })
  .refine((c) => (c.effect === 'none') === (c.lines.length === 0));
/** The chef's approval through the manager: every key at the revision the table showed. */
export const MenuLinksApproveCommand = z
  .strictObject({
    type: z.literal('menu_links_approve'),
    keys: z.array(CatalogKeySchema).min(1).max(200),
    expected_revisions: z.record(CatalogKeySchema, revision),
  })
  .refine(
    (c) =>
      new Set(c.keys).size === c.keys.length &&
      c.keys.every((key) => c.expected_revisions[key] !== undefined),
  );
/** Branch mode of the automatic consumption; dry_run and on need start_at (cloud075 CHECK). */
export const AUTOCONSUME_MODES = ['off', 'dry_run', 'on'] as const;
export type AutoconsumeMode = (typeof AUTOCONSUME_MODES)[number];
export const StockSettingsCommand = z
  .strictObject({
    type: z.literal('stock_settings'),
    autoconsume_mode: z.enum(AUTOCONSUME_MODES),
    start_at: z.iso
      .datetime()
      .refine((v) => v >= '2020-01-01' && v < '2100-01-01')
      .nullable(),
    expected_revision: revision,
  })
  .refine((c) => c.autoconsume_mode === 'off' || c.start_at !== null);
const itemRef = {
  source: z.enum(['pos', 'cloud']),
  order_id: z.uuid(),
  expected_revision: z.number().int().min(1).max(2147483646),
};
export const ConsumptionRetryCommand = z.strictObject({
  type: z.literal('consumption_retry'),
  ...itemRef,
});
/** The reason of the skip is the reason of the request (3..500 characters). */
export const ConsumptionSkipCommand = z.strictObject({
  type: z.literal('consumption_skip'),
  ...itemRef,
});

/** Production recipe as stored (cloud017 payload) plus its optional P1 stock_policy. */
export const RECIPE_STOCK_POLICIES = ['explode', 'stock'] as const;
export const RecipeP1 = Recipe.safeExtend({
  stock_policy: z.enum(RECIPE_STOCK_POLICIES).optional(),
});
export type RecipeRecord = { id: string; revision: number; payload: unknown };

// ------------------------------------------------------------------------- catalog ----

const title = z.object({ ru: z.string() });
const CatalogShape = z.object({
  products: z.array(
    z.object({
      id: slug,
      name: title,
      available: z.boolean(),
      kind: z.enum(['item', 'combo', 'set']).default('item'),
      combo_components: z
        .array(z.object({ product_id: slug, quantity: z.number().int().min(1) }))
        .default([]),
      modifier_groups: z
        .array(
          z.object({
            id: slug,
            title,
            options: z.array(
              z.object({
                id: slug,
                label: title,
                linked_product_id: slug.nullable().default(null),
              }),
            ),
          }),
        )
        .default([]),
    }),
  ),
});
type CatalogProduct = z.infer<typeof CatalogShape>['products'][number];
export type CatalogIndex = {
  version: number;
  products: Map<string, CatalogProduct>;
  /** POS QuoteLine.variant_id (localCatalogId base-preview) -> product slug. */
  variants: Map<string, string>;
  /** POS QuoteModifier.option_id (localCatalogId modifier-option) -> option ref. */
  options: Map<string, { product: string; group: string; option: string }>;
};
/** The published catalog of one version with the POS ids the cashier menu uses (menu-sync). */
export function catalogIndex(branch: string, version: number, payload: unknown): CatalogIndex {
  const catalog = CatalogShape.parse(payload);
  const index: CatalogIndex = {
    version,
    products: new Map(),
    variants: new Map(),
    options: new Map(),
  };
  for (const product of catalog.products) {
    index.products.set(product.id, product);
    index.variants.set(localCatalogId(branch, 'base-preview', product.id), product.id);
    for (const group of product.modifier_groups)
      for (const option of group.options)
        index.options.set(
          localCatalogId(branch, 'modifier-option', `${product.id}:${group.id}:${option.id}`),
          { product: product.id, group: group.id, option: option.id },
        );
  }
  return index;
}
const optionOf = (index: CatalogIndex, product: string, group: string, option: string) => {
  const p = index.products.get(product);
  const g = p?.modifier_groups.find((v) => v.id === group);
  const o = g?.options.find((v) => v.id === option);
  return p && g && o ? { product: p, group: g, option: o } : null;
};
/** The product an option stands for (menu-sync combo stop rule), or null. */
export function optionProduct(
  index: CatalogIndex,
  option: { id: string; linked_product_id: string | null },
): string | null {
  return option.linked_product_id ?? (index.products.has(option.id) ? option.id : null);
}

// ----------------------------------------------------------------------- resolution ----

export type MenuLink = {
  catalog_key: string;
  effect: 'consume' | 'none';
  lines: MenuLinkLine[];
  status: 'draft' | 'approved';
  revision: number;
};
/** A sold line in catalog slugs (POS hashes already resolved). */
export type OrderLine = {
  product_id: string;
  quantity: number;
  selections: { group_id: string; option_id: string; quantity: number }[];
};
export const PROBLEM_CODES = [
  'NO_LINK',
  'LINK_NOT_APPROVED',
  'ITEM_UNKNOWN',
  'COMBO_TOO_DEEP',
  'INGREDIENT_UNKNOWN',
  'RECIPE_NOT_FOUND',
  'RECIPE_AMBIGUOUS',
  'RECIPE_CYCLE',
  'RECIPE_TOO_DEEP',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
export type Problem = {
  code: ProblemCode;
  catalog_key: string | null;
  name: string | null;
  ingredient_id: string | null;
};
export type Fraction = { n: bigint; d: bigint };
export type Resolution = {
  needs: Map<string, Fraction>;
  problems: Problem[];
  /** Revisions of the links and recipes the resolution used (the document snapshot). */
  links: Record<string, number>;
  recipes: Record<string, number>;
};
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const fraction = (n: bigint, d = 1n): Fraction => {
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
};
const add = (a: Fraction, b: Fraction) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const times = (a: Fraction, n: bigint, d = 1n) => fraction(a.n * n, a.d * d);
/** The one rounding of a need: half-up to a whole base unit. */
export const roundHalfUp = (f: Fraction) => (2n * f.n + f.d) / (2n * f.d);
export const MAX_COMBO_DEPTH = 5;
export const MAX_RECIPE_DEPTH = 6;

type Recipes = Map<string, { id: string; revision: number; recipe: z.infer<typeof RecipeP1> }[]>;
/** Production recipes by their output stock item (menu recipes have no output and are not used). */
export function recipesByOutput(records: readonly RecipeRecord[]): Recipes {
  const out: Recipes = new Map();
  for (const record of records) {
    const parsed = RecipeP1.safeParse(record.payload);
    if (!parsed.success || parsed.data.output_ingredient_id === null) continue;
    const list = out.get(parsed.data.output_ingredient_id) ?? [];
    list.push({ id: record.id, revision: record.revision, recipe: parsed.data });
    out.set(parsed.data.output_ingredient_id, list);
  }
  return out;
}

export type ResolveContext = {
  catalog: CatalogIndex;
  links: ReadonlyMap<string, MenuLink>;
  recipes: Recipes;
  /** Stock items of the branch (bo_records kind ingredient). */
  ingredients: ReadonlySet<string>;
};
/** Stock needs of the sold lines (exact fractions per ingredient) or the problems that block. */
export function resolveOrder(context: ResolveContext, lines: readonly OrderLine[]): Resolution {
  const result: Resolution = { needs: new Map(), problems: [], links: {}, recipes: {} };
  const problem = (
    code: ProblemCode,
    key: string | null,
    name: string | null,
    ingredient: string | null = null,
  ) => {
    if (
      !result.problems.some(
        (p) => p.code === code && p.catalog_key === key && p.ingredient_id === ingredient,
      )
    )
      result.problems.push({ code, catalog_key: key, name, ingredient_id: ingredient });
  };
  const need = (ingredient: string, amount: Fraction) => {
    if (!context.ingredients.has(ingredient))
      return problem('INGREDIENT_UNKNOWN', null, null, ingredient);
    const current = result.needs.get(ingredient);
    result.needs.set(ingredient, current ? add(current, amount) : amount);
  };
  const output = (ingredient: string, amount: Fraction, depth: number, stack: string[]) => {
    const recipes = context.recipes.get(ingredient) ?? [];
    if (recipes.length === 0) return problem('RECIPE_NOT_FOUND', null, null, ingredient);
    if (recipes.length > 1) return problem('RECIPE_AMBIGUOUS', null, null, ingredient);
    const { id, revision, recipe } = recipes[0]!;
    if (stack.includes(id)) return problem('RECIPE_CYCLE', null, recipe.name, ingredient);
    if (depth >= MAX_RECIPE_DEPTH) return problem('RECIPE_TOO_DEEP', null, recipe.name, ingredient);
    result.recipes[id] = revision;
    if (recipe.stock_policy === 'stock') return need(ingredient, amount);
    for (const line of recipe.lines) {
      const part = times(amount, BigInt(line.quantity), BigInt(recipe.yield_quantity));
      const nested = context.recipes.get(line.ingredient_id);
      if (nested?.length) output(line.ingredient_id, part, depth + 1, [...stack, id]);
      else need(line.ingredient_id, part);
    }
  };
  const link = (key: string, name: string, quantity: bigint) => {
    const found = context.links.get(key)!;
    result.links[key] = found.revision;
    if (found.status !== 'approved') return problem('LINK_NOT_APPROVED', key, name);
    for (const line of found.lines) {
      const amount = fraction(BigInt(line.quantity) * quantity);
      if ('ingredient_id' in line) need(line.ingredient_id, amount);
      else output(line.recipe_output_id, amount, 0, []);
    }
  };
  const product = (id: string, quantity: bigint, depth: number) => {
    const p = context.catalog.products.get(id);
    if (!p) return problem('ITEM_UNKNOWN', id, null);
    if (depth > MAX_COMBO_DEPTH) return problem('COMBO_TOO_DEEP', id, p.name.ru);
    if (context.links.has(id)) return link(id, p.name.ru, quantity);
    if (p.kind !== 'item' && p.combo_components.length)
      for (const component of p.combo_components)
        product(component.product_id, quantity * BigInt(component.quantity), depth + 1);
    else problem('NO_LINK', id, p.name.ru);
  };
  for (const line of lines) {
    const quantity = BigInt(line.quantity);
    product(line.product_id, quantity, 0);
    for (const s of line.selections) {
      const key = catalogKey({
        product_id: line.product_id,
        group_id: s.group_id,
        option_id: s.option_id,
      });
      const found = optionOf(context.catalog, line.product_id, s.group_id, s.option_id);
      if (!found) {
        problem('ITEM_UNKNOWN', key, null);
        continue;
      }
      const name = `${found.product.name.ru} · ${found.option.label.ru}`;
      const amount = quantity * BigInt(s.quantity);
      if (context.links.has(key)) link(key, name, amount);
      else {
        const linked = optionProduct(context.catalog, found.option);
        if (linked) product(linked, amount, 1);
        else problem('NO_LINK', key, name);
      }
    }
  }
  return result;
}

// ------------------------------------------------------------------------ order lines ----

const PosLines = z.array(
  z.object({
    variant_id: z.string(),
    quantity: z.number().int().min(1),
    modifiers: z
      .array(z.object({ option_id: z.string(), quantity: z.number().int().min(1).optional() }))
      .optional(),
  }),
);
/** Lines of a POS sale (cloud073 QuoteLine[] of POS ids) in catalog slugs of `catalog`. */
export function posOrderLines(
  catalog: CatalogIndex,
  input: unknown,
): { lines: OrderLine[]; unknown: number } {
  const parsed = PosLines.safeParse(input);
  if (!parsed.success) return { lines: [], unknown: 1 };
  let unknown = 0;
  const lines: OrderLine[] = [];
  for (const line of parsed.data) {
    const product = catalog.variants.get(line.variant_id);
    if (!product) {
      unknown++;
      continue;
    }
    const selections: OrderLine['selections'] = [];
    for (const m of line.modifiers ?? []) {
      const ref = catalog.options.get(m.option_id);
      if (!ref || ref.product !== product) {
        unknown++;
        continue;
      }
      selections.push({ group_id: ref.group, option_id: ref.option, quantity: m.quantity ?? 1 });
    }
    lines.push({ product_id: product, quantity: line.quantity, selections });
  }
  return { lines, unknown };
}
const CloudSnapshot = z.object({
  catalogReference: z.object({ version: z.number().int().positive() }).optional(),
  lines: z.array(
    z.object({
      productId: z.string(),
      quantity: z.number().int().min(1),
      selectedDetails: z
        .object({
          modifiers: z
            .array(
              z.object({
                groupId: z.string(),
                optionId: z.string(),
                quantity: z.number().int().min(1).optional(),
              }),
            )
            .default([]),
        })
        .optional(),
    }),
  ),
});
/** Catalog version and lines of a cloud (app, kiosk) order snapshot; null when unreadable. */
export function cloudOrderLines(snapshot: unknown): { version: number | null; lines: OrderLine[] } {
  const parsed = CloudSnapshot.safeParse(snapshot);
  if (!parsed.success) return { version: null, lines: [] };
  return {
    version: parsed.data.catalogReference?.version ?? null,
    lines: parsed.data.lines.map((line) => ({
      product_id: line.productId,
      quantity: line.quantity,
      selections: (line.selectedDetails?.modifiers ?? []).map((m) => ({
        group_id: m.groupId,
        option_id: m.optionId,
        quantity: m.quantity ?? 1,
      })),
    })),
  };
}

// ------------------------------------------------------------------- menu link table ----

export type MenuLinkItem = {
  catalog_key: string;
  catalog_ref: CatalogRef;
  kind: 'product' | 'option' | 'combo' | 'set';
  name_ru: string;
  product_name_ru: string;
  group_name_ru: string | null;
  /** The product an option stands for (it uses that product's link when it has none). */
  linked_product_id: string | null;
  /** In the published menu (catalog available=true). */
  listed: boolean;
  /** A combo or set without its own link: written off by its components. */
  from_combo: boolean;
  /** Written off without a link of its own (combo components or the linked product). */
  covered_without_link: boolean;
};
/** Every product and option of the catalog in catalog order (design-bo-ui 5.3). */
export function menuLinkItems(
  catalog: CatalogIndex,
  links: ReadonlyMap<string, unknown>,
): MenuLinkItem[] {
  const items: MenuLinkItem[] = [];
  for (const p of catalog.products.values()) {
    const combo = p.kind !== 'item' && p.combo_components.length > 0;
    items.push({
      catalog_key: p.id,
      catalog_ref: { product_id: p.id },
      kind: p.kind === 'item' ? 'product' : p.kind,
      name_ru: p.name.ru,
      product_name_ru: p.name.ru,
      group_name_ru: null,
      linked_product_id: null,
      listed: p.available,
      from_combo: combo && !links.has(p.id),
      covered_without_link: combo && !links.has(p.id),
    });
    for (const g of p.modifier_groups)
      for (const o of g.options) {
        const key = catalogKey({ product_id: p.id, group_id: g.id, option_id: o.id });
        const linked = optionProduct(catalog, o);
        items.push({
          catalog_key: key,
          catalog_ref: { product_id: p.id, group_id: g.id, option_id: o.id },
          kind: 'option',
          name_ru: o.label.ru,
          product_name_ru: p.name.ru,
          group_name_ru: g.title.ru,
          linked_product_id: linked,
          listed: p.available,
          from_combo: false,
          covered_without_link: linked !== null && !links.has(key),
        });
      }
  }
  return items;
}
/** Whether the catalog has this product or option (menu_link_save). */
export function catalogHas(catalog: CatalogIndex, ref: CatalogRef) {
  return ref.group_id !== undefined && ref.option_id !== undefined
    ? optionOf(catalog, ref.product_id, ref.group_id, ref.option_id) !== null
    : catalog.products.has(ref.product_id);
}
