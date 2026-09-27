import type { ModifierGroup, Selection } from './model';

export const hasPhotoPilot = (id: string) =>
  id === 'finger-duo' || id === 'burger-duo' || id === 'burger';

/** Expand the saved quantities into individual replaceable combo slots. */
export function comboSlots(group: ModifierGroup, selections: Selection[]): (string | null)[] {
  const selected = selections
    .filter((s) => s.group_id === group.id)
    .flatMap((s) => Array.from({ length: s.quantity }, () => s.option_id));
  return Array.from({ length: group.min }, (_, index) => selected[index] ?? null);
}

/** Replace one included item without losing the other drink/sauce or paid extras. */
export function replaceComboSlot(
  selections: Selection[],
  group: ModifierGroup,
  index: number,
  optionId: string,
): Selection[] {
  const option = group.options.find((o) => o.id === optionId);
  if (!option || option.available === false || index < 0 || index >= group.min) return selections;
  const slots = comboSlots(group, selections);
  slots[index] = optionId;
  if (slots.filter((id) => id === optionId).length > (option.max_quantity ?? group.max))
    return selections;
  const counts = new Map<string, number>();
  for (const id of slots) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [
    ...selections.filter((s) => s.group_id !== group.id),
    ...Array.from(counts, ([option_id, quantity]) => ({ group_id: group.id, option_id, quantity })),
  ];
}

/** Update a paid extra without altering included choices or exceeding catalog limits. */
export function setExtraQuantity(
  selections: Selection[],
  group: ModifierGroup,
  optionId: string,
  quantity: number,
): Selection[] {
  const option = group.options.find((o) => o.id === optionId);
  if (!option || !Number.isInteger(quantity) || quantity < 0) return selections;
  const previous =
    selections.find((s) => s.group_id === group.id && s.option_id === optionId)?.quantity ?? 0;
  const others = selections
    .filter((s) => s.group_id === group.id && s.option_id !== optionId)
    .reduce((n, s) => n + s.quantity, 0);
  if (
    quantity > previous &&
    (option.available === false ||
      quantity > (option.max_quantity ?? group.max) ||
      others + quantity > group.max)
  )
    return selections;
  if (others + quantity < group.min) return selections;
  return [
    ...selections.filter((s) => !(s.group_id === group.id && s.option_id === optionId)),
    ...(quantity ? [{ group_id: group.id, option_id: optionId, quantity }] : []),
  ];
}
