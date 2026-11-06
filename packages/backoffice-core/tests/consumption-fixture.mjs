// Synthetic menu, stock and sales of the automatic consumption tests (lane bo-ui step 5,
// design-bo-ui.md 5.3, 5.5). Shared by consumption.test.mjs and the cabinet browser test.
// Every name, number and amount is made up.
import { randomUUID } from 'node:crypto';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { localCatalogId, projectCatalogMenu, publishMenu } from '@pickchick/menu-sync';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { publishCatalog } from '../../commerce-core/tests/catalog-fixture.mjs';
import { designateBackoffice, grantBackoffice } from '../dist/index.js';

const text = (ru) => ({ ru, kk: '' });
const product = (id, name, extra = {}) => ({
  id,
  sku: id.toUpperCase(),
  name: text(name),
  description: text('Синтетическое описание'),
  category_id: 'food',
  price_minor: '100000',
  image_asset_key: 'i0.jpg',
  available: true,
  prep_required: true,
  prep_minutes: 5,
  serving_label: text('1 шт'),
  weight_g: 100,
  volume_ml: null,
  ingredients: text('Синтетический состав'),
  allergens: [],
  allergens_status: 'declared',
  nutrition: { basis: 'per_serving', energy_kcal: 100, protein_g: 10, fat_g: 4, carbs_g: 6 },
  nutrition_status: 'operator_entered',
  kind: 'item',
  combo_components: [],
  modifier_groups: [],
  ...extra,
});
const option = (id, label, extra = {}) => ({
  id,
  label: text(label),
  price_delta_minor: '0',
  default_quantity: 0,
  max_quantity: 2,
  available: true,
  linked_product_id: null,
  ...extra,
});
/**
 * burger (+ sauce linked to the sauce product, + cheese), sauce, fries, nuggets, cola;
 * combo = fries + 2 nuggets with a drink choice (the cola option is the cola product);
 * duo = fries + nuggets; family = 2 duo + cola (a set of combos).
 */
