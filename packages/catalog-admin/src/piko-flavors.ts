import { CatalogPayloadSchema, type CatalogModifier } from './contracts.js';

// Owner supplied both 200 ml packs on 2026-10-08. Keep the existing Piko SKU
// and prices; flavor is an explicit order selection, never a client-only alias.
export const pikoFlavors = [
  { id: 'piko-apple', label: 'Piko Яблоко 0.2 л' },
  { id: 'piko-orange', label: 'Piko Апельсин 0.2 л' },
] as const;

export function withPikoFlavors(input: unknown) {
  const payload = CatalogPayloadSchema.parse(input);
  const piko = payload.products.find((product) => product.id === 'piko');
  if (!piko || piko.volume_ml !== 200) throw new Error('Expected the existing Piko 200 ml product');
  if (piko.modifier_groups.length === 0) {
    piko.modifier_groups.push({
      id: 'piko-flavor',
      title: { ru: 'Вкус Piko', kk: '' },
      min: 1,
      max: 1,
      options: pikoFlavors.map((flavor, index) => ({
        id: flavor.id,
        label: { ru: flavor.label, kk: '' },
        price_delta_minor: '0',
        default_quantity: index === 0 ? 1 : 0,
        max_quantity: 1,
        available: true,
        linked_product_id: null,
      })),
    });
  } else if (
    piko.modifier_groups.length !== 1 ||
    piko.modifier_groups[0]?.id !== 'piko-flavor' ||
    piko.modifier_groups[0].options.length !== 2 ||
    !pikoFlavors.every((flavor) =>
      piko.modifier_groups[0]!.options.some((option) => option.id === flavor.id),
    )
  ) {
    throw new Error('Piko already has different modifiers; review them before changing flavors');
  }
  for (const product of payload.products) {
    for (const group of product.modifier_groups) {
      if (group.id !== 'drink') continue;
      const legacy = group.options.find((option) => option.id === 'piko');
      if (!legacy) continue;
      if (group.options.some((option) => pikoFlavors.some((flavor) => flavor.id === option.id)))
        throw new Error('Mixed Piko options require review');
      group.options = group.options.flatMap((option): CatalogModifier['options'] =>
        option !== legacy
          ? [option]
          : pikoFlavors.map((flavor, index) => ({
              ...option,
              id: flavor.id,
              label: { ru: flavor.label, kk: '' },
              default_quantity: index === 0 ? option.default_quantity : 0,
            })),
      );
    }
  }
  return CatalogPayloadSchema.parse(payload);
}
