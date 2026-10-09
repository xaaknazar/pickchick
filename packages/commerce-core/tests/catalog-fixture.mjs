import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { catalogPayloadHash, priceCatalogSnapshot } from '@pickchick/catalog-pricing';
import { randomUUID } from 'node:crypto';
const text = (ru) => ({ ru, kk: '' });
export function catalogPayload(price = '10000') {
  const product = (id, amount) => ({
    id,
    sku: id.toUpperCase(),
    name: text('Synthetic ' + id),
    description: text('Synthetic description ' + id),
    category_id: 'food',
    price_minor: amount,
    image_asset_key: 'i0.jpg',
    available: true,
    prep_required: true,
    prep_minutes: 5,
    serving_label: text('100 г'),
    weight_g: 100,
    volume_ml: null,
    ingredients: text('Synthetic ingredients ' + id),
    allergens: ['synthetic-allergen'],
    allergens_status: 'declared',
    nutrition: { basis: 'per_serving', energy_kcal: 100, protein_g: 10, fat_g: 4, carbs_g: 6 },
    nutrition_status: 'operator_entered',
    kind: 'item',
    combo_components: [],
    modifier_groups: [],
  });
  const burger = product('burger', price),
    sauce = product('sauce', '500');
  burger.modifier_groups = [
    {
      id: 'extra',
      title: text('Synthetic extra'),
      min: 0,
      max: 2,
      options: [
        {
          id: 'sauce',
          label: text('Synthetic sauce'),
          price_delta_minor: '1000',
          default_quantity: 0,
          max_quantity: 2,
          available: true,
          nutrition_multiplier: 1,
          linked_product_id: 'sauce',
        },
      ],
    },
  ];
  return CatalogPayloadSchema.parse({
    schema_version: 1,
    currency: 'KZT',
    content_source: 'operator',
    content_reviewed: true,
    categories: [{ id: 'food', name: text('Synthetic food') }],
    products: [burger, sauce],
    estimated_minutes: { min: 5, max: 10 },
    upsell_product_ids: ['sauce'],
  });
}
export function pricePublication(reference, payload, legalEntityId) {
  const quote = priceCatalogSnapshot(
    { reference, orderingEnabled: true, payload },
    {
      organizationId: reference.organizationId,
      branchId: reference.branchId,
      customerId: null,
      channel: 'mobile',
    },
    {
      catalog_version: reference.version,
      service_mode: 'takeaway',
      items: [
        {
          sku: 'BURGER',
          quantity: 2,
          selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
        },
        { sku: 'BURGER', quantity: 1, selections: [] },
      ],
    },
  );
  return {
    ...quote,
    taxBinding: { legalEntityId, approvalReference: 'Synthetic approval only', version: 1 },
    lines: quote.lines.map((line) => ({ ...line, taxCode: 'SYNTHETIC-TAX' })),
  };
}
export async function publishCatalog(
  f,
  { version = 1, price = '10000', db = f.pool, payload = catalogPayload(price) } = {},
) {
  const organizationId = f.scope.organizationId,
    branchId = f.scope.branchId,
    payloadHash = catalogPayloadHash(payload);
  const actor =
    (
      await db.query('SELECT id FROM catalog_managers WHERE organization_id=$1 LIMIT 1', [
        organizationId,
      ])
    ).rows[0]?.id ?? randomUUID();
  await db.query(
    "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Synthetic commerce fixture',$3) ON CONFLICT(id) DO NOTHING",
    [actor, organizationId, actor.replaceAll('-', '').padEnd(64, '0')],
  );
  await db.query(
    'INSERT INTO catalog_draft_versions(branch_id,organization_id,revision,payload,payload_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
    [branchId, organizationId, version, payload, payloadHash, actor],
  );
  const pub = (
    await db.query(
      'INSERT INTO catalog_publications(branch_id,organization_id,version,source_revision,payload,payload_hash,actor_id) VALUES($1,$2,$3,$3,$4,$5,$6) RETURNING published_at',
      [branchId, organizationId, version, payload, payloadHash, actor],
    )
  ).rows[0];
  await db.query(
    'INSERT INTO catalog_branch_heads(branch_id,organization_id,draft_revision,published_version) VALUES($1,$2,$3,$3) ON CONFLICT(branch_id) DO UPDATE SET draft_revision=excluded.draft_revision,published_version=excluded.published_version',
    [branchId, organizationId, version],
  );
  await db.query('UPDATE branches SET ordering_enabled=true WHERE id=$1', [branchId]);
  const legal = (await db.query('SELECT legal_entity_id FROM branches WHERE id=$1', [branchId]))
    .rows[0].legal_entity_id;
  const reference = {
    organizationId,
    branchId,
    version,
    payloadHash,
    publishedAt: pub.published_at.toISOString(),
  };
  return { reference, payload, priced: pricePublication(reference, payload, legal) };
}