export function consumptionCatalog() {
  return CatalogPayloadSchema.parse({
    schema_version: 1,
    currency: 'KZT',
    content_source: 'operator',
    content_reviewed: true,
    categories: [{ id: 'food', name: text('Синтетическая еда') }],
    products: [
      product('burger', 'Синтетический бургер', {
        modifier_groups: [
          {
            id: 'extra',
            title: text('Добавки'),
            min: 0,
            max: 2,
            options: [
              option('sauce', 'Соус', { linked_product_id: 'sauce', price_delta_minor: '1000' }),
              option('cheese', 'Сыр', { price_delta_minor: '1500' }),
            ],
          },
        ],
      }),
      product('sauce', 'Синтетический соус'),
      product('fries', 'Синтетический фри'),
      product('nuggets', 'Синтетические наггетсы'),
      product('cola', 'Синтетическая кола'),
      product('combo', 'Синтетическое комбо', {
        kind: 'combo',
        combo_components: [
          { product_id: 'fries', quantity: 1 },
          { product_id: 'nuggets', quantity: 2 },
        ],
        modifier_groups: [
          {
            id: 'drink',
            title: text('Напиток'),
            min: 1,
            max: 1,
            options: [option('cola', 'Кола', { default_quantity: 1, max_quantity: 1 })],
          },
        ],
      }),
      product('duo', 'Синтетическое дуо', {
        kind: 'combo',
        combo_components: [
          { product_id: 'fries', quantity: 1 },
          { product_id: 'nuggets', quantity: 1 },
        ],
      }),
      product('family', 'Синтетический семейный набор', {
        kind: 'set',
        combo_components: [
          { product_id: 'duo', quantity: 2 },
          { product_id: 'cola', quantity: 1 },
        ],
      }),
    ],
    estimated_minutes: { min: 5, max: 10 },
    upsell_product_ids: [],
  });
}
export const request = (command, reason = 'Синтетическая проверка автосписания') => ({
  request_id: randomUUID(),
  reason,
  command,
});
async function person(c, name, grant) {
  const p = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name,
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, p.actor_id, c.branch, grant);
  return p;
}
export async function people(c) {
  const manager = await person(c, 'Синтетический управляющий', 'manager');
  const shift = await person(c, 'Синтетический начальник смены', 'analyst');
  const accountant = await person(c, 'Синтетический бухгалтер', 'analyst');
  const analyst = await person(c, 'Синтетический аналитик', 'analyst');
  await designateBackoffice(c.cloud.pool, shift.actor_id, c.branch, 'shift_manager', 'Т7: роль');
  await designateBackoffice(c.cloud.pool, accountant.actor_id, c.branch, 'accountant', 'Т7: роль');
  return { manager, shift, accountant, analyst };
}
/** Catalog version 1 of the branch, its POS menu release and the delivery that maps them. */
export async function publishMenuFixture(c) {
  const { payload, reference } = await publishCatalog(
    { pool: c.cloud.pool, scope: { organizationId: c.org, branchId: c.branch } },
    { payload: consumptionCatalog() },
  );
  const menu = projectCatalogMenu(payload, c.branch, 1, reference.publishedAt);
  await publishMenu(c.cloud.pool, menu);
  await c.cloud.pool.query(
    'INSERT INTO catalog_menu_deliveries(branch_id,catalog_version,release_id,device_id) VALUES($1,1,$2,$3)',
    [c.branch, menu.release_id, c.device],
  );
  return { payload, release: menu.release_id };
}
/** Stock items, the three production recipes and the opening receipts (synthetic values). */
export async function stockFixture(bo, token, c) {
  const save = async (kind, payload) => {
    const id = randomUUID();
    await bo.command(
      token,
      c.branch,
      request({ type: 'save', kind, id, expected_revision: 0, payload }),
    );
    return id;
  };
  const item = (name, unit) => save('ingredient', { name, unit, minimum: '0', active: true });
  const s = {
    bun: await item('Синтетическая булка', 'pcs'),
    meat: await item('Синтетическое мясо', 'g'),
    patty: await item('Синтетическая котлета (выход)', 'pcs'),
    cheese: await item('Синтетический сыр', 'pcs'),
    mayo: await item('Синтетический майонез', 'g'),
    sauce: await item('Синтетический соус (выход)', 'g'),
    potato: await item('Синтетический картофель', 'g'),
    chicken: await item('Синтетическое филе', 'g'),
    nugget: await item('Синтетический наггетс (выход)', 'pcs'),
    can: await item('Синтетическая банка колы', 'pcs'),
  };
  const recipe = (name, output, yieldQuantity, lines, extra = {}) =>
    save('recipe', {
      name,
      product_id: 'ttk:' + name,
      output_ingredient_id: output,
      yield_quantity: yieldQuantity,
      lines: lines.map(([ingredient_id, quantity]) => ({ ingredient_id, quantity })),
      ...extra,
    });
  // The chef chooses how each output is written off at the sale (review BOUI-R1: no default).
  s.recipes = {
    patty: await recipe('Котлета', s.patty, '1', [[s.meat, '120']], { stock_policy: 'explode' }),
    // The sauce is made in batches by production documents: written off as stock.
    sauce: await recipe('Соус', s.sauce, '1000', [[s.mayo, '1000']], { stock_policy: 'stock' }),
    nugget: await recipe('Наггетсы', s.nugget, '3', [[s.chicken, '100']], {
      stock_policy: 'explode',
    }),
  };
  await receipt(bo, token, c, [
    [s.bun, '100', '500000'],
    [s.meat, '10000', '2000000'],
    [s.cheese, '50', '250000'],
    [s.sauce, '5000', '500000'],
    [s.potato, '20000', '400000'],
    [s.chicken, '6000', '1200000'],
    [s.can, '48', '960000'],
  ]);
  return s;
}
export async function balances(c) {
  return Object.fromEntries(
    (
      await c.cloud.pool.query(
        'SELECT ingredient_id,quantity::text,value_minor::text,revision,counted_at FROM bo_stock_balances WHERE branch_id=$1',
        [c.branch],
      )
    ).rows.map((r) => [r.ingredient_id, r]),
  );
}
export async function stockDocument(bo, token, c, kind, lines, extra = {}) {
  const now = await balances(c);
  return bo.command(
    token,
    c.branch,
    request({
      type: 'stock',
      kind,
      reference: 'SYN-' + kind,
      lines: lines.map(([ingredient_id, quantity, value_minor = '0']) => ({
        ingredient_id,
        quantity,
        value_minor,
        expected_revision: now[ingredient_id].revision,
      })),
      ...extra,
    }),
  );
}
export const receipt = (bo, token, c, lines) =>
  stockDocument(bo, token, c, 'receipt', lines, {
    meta: { supplier_kind: 'supplier', document_date: '2026-11-18' },
  });
