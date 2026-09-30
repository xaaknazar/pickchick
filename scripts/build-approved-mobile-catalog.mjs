import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';

// Owner decision, 2026-09-30: use the prices/options visible in PickChick Dev.
// Only this reviewed source is approved, not arbitrary future changes to the fixture.
export const APPROVED_SOURCE_HASH =
  '14a46cc3b6565ede05155ca565ef940d5c75541670f3481399b96e1f1318c270';
export function approvedMobileCatalog(source = mockupCatalogDraft) {
  const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  if (hash !== APPROVED_SOURCE_HASH) throw new Error('Mobile menu changed; review the new prices');
  return CatalogPayloadSchema.parse({
    ...source,
    content_source: 'operator',
    content_reviewed: true,
    // Prices/options approved. Do not turn unknown allergens or unverified
    // nutritional declarations into verified ones as a side effect.
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error('Provide output path; this command does not publish a catalog');
  const payload = approvedMobileCatalog();
  const bytes = JSON.stringify(payload, null, 2) + '\n';
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      products: payload.products.length,
      modifierGroups: payload.products.reduce((n, p) => n + p.modifier_groups.length, 0),
      sourceHash: APPROVED_SOURCE_HASH,
      payloadHash: createHash('sha256').update(bytes).digest('hex'),
      published: false,
    }),
  );
}
