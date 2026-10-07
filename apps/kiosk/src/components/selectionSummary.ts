import type { KioskCartLine } from '../model';
export function selectionSummary(line: KioskCartLine): string {
  return line.selections
    .map((selection) => {
      const option = line.product.modifier_groups
        .find((g) => g.id === selection.group_id)
        ?.options.find((o) => o.id === selection.option_id);
      return option
        ? `${option.label}${selection.quantity > 1 ? ` × ${selection.quantity}` : ''}`
        : '';
    })
    .filter(Boolean)
    .join(' · ');
}
