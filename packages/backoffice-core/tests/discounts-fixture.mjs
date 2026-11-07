// Synthetic head catalog of the discount tests (lane bo-ui step 7, design-bo-ui.md 5.8):
// categories chicken and drinks, products wings, strips and cola. Shared by discounts.test.mjs and
// the cabinet browser test. Every name and amount is made up.
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { catalogPayloadHash } from '../../catalog-pricing/dist/index.js';

const text = (ru) => ({ ru, kk: '' });
const product = (id, name, category) => ({
  id,
  sku: id.toUpperCase(),
  name: text(name),
  description: text('Синтетическое описание'),
  category_id: category,
  price_minor: '116700',
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
});
export function discountCatalog() {
  return CatalogPayloadSchema.parse({
    schema_version: 1,
    currency: 'KZT',
    content_source: 'operator',
    content_reviewed: true,
    categories: [
      { id: 'chicken', name: text('Синтетическая курица') },
      { id: 'drinks', name: text('Синтетические напитки') },
    ],
    products: [
      product('wings', 'Синтетические крылья', 'chicken'),
      product('strips', 'Синтетические стрипсы', 'chicken'),
      product('cola', 'Синтетическая кола', 'drinks'),
    ],
    estimated_minutes: { min: 5, max: 10 },
    upsell_product_ids: [],
  });
}
/** A head catalog publication of the branch (draft, publication, head), without pricing. */
export async function publishDiscountCatalog(c, version = 1, payload = discountCatalog()) {
  const q = (sql, args) => c.cloud.pool.query(sql, args);
  const actor = (
    await q('SELECT id FROM catalog_managers WHERE organization_id=$1 ORDER BY id LIMIT 1', [c.org])
  ).rows[0].id;
  const hash = catalogPayloadHash(payload);
  await q(
    'INSERT INTO catalog_draft_versions(branch_id,organization_id,revision,payload,payload_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
    [c.branch, c.org, version, payload, hash, actor],
  );
  await q(
    'INSERT INTO catalog_publications(branch_id,organization_id,version,source_revision,payload,payload_hash,actor_id) VALUES($1,$2,$3,$3,$4,$5,$6)',
    [c.branch, c.org, version, payload, hash, actor],
  );
  await q(
    `INSERT INTO catalog_branch_heads(branch_id,organization_id,draft_revision,published_version) VALUES($1,$2,$3,$3)
     ON CONFLICT(branch_id) DO UPDATE SET draft_revision=excluded.draft_revision,published_version=excluded.published_version`,
    [c.branch, c.org, version],
  );
}
