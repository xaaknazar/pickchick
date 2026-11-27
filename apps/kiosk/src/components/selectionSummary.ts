import type { KioskCartLine } from '../model';
export function selectionSummary(line: KioskCartLine): string {
  return selectionLines(line).join(' · ');
}
/** The chosen options one per entry (payment page lists them under the line, one per row). */
export function selectionLines(line: KioskCartLine): string[] {
  return line.selections
    .map((selection) => {
      const option = line.product.modifier_groups
        .find((g) => g.id === selection.group_id)
        ?.options.find((o) => o.id === selection.option_id);
      return option
        ? `${option.label}${selection.quantity > 1 ? ` × ${selection.quantity}` : ''}`
        : '';
    })
    .filter(Boolean);
}
