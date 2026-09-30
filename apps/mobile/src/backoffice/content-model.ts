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
};
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
  return p as PublishedContent;
}
