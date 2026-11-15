import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContent } from '../../apps/mobile/src/backoffice/content-model.ts';
const branch = '11111111-1111-4111-8111-111111111111';
const content = {
  schema_version: 1,
  branch_id: branch,
  promos: [],
  games: [{ template: 'pick-man', enabled: false, revision: 1 }],
};
test('mobile accepts only matching public configuration with bounded content and unique built-in games', () => {
  assert.equal(parseContent(content, branch).games[0].enabled, false);
  for (const value of [
    { ...content, branch_id: 'other' },
    { ...content, games: [...content.games, ...content.games] },
    { ...content, games: [{ template: 'remote-code', enabled: true, revision: 1 }] },
    { ...content, games: [{ template: 'pick-man', enabled: 'false', revision: 1 }] },
    {
      ...content,
      promos: [
        {
          id: 'x',
          image_asset_key: '../secret',
          title: { ru: 'x', kk: '' },
          body: { ru: 'x', kk: '' },
        },
      ],
    },
  ])
    assert.throws(() => parseContent(value, branch));
});

test('game cards from the back office: names and covers, bad entries dropped, nothing else lost', () => {
  const sha = 'a'.repeat(64);
  const parsed = parseContent(
    {
      ...content,
      game_cards: [
        {
          template: 'magic-sort',
          enabled: false,
          revision: 2,
          title: { ru: ' Сортировка ', kk: '' },
          cover: {
            card: `/v1/media/catalog/${sha}.card.webp`,
            hero: `/v1/media/catalog/${sha}.hero.webp`,
          },
        },
        { template: 'pick-man', enabled: true, revision: 1, title: null, cover: null },
        { template: 'pick-man', enabled: false, revision: 3, title: null, cover: null },
        { template: 'remote-code', enabled: true },
        {
          template: 'pick-blocks',
          enabled: true,
          title: { ru: 'x'.repeat(201), kk: '' },
          cover: { card: 'https://evil.example/x.webp', hero: '/v1/media/catalog/x.hero.webp' },
        },
      ],
    },
    branch,
  );
  assert.deepEqual(parsed.games, content.games);
  assert.deepEqual(parsed.game_cards, [
    {
      template: 'magic-sort',
      enabled: false,
      title: { ru: 'Сортировка', kk: 'Сортировка' },
      cover: {
        card: `/v1/media/catalog/${sha}.card.webp`,
        hero: `/v1/media/catalog/${sha}.hero.webp`,
      },
    },
    { template: 'pick-man', enabled: true, title: null, cover: null },
    { template: 'pick-blocks', enabled: true, title: null, cover: null },
  ]);
  assert.deepEqual(parseContent(content, branch).game_cards, []);
  assert.deepEqual(parseContent({ ...content, game_cards: 'x' }, branch).game_cards, []);
});

test('storefront video from the back office: only a content-addressed MP4 path, else built-in', () => {
  const video = `/v1/media/app/${'c'.repeat(64)}.mp4`;
  assert.deepEqual(parseContent({ ...content, splash: { video } }, branch).splash, { video });
  for (const splash of [
    null,
    undefined,
    { video: 'https://evil.example/x.mp4' },
    { video: `/v1/media/app/${'c'.repeat(64)}.mov` },
    'x',
  ])
    assert.equal(parseContent({ ...content, splash }, branch).splash, null);
});