/** The approved links of the synthetic menu (combos and the cola option have none). */
export async function linkFixture(bo, token, c, s) {
  const links = [
    [
      { product_id: 'burger' },
      [
        { ingredient_id: s.bun, quantity: '1' },
        { recipe_output_id: s.patty, quantity: '1' },
      ],
    ],
    [
      { product_id: 'burger', group_id: 'extra', option_id: 'cheese' },
      [{ ingredient_id: s.cheese, quantity: '1' }],
    ],
    [{ product_id: 'sauce' }, [{ recipe_output_id: s.sauce, quantity: '30' }]],
    [{ product_id: 'fries' }, [{ ingredient_id: s.potato, quantity: '150' }]],
    [{ product_id: 'nuggets' }, [{ recipe_output_id: s.nugget, quantity: '1' }]],
    [{ product_id: 'cola' }, [{ ingredient_id: s.can, quantity: '1' }]],
  ];
  const keys = {};
  for (const [catalog_ref, lines] of links) {
    const saved = await bo.command(
      token,
      c.branch,
      request({
        type: 'menu_link_save',
        catalog_ref,
        effect: 'consume',
        lines,
        expected_revision: 0,
      }),
    );
    keys[saved.catalog_key] = saved.revision;
  }
  await bo.command(
    token,
    c.branch,
    request({ type: 'menu_links_approve', keys: Object.keys(keys), expected_revisions: keys }),
  );
  return Object.keys(keys);
}
const POS_TERMINAL = randomUUID();
/**
 * One POS sale exactly as the posSales receiver projects it (cloud073), lines in POS ids of the
 * catalog slugs: [[product, quantity, [[group, option, quantity?], ...]], ...].
 */
