import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createSharedItems,
  keepIfSame,
  sameContent,
  shareItems,
  stableCallbacks,
} from '../../apps/mobile/src/stable-values.ts';

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

test('the same input list is not compared again on later renders (audit 23.11 #4)', () => {
  let keyCalls = 0;
  const key = (item) => {
    keyCalls += 1;
    return item.id;
  };
  const share = createSharedItems();
  const first = [
    { id: 'a', price: '100' },
    { id: 'b', price: '200' },
  ];
  assert.equal(share(first, key), first);
  // A re-read with one changed dish: the result keeps old items, so it is not the input array.
  const second = [
    { id: 'a', price: '100' },
    { id: 'b', price: '250' },
  ];
  const shared = share(second, key);
  assert.notEqual(shared, second);
  assert.equal(shared[0], first[0]);
  // Later renders pass the same (memoised) input: the cached result, no pass over the items.
  keyCalls = 0;
  assert.equal(share(second, key), shared);
  assert.equal(share(second, key), shared);
  assert.equal(keyCalls, 0);
  // A new input is compared with the last result, so unchanged items keep their objects.
  const third = second.map((item) => ({ ...item }));
  assert.equal(share(third, key), shared);
  assert.ok(keyCalls > 0);
  assert.match(source('stable-values.ts'), /share\.current \?\?= createSharedItems<T>\(\)/);
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

test('an authenticated request does not hand the app a new account (audit 23.11 #1)', () => {
  // withOrderAccess ends with snapshot() after every request (15 s rewards poll, order watches).
  const account = source('useAccount.tsx');
  assert.match(account, /setAccount\(\s*keepIfSame<Account \| null>\(/);
  assert.match(account, /setChallenge\(\s*keepIfSame<DemoChallenge \| null>\(/);
  assert.match(account, /setLegal\(\s*keepIfSame<AccountContextValue\['legal'\]>\(/);
  assert.match(account, /setChannels\(keepIfSame\(core\.config\.channels\)\)/);
  // The same customer read twice is the same content, so the state setter keeps the object.
  const customer = () => ({
    version: 2,
    kind: 'server_customer',
    customerId: 'c1',
    phone: '+77000000000',
    createdAt: Date.parse('2026-11-01T00:00:00Z'),
    profile: { nickname: 'A', birthDate: null, gender: null, completedAt: null },
  });
  const before = customer();
  assert.equal(keepIfSame(customer())(before), before);
  assert.equal(keepIfSame(null)(null), null);
  const renamed = { ...customer(), profile: { ...customer().profile, nickname: 'B' } };
  assert.equal(keepIfSame(renamed)(before), renamed);
});

test('the app model and its methods keep their identity between renders (audit 23.11 #2)', () => {
  // Methods: one identity for the life of the provider, always the latest closure.
  let render = { add: (n) => n + 1, name: () => 'first' };
  const stable = stableCallbacks(() => render);
  const { add, name } = stable;
  assert.equal(add(1), 2);
  render = { add: (n) => n + 10, name: () => 'second' };
  assert.equal(stable.add, add);
  assert.equal(add(1), 11);
  assert.equal(name(), 'second');
  assert.deepEqual(Object.keys(stable), ['add', 'name']);

  const store = source('store.tsx');
  assert.match(store, /const actions = useStableCallbacks<ModelActions>\(\{/);
  assert.match(store, /const previewActions = useStableCallbacks<PreviewActions>\(\{/);
  assert.match(store, /const selectGift = useStableCallback\(/);
  assert.match(store, /const model = useMemo<MobileModel>\(/);
  assert.match(store, /const previewModel = useMemo<MobileModel>\(/);
  assert.match(
    store,
    /const value = useMemo\(\(\) => \(\{ live: model, preview: previewModel \}\), \[model, previewModel\]\);/,
  );
  assert.match(store, /<Context\.Provider value=\{value\}>/);
  // Every value the live model shows is a dependency of its memo (no stale screen).
  const memo = store.slice(store.indexOf('const model = useMemo<MobileModel>('));
  const body = memo.slice(0, memo.indexOf('// Every value the model shows.'));
  const deps = memo.slice(
    memo.indexOf('// Every value the model shows.'),
    memo.indexOf('const previewTestFlow'),
  );
  const stableNames = new Set([
    'setPracticeScore',
    'setDiningMode',
    'setPaymentMethod',
    'setSelectedId',
  ]);
  for (const [, key, value] of body.matchAll(/^ {6}(?:\.\.\.)?(\w+)(?:: (\w+))?,$/gm)) {
    const name = value ?? key;
    if (!stableNames.has(name)) assert.match(deps, new RegExp(`^ {6}${name},$`, 'm'), name);
  }
  // The values under the model keep their objects too.
  const orders = source('useTestOrders.ts');
  assert.match(orders, /return useMemo\(\s*\(\) => \(\{\s*comboProgress:/);
  assert.match(orders, /const submit = useStableCallback\(/);
  assert.match(source('loyalty/useComboRewards.ts'), /\? SIGNED_OUT\s*:/);
  assert.match(source('loyalty/useComboProgress.ts'), /if \(!enabled\) return SIGNED_OUT;/);
});

test('menu cards keep a stable open callback and ignore the zero layout of a hidden menu', () => {
  assert.match(source('ScreenHost.tsx'), /const navigate = useStableCallback\(/);
  const menu = source('screens/CatalogScreens.tsx');
  assert.match(menu, /const openProduct = useStableCallback\(/);
  assert.match(menu, /onLayout=\{\(e\) => shown\(e\) && setCatalogTop\(/);
  assert.match(menu, /onLayout=\{\(e\) => shown\(e\) && setCategoryTop\(/);
});
