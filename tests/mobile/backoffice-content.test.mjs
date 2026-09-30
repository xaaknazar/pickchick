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