export async function posSale(c, release, { at, lines, number = 1, voided = null }) {
  const id = randomUUID();
  const quoteLines = lines.map(([p, quantity, modifiers = []]) => ({
    product_id: localCatalogId(c.branch, 'product', p),
    variant_id: localCatalogId(c.branch, 'base-preview', p),
    name: text(p),
    quantity,
    unit_price_minor: '100000',
    total_minor: String(100000 * quantity),
    ...(modifiers.length
      ? {
          modifiers: modifiers.map(([g, o, q]) => ({
            group_id: localCatalogId(c.branch, 'modifier-group', `${p}:${g}`),
            option_id: localCatalogId(c.branch, 'modifier-option', `${p}:${g}:${o}`),
            ...(q ? { quantity: q } : {}),
            group_name: text(g),
            name: text(o),
            price_minor: '0',
          })),
        }
      : {}),
  }));
  const total = String(100000 * lines.reduce((n, [, q]) => n + q, 0));
  await c.cloud.pool.query(
    `INSERT INTO cloud_pos_sales(order_id,branch_id,device_id,shift_id,terminal_id,cashier_staff_id,
      display_number,sold_at,business_date,sales_channel,service_mode,revenue_kind,
      subtotal_minor,discount_minor,total_minor,release_id,menu_version,lines,state,voided_at,last_sequence)
     VALUES($1,$2,$3,$4,$5,$6,$7::int,$8,($8::timestamptz AT TIME ZONE 'Asia/Almaty')::date,'hall','dine_in','revenue',
      $9,0,$9,$10,1,$11,$12,$13,$7::bigint)`,
    [
      id,
      c.branch,
      c.device,
      randomUUID(),
      POS_TERMINAL,
      randomUUID(),
      number,
      at,
      total,
      release,
      JSON.stringify(quoteLines),
      voided ? 'voided' : 'paid',
      voided,
    ],
  );
  return id;
}
/** The kitchen state of a POS order (cloud018 projection; triggers off on one owner connection). */
export async function kitchen(c, order, state) {
  const db = await c.cloud.pool.connect();
  try {
    await db.query('SET session_replication_role = replica');
    await db.query(
      `INSERT INTO pos_kitchen_sync_projection(order_id,branch_id,device_id,producer_id,reservation_id,quote_id,
        quote_digest,owner_hash,execution_mode,display_number,routing_version,assembly_station_id,version,state,
        created_at,updated_at,last_event_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,'pos_sale',1,1,$8,1,$9,clock_timestamp(),clock_timestamp(),$10)
       ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,version=pos_kitchen_sync_projection.version+1`,
      [
        order,
        c.branch,
        c.device,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        'a'.repeat(64),
        randomUUID(),
        state,
        randomUUID(),
      ],
    );
  } finally {
    await db.query('SET session_replication_role = DEFAULT');
    db.release();
  }
}
/** A paid cloud order of catalog version 1 with its kitchen state (triggers off, owner connection). */
export async function cloudOrder(c, { at, lines, state = 'in_production', display = 7 }) {
  const db = await c.cloud.pool.connect();
  const id = randomUUID();
  try {
    await db.query('SET session_replication_role = replica');
    const account = randomUUID();
    await db.query(
      `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,fiscal_account_id,
        snapshot,total_minor,currency,quote_digest,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,100000,'KZT',$8,$9)`,
      [
        id,
        c.org,
        c.branch,
        randomUUID(),
        randomUUID(),
        account,
        JSON.stringify({
          channel: 'mobile',
          catalogReference: { version: 1 },
          lines: lines.map(([productId, quantity, modifiers = []]) => ({
            productId,
            quantity,
            selectedDetails: {
              modifiers: modifiers.map(([groupId, optionId, q = 1]) => ({
                groupId,
                optionId,
                quantity: q,
              })),
            },
          })),
        }),
        'a'.repeat(64),
        at,
      ],
    );
    const capture = randomUUID();
    await db.query(
      `INSERT INTO commerce_captures(id,order_id,attempt_id,account_id,operation_id,amount_minor,occurred_at)
       VALUES($1,$2,$3,$4,$5,100000,$6)`,
      [capture, id, randomUUID(), account, 'synthetic:' + capture, at],
    );
    if (state)
      await db.query(
        `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,
          quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,$8,$9,1,'{}')`,
        [id, c.branch, c.org, c.device, randomUUID(), randomUUID(), 'a'.repeat(64), state, display],
      );
  } finally {
    await db.query('SET session_replication_role = DEFAULT');
    db.release();
  }
  return id;
}
export async function items(c) {
  return (
    await c.cloud.pool.query(
      'SELECT source,order_id,sold_at,state,reason,detail,document_id,trigger_kind,attempts,revision FROM bo_consumption_items WHERE branch_id=$1 ORDER BY sold_at,order_id',
      [c.branch],
    )
  ).rows;
}
export async function consumptionDocuments(c) {
  return (
    await c.cloud.pool.query(
      `SELECT d.id,d.source_ref,d.order_id,d.reference,d.created_at,d.actor_id,
         coalesce((SELECT jsonb_object_agg(m.ingredient_id,(-m.quantity_delta)::text) FROM bo_stock_movements m
           WHERE m.document_id=d.id),'{}'::jsonb) moves
       FROM bo_stock_documents d WHERE d.branch_id=$1 AND d.kind='consumption' ORDER BY d.created_at,d.id`,
      [c.branch],
    )
  ).rows;
}
