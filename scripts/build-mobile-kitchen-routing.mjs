import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { UuidSchema } from '@pickchick/contracts';
import { RoutingSchema, digest } from '@pickchick/edge-fulfillment';
import { approvedMobileCatalog, APPROVED_SOURCE_HASH } from './build-approved-mobile-catalog.mjs';
import { previewId } from './local-pos-draft.mjs';

// Prepare a new immutable routing version; never connect to a database here.
// Preserve the installed POS routes and reuse their explicit station decisions.
export function mobileKitchenRouting(branchId, current, expectedDigest) {
  UuidSchema.parse(branchId);
  const previous = RoutingSchema.parse(current);
  if (digest(previous) !== expectedDigest) throw new Error('Installed routing changed');
  const routes = new Map(previous.routes.map((route) => [route.productId, route]));
  if (routes.size !== previous.routes.length) throw new Error('Duplicate installed routes');
  const additions = approvedMobileCatalog().products.map((product) => {
    if (routes.has(product.id)) throw new Error('Mobile route already exists; inspect first');
    const local = routes.get(previewId(branchId, 'product', product.id));
    if (!local) throw new Error('Mobile product has no matching installed POS route');
    if (
      product.combo_components.length ||
      product.modifier_groups.some((group) =>
        group.options.some((option) => option.linked_product_id),
      )
    )
      throw new Error('Expanded components need a separately reviewed routing plan');
    return {
      productId: product.id,
      stationId: local.stationId,
      kind: local.kind,
      ...(product.kind !== 'item' ? { unexpandedCombo: 'whole_product' } : {}),
    };
  });
  return RoutingSchema.parse({
    ...previous,
    version: previous.version + 1,
    routes: [...previous.routes, ...additions],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length)
    throw new Error('Provide private input and new output paths');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const routing = mobileKitchenRouting(input.branchId, input.routing, input.expectedDigest);
  const result = {
    branchId: input.branchId,
    sourceCatalogHash: APPROVED_SOURCE_HASH,
    previousRoutingHash: input.expectedDigest,
    routing,
    routingHash: digest(routing),
  };
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      routes: routing.routes.length,
      version: routing.version,
      routingHash: result.routingHash,
      installed: false,
    }),
  );
}
