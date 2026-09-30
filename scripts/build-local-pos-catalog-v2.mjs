import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const previousBytes = await readFile(new URL('infra/windows/local-pos-draft-catalog.json', root));
if (digest(previousBytes) !== 'cad27d8912e86789f99abdb646c412693f73fad29523cbf5c66a9317dc6a76a5')
  throw new Error('Original v1 source catalog changed');
const previous = JSON.parse(previousBytes);
const datasetBytes = await readFile(new URL(previous.source.dataset_path, root));
const designBytes = await readFile(new URL(previous.source.design_path, root));
if (
  digest(datasetBytes) !== previous.source.dataset_sha256 ||
  digest(designBytes) !== previous.source.design_sha256
)
  throw new Error('Owner source changed; explicit source review required');
// Evaluate only the already hash-pinned static object literal; no module imports,
// test branch provisioning or fixture identities are executed/adopted.
const source = datasetBytes.toString('utf8');
const prefix = 'export const testCompleteCatalog = TestCompleteCatalogSchema.parse(';
if (!source.includes(prefix) || !source.trimEnd().endsWith(');'))
  throw new Error('Unexpected source fixture format');
const literal = source.slice(source.indexOf(prefix) + prefix.length, source.lastIndexOf(');'));
const catalog = JSON.parse(
  JSON.stringify(
    runInNewContext(
      '(' + literal + ')',
      {},
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
    ),
  ),
);
if (catalog.products.length !== 24) throw new Error('Expected exactly 24 owner source products');
const photos = [];
const products = [];
for (const item of catalog.products) {
  const old = previous.products.find((row) => row.source_id === item.id);
  if (
    !old ||
    old.name_ru !== item.name ||
    old.category !== item.category ||
    old.price_minor !== item.price_minor ||
    old.image_asset_key !== item.image_id
  )
    throw new Error('Base product projection changed');
  let photo;
  if (/^(?:i\d+|shot)\.jpg$/.test(item.image_id)) {
    const asset = await readFile(new URL('design/prototype/assets/mockup/' + item.image_id, root));
    photo = {
      filename: item.image_id,
      url: '/assets/menu/' + item.image_id,
      sha256: digest(asset),
      bytes: asset.length,
    };
    photos.push({ source_id: item.id, ...photo });
  } else if (item.id !== 'piko' || item.image_id !== 'generic-drink')
    throw new Error('Unexpected missing original product photo');
  products.push({
    source_id: item.id,
    category: item.category,
    name_ru: item.name,
    price_minor: item.price_minor,
    image_asset_key: item.image_id,
    ...(photo ? { image_url: photo.url } : {}),
    modifier_groups: item.modifier_groups.map((group) => ({
      source_id: group.id,
      name_ru: group.title,
      min_selected: group.min,
      max_selected: group.max,
      options: group.options.map((option) => ({
        source_id: option.id,
        name_ru: option.label,
        price_minor: option.price_delta_minor,
        max_quantity: option.max_quantity,
        default_quantity: option.default_quantity,
        available: option.available,
      })),
    })),
  });
}
const result = {
  format: 'pickchick-local-pos-draft-catalog-v2',
  content_reviewed: false,
  source: previous.source,
  products,
};
const inventory = {
  format: 'pickchick-local-pos-photo-inventory-v2',
  source_directory: 'design/prototype/assets/mockup',
  photos,
  omitted: [
    {
      source_id: 'piko',
      source_asset_key: 'generic-drink',
      reason: 'Original product photo unavailable; no substitute image assigned',
    },
  ],
};
for (const [name, value] of [
  ['local-pos-draft-catalog-v2.json', result],
  ['local-pos-photo-inventory-v2.json', inventory],
]) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await writeFile(new URL('infra/windows/' + name, root), bytes);
  console.log(JSON.stringify({ file: name, sha256: digest(bytes), bytes: bytes.length }));
}
