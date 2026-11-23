/**
 * КБЖУ is shown only when it is really filled in (owner 23.11.2026): a missing block or one with
 * every value at 0 means «not specified yet» and the app shows nothing about it.
 */
export function hasNutrition(
  nutrition:
    { energy_kcal: number; protein_g: number; fat_g: number; carbs_g: number } | null | undefined,
): boolean {
  if (!nutrition) return false;
  return [nutrition.energy_kcal, nutrition.protein_g, nutrition.fat_g, nutrition.carbs_g].some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
}
