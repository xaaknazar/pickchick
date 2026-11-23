import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { parseContent } from '../../apps/mobile/src/backoffice/content-model.ts';
import { createSharedPoller } from '../../apps/mobile/src/shared-poller.ts';
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

test('every screen that shows published content shares one reader per branch (audit 23.11 #8)', async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const reads = [];
  const ticks = new Set();
  let answer = { branch_id: 'a', games: [] };
  const poller = createSharedPoller({
    read: async (key, signal) => {
      reads.push({ key, signal });
      return answer;
    },
    watch: (reload) => {
      ticks.add(reload);
      return () => ticks.delete(reload);
    },
  });
  const tick = async () => {
    for (const reload of ticks) reload();
    await settle();
  };
  const renders = [0, 0, 0];
  const leave = renders.map((_, index) => poller.subscribe('a', () => (renders[index] += 1)));
  await settle();
  // Three subscribers: one request and one timer, and all three get the value.
  assert.equal(reads.length, 1);
  assert.equal(ticks.size, 1);
  assert.deepEqual(renders, [1, 1, 1]);
  const first = poller.get('a');
  assert.deepEqual(first, answer);
  // A minute tick with the same content: one request, the same object, nobody renders.
  answer = { ...answer, games: [] };
  await tick();
  assert.equal(reads.length, 2);
  assert.equal(poller.get('a'), first);
  assert.deepEqual(renders, [1, 1, 1]);
  // Changed content reaches every subscriber; a refused read (null) or a failure keeps it.
  answer = { branch_id: 'a', games: [{ template: 'pick-man', enabled: false, revision: 2 }] };
  await tick();
  assert.deepEqual(renders, [2, 2, 2]);
  const changed = poller.get('a');
  answer = null;
  await tick();
  assert.equal(poller.get('a'), changed);
  // Another branch has its own reader.
  const other = poller.subscribe('b', () => {});
  await settle();
  assert.equal(ticks.size, 2);
  assert.equal(reads.at(-1).key, 'b');
  other();
  assert.equal(ticks.size, 1);
  // The reader stops only when its last subscriber leaves; the value stays for the next one.
  leave[0]();
  leave[1]();
  assert.equal(ticks.size, 1);
  assert.equal(reads[0].signal.aborted, false);
  leave[2]();
  assert.equal(ticks.size, 0);
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(poller.get('a'), changed);
  const before = reads.length;
  const again = poller.subscribe('a', () => {});
  await settle();
  assert.equal(reads.length, before + 1);
  again();

  const hook = readFileSync(
    new URL('../../apps/mobile/src/backoffice/usePublishedContent.ts', import.meta.url),
    'utf8',
  );
  assert.match(hook, /const published = createSharedPoller<PublishedContent>\(/);
  assert.match(hook, /useSyncExternalStore\(subscribe, snapshot, snapshot\)/);
  assert.doesNotMatch(hook, /useEffect/);
});
