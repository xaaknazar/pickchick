import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keepIfSame, sameContent, shareItems } from '../../apps/mobile/src/stable-values.ts';

const source = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');

test('a re-read with the same content keeps the previous object (owner 23.11.2026, no hitches)', () => {
  const before = { enabled: true, products: [{ id: 'pick-combo', available: true }] };
  const same = { enabled: true, products: [{ id: 'pick-combo', available: true }] };
  const changed = { enabled: true, products: [{ id: 'pick-combo', available: false }] };
  assert.equal(sameContent(before, same), true);
  assert.equal(sameContent(before, changed), false);
  assert.equal(sameContent(null, same), false);
  assert.equal(sameContent(before, null), false);
  assert.equal(keepIfSame(same)(before), before);
  assert.equal(keepIfSame(changed)(before), changed);
  assert.equal(keepIfSame(same)(null), same);
  // Values JSON cannot compare are treated as changed, never as equal.
  assert.equal(sameContent({ a: 1n }, { a: 1n }), false);
});

test('unchanged dishes keep their objects; a changed dish and a changed list are new', () => {
  const key = (item) => item.id;
  const previous = [
    { id: 'a', price: '100' },
    { id: 'b', price: '200' },
  ];
  const sameList = shareItems(
    previous,
    [
      { id: 'a', price: '100' },
      { id: 'b', price: '200' },
    ],
    key,
  );
  assert.equal(sameList, previous);
  const oneChanged = shareItems(
    previous,
    [
      { id: 'a', price: '100' },
      { id: 'b', price: '250' },
    ],
    key,
  );
  assert.notEqual(oneChanged, previous);
  assert.equal(oneChanged[0], previous[0]);
  assert.deepEqual(oneChanged[1], { id: 'b', price: '250' });
  const reordered = shareItems(
    previous,
    [previous[1], previous[0]].map((x) => ({ ...x })),
    key,
  );
  assert.notEqual(reordered, previous);
  assert.equal(reordered[0], previous[1]);
  const shorter = shareItems(previous, [{ id: 'a', price: '100' }], key);
  assert.notEqual(shorter, previous);
  assert.equal(shorter[0], previous[0]);
  assert.equal(shareItems(null, previous, key), previous);
});

test('polls and re-reads never hand the whole app new objects for the same data', () => {
  assert.match(source('useAvailability.ts'), /setData\(keepIfSame\(value\)\)/);
  const store = source('store.tsx');
  assert.match(store, /setPublication\(keepIfSame\(result\.publication\)\)/);
  assert.match(store, /setMenu\(keepIfSame\(result\.menu\)\)/);
  assert.match(
    store,
    /useSharedItems\(\s*useMemo\(\s*\(\) => withAvailability\(baseProducts, availabilityData\)/,
  );
  assert.match(store, /sameContent\(previous, repriced\.cart\) \? previous : repriced\.cart/);
  assert.match(source('loyalty/useComboRewards.ts'), /setSnapshot\(\s*keepIfSame\(/);
  assert.match(source('backoffice/usePublishedContent.ts'), /setValue\(keepIfSame\(parsed\)\)/);
});

test('menu cards keep a stable open callback and ignore the zero layout of a hidden menu', () => {
  assert.match(source('ScreenHost.tsx'), /const navigate = useStableCallback\(/);
  const menu = source('screens/CatalogScreens.tsx');
  assert.match(menu, /const openProduct = useStableCallback\(/);
  assert.match(menu, /onLayout=\{\(e\) => shown\(e\) && setCatalogTop\(/);
  assert.match(menu, /onLayout=\{\(e\) => shown\(e\) && setCategoryTop\(/);
});
