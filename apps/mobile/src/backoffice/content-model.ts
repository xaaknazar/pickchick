export type PublishedContent = {
  schema_version: 1;
  branch_id: string;
  promos: {
    id: string;
    title: { ru: string; kk: string };
    body: { ru: string; kk: string };
    image_asset_key: string;
  }[];
  games: {
    template: 'pick-run' | 'pick-man' | 'pick-blocks';
    enabled: boolean;
    revision: number;
  }[];
  /**
   * Owner 15.11.2026: every game, its name and cover from the back office. Optional (older
   * servers) and read leniently: a bad entry is dropped, it never hides promos or other games.
   */
  game_cards?: GameCard[];
};
export type GameTemplate = 'pick-run' | 'pick-man' | 'pick-blocks' | 'magic-sort' | 'pick-farm';
export type GameCard = {
  template: GameTemplate;
  enabled: boolean;
  title: { ru: string; kk: string } | null;
  /** Same-origin media paths (/v1/media/catalog/<sha256>.<variant>.webp). */
  cover: { card: string; hero: string } | null;
};
const GAME_TEMPLATES: readonly string[] = [
  'pick-run',
  'pick-man',
  'pick-blocks',
  'magic-sort',
  'pick-farm',
];
const MEDIA = /^\/v1\/media\/catalog\/[a-f0-9]{64}\.(card|hero)\.webp$/;
const line = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
function gameCards(value: unknown): GameCard[] {
  if (!Array.isArray(value)) return [];
  const cards: GameCard[] = [];
  for (const v of value.slice(0, 10)) {
    if (!v || typeof v !== 'object') continue;
    const g = v as Record<string, unknown>;
    if (typeof g['template'] !== 'string' || !GAME_TEMPLATES.includes(g['template'])) continue;
    if (typeof g['enabled'] !== 'boolean') continue;
    if (cards.some((c) => c.template === g['template'])) continue;
    const title = g['title'] as Record<string, unknown> | null | undefined;
    const cover = g['cover'] as Record<string, unknown> | null | undefined;
    cards.push({
      template: g['template'] as GameTemplate,
      enabled: g['enabled'],
      title:
        title && line(title['ru'])
          ? {
              ru: String(title['ru']).trim(),
              kk: line(title['kk']) ? String(title['kk']).trim() : String(title['ru']).trim(),
            }
          : null,
      cover:
        cover &&
        typeof cover['card'] === 'string' &&
        typeof cover['hero'] === 'string' &&
        MEDIA.test(cover['card']) &&
        MEDIA.test(cover['hero'])
          ? { card: cover['card'], hero: cover['hero'] }
          : null,
    });
  }
  return cards;
}
export function parseContent(value: unknown, branch: string): PublishedContent {
  if (!value || typeof value !== 'object') throw new Error('Invalid content');
  const p = value as Record<string, unknown>;
  if (
    p['schema_version'] !== 1 ||
    p['branch_id'] !== branch ||
    !Array.isArray(p['promos']) ||
    p['promos'].length > 20 ||
    !Array.isArray(p['games']) ||
    p['games'].length > 3
  )
    throw new Error('Invalid content');
  for (const game of p['games']) {
    if (
      !game ||
      typeof game !== 'object' ||
      !['pick-run', 'pick-man', 'pick-blocks'].includes(game.template) ||
      typeof game.enabled !== 'boolean' ||
      !Number.isSafeInteger(game.revision) ||
      game.revision < 1
    )
      throw new Error('Invalid game configuration');
  }
  if (new Set(p['games'].map((g) => g.template)).size !== p['games'].length)
    throw new Error('Duplicate game configuration');
  for (const promo of p['promos']) {
    if (
      !promo ||
      typeof promo !== 'object' ||
      typeof promo.id !== 'string' ||
      typeof promo.image_asset_key !== 'string' ||
      !/^(i[0-9]{1,2}|logo|shot|generic-drink)$/.test(promo.image_asset_key)
    )
      throw new Error('Invalid promotion');
    for (const k of ['title', 'body'])
      for (const locale of ['ru', 'kk'])
        if (typeof promo[k]?.[locale] !== 'string' || promo[k][locale].length > 2000)
          throw new Error('Invalid promotion text');
  }
  return { ...(p as PublishedContent), game_cards: gameCards(p['game_cards']) };
}
