// Stage 2 (24.10.2026), lane pcs: the combo stop rule on the cashier itself (audit 1.3/4.2/6.3).
// Step 1 (cashier): optional menu fields, used when present. Step 2 (cloud): emitted only behind
// CATALOG_EDGE_COMBO_STOPS_ENABLED and delivered only to an edge that sends menu_features.
/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import {
  catalogStopView,
  edgeMenuFeatures,
  hashJson,
  localCatalogId,
  menuLineStopIds,
  projectCatalogMenu,
  withoutComboStopLinks,
} from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { catalogAdminOptions } from '../../packages/catalog-admin/dist/index.js';
import {
  defaultSelections,
  itemStopView,
  menu as parsePosMenu,
  optionChangeAllowed,
  stopReasonText,
} from '../../apps/pos/dist/types.js';

const branch = '10000000-0000-4000-8000-000000000003';
const release = '30000000-0000-4000-8000-000000000001';
const at = '2026-10-24T00:00:00.000Z';
const variantOf = (id) => localCatalogId(branch, 'base-preview', id);
const optionOf = (product, group, option) =>
  localCatalogId(branch, 'modifier-option', `${product}:${group}:${option}`);
const NEW_KEYS = ['combo_component_variant_ids', 'linked_variant_id'];
const hasNewKey = (menu) => NEW_KEYS.some((key) => JSON.stringify(menu).includes(`"${key}"`));

/** Seed catalog plus owner data: fixed components (one nested combo) and explicit drink links. */
function ownerCatalog() {
  const catalog = structuredClone(mockupCatalogDraft);
  const product = (id) => catalog.products.find((p) => p.id === id);
  product('pick-combo').combo_components = [
    { product_id: 'fingers', quantity: 3 },
    { product_id: 'toast', quantity: 1 },
  ];
  // A combo inside a combo: stopping fingers also stops master-combo through pick-combo.
  product('master-combo').combo_components = [
    { product_id: 'pick-combo', quantity: 1 },
    { product_id: 'wedges', quantity: 1 },
  ];
  for (const id of ['pick-combo', 'master-combo'])
    for (const option of product(id).modifier_groups.find((g) => g.id === 'drink').options)
      if (['cola-bottle', 'cola-can', 'cola-zero'].includes(option.id))
        option.linked_product_id = 'cola';
  return catalog;
}

test('old snapshots parse unchanged; the optional cashier fields are validated', () => {
  assert.deepEqual(MenuSnapshotSchema.parse(fixtureMenu), fixtureMenu);
  const legacy = projectCatalogMenu(mockupCatalogDraft, branch, 3, at, release);
  assert.deepEqual(MenuSnapshotSchema.parse(structuredClone(legacy)), legacy);
  const extended = projectCatalogMenu(ownerCatalog(), branch, 3, at, release, {
    comboStops: true,
  });
  assert.deepEqual(MenuSnapshotSchema.parse(structuredClone(extended)), extended);
  const combo = extended.items.findIndex((i) => i.combo_component_variant_ids);
  const broken = (change) => {
    const copy = structuredClone(extended);
    change(copy.items[combo], copy);
    return MenuSnapshotSchema.safeParse(copy).success;
  };
  assert.equal(
    broken(() => {}),
    true,
  );
  // One canonical form: an empty list is omitted, never sent as [] (checksum stability).
  assert.equal(
    broken((item) => (item.combo_component_variant_ids = [])),
    false,
  );
  assert.equal(
    broken((item) => item.combo_component_variant_ids.push(item.combo_component_variant_ids[0])),
    false,
  );
  assert.equal(
    broken((item) => item.combo_component_variant_ids.push(item.variant_id)),
    false,
  );
  assert.equal(
    broken((item) => (item.combo_component_variant_ids = ['not-a-uuid'])),
    false,
  );
  assert.equal(
    broken((item) => (item.modifier_groups[0].options[0].linked_variant_id = 'cola')),
    false,
  );
  assert.equal(
    broken((item) => (item.modifier_groups[0].options[0].unknown_field = true)),
    false,
  );
});

test('flag off: the projection is byte-identical to the installed form (checksum stability)', () => {
  for (const catalog of [mockupCatalogDraft, ownerCatalog()]) {
    const legacy = projectCatalogMenu(catalog, branch, 3, at, release);
    const off = projectCatalogMenu(catalog, branch, 3, at, release, { comboStops: false });
    assert.equal(hasNewKey(legacy), false);
    assert.equal(hashJson(off), hashJson(legacy));
    const on = projectCatalogMenu(catalog, branch, 3, at, release, { comboStops: true });
    assert.equal(hasNewKey(on), true);
    assert.notEqual(hashJson(on), hashJson(legacy));
    // Stripping the cashier fields gives exactly the old publication, also its checksum.
    assert.deepEqual(withoutComboStopLinks(on), legacy);
    assert.equal(hashJson(withoutComboStopLinks(on)), hashJson(legacy));
    assert.equal(withoutComboStopLinks(legacy), legacy);
    // Deterministic: the same catalog gives the same checksum.
    assert.equal(
      hashJson(
        projectCatalogMenu(structuredClone(catalog), branch, 3, at, release, { comboStops: true }),
      ),
      hashJson(on),
    );
  }
});

test('flag on: components are flattened through nested combos; links follow the cloud rule', () => {
  const menu = projectCatalogMenu(ownerCatalog(), branch, 3, at, release, { comboStops: true });
  const item = (id) => menu.items.find((i) => i.source_id === id);
  assert.deepEqual(item('pick-combo').combo_component_variant_ids, [
    variantOf('fingers'),
    variantOf('toast'),
  ]);
  assert.deepEqual(item('master-combo').combo_component_variant_ids, [
    variantOf('pick-combo'),
    variantOf('wedges'),
    variantOf('fingers'),
    variantOf('toast'),
  ]);
  // Seed combos without owner data carry no component list (whole_product kitchen route).
  assert.equal(item('burger-combo').combo_component_variant_ids, undefined);
  assert.equal(item('fingers').combo_component_variant_ids, undefined);
  const linked = (group, option) =>
    item('pick-combo')
      .modifier_groups.flatMap((g) => g.options)
      .find((o) => o.id === optionOf('pick-combo', group, option)).linked_variant_id;
  assert.equal(linked('drink', 'cola-bottle'), variantOf('cola')); // explicit linked_product_id
  assert.equal(linked('drink', 'lemonade'), variantOf('lemonade')); // option id names a product
  assert.equal(linked('extras', 'sauce'), variantOf('sauce'));
  assert.equal(linked('drink', 'sprite'), undefined); // names no product: never matches a stop
  assert.equal(linked('sauce', 'pick'), undefined);
});

test('cashier line ids: old snapshot - item and options only; new - components and links', () => {
  const legacy = projectCatalogMenu(ownerCatalog(), branch, 3, at, release);
  const extended = projectCatalogMenu(ownerCatalog(), branch, 3, at, release, {
    comboStops: true,
  });
  const selections = [
    {
      group_id: localCatalogId(branch, 'modifier-group', 'pick-combo:drink'),
      option_id: optionOf('pick-combo', 'drink', 'cola-bottle'),
    },
  ];
  const of = (menu) => menu.items.find((i) => i.source_id === 'pick-combo');
  assert.deepEqual(menuLineStopIds(of(legacy), selections), [
    variantOf('pick-combo'),
    selections[0].option_id,
  ]);
  assert.deepEqual(
    new Set(menuLineStopIds(of(extended), selections)),
    new Set([
      variantOf('pick-combo'),
      selections[0].option_id,
      variantOf('cola'),
      variantOf('fingers'),
      variantOf('toast'),
    ]),
  );
  // A selection that is not in the menu adds only its own id (priceCart rejects it anyway).
  assert.deepEqual(
    menuLineStopIds(of(legacy), [{ group_id: selections[0].group_id, option_id: variantOf('x') }]),
    [variantOf('pick-combo'), variantOf('x')],
  );
});

test('POS view and cashier ids agree with the cloud rule for every single stop', () => {
  const catalog = ownerCatalog();
  const menu = parsePosMenu(
    JSON.parse(
      JSON.stringify(projectCatalogMenu(catalog, branch, 3, at, release, { comboStops: true })),
    ),
  );
  const candidates = [
    ...menu.items.map((i) => i.variant_id),
    ...menu.items.flatMap((i) =>
      (i.modifier_groups ?? []).flatMap((g) => g.options.map((o) => o.id)),
    ),
  ];
  const sets = [
    [],
    ...[...new Set(candidates)].map((id) => [id]),
    [variantOf('cola'), variantOf('lemonade'), variantOf('fuse-peach'), variantOf('water')],
    menu.items
      .find((i) => i.source_id === 'pick-combo')
      .modifier_groups.find((g) => g.min_selected > 0 && g.options.length === 4)
      .options.map((o) => o.id),
  ];
  for (const ids of sets) {
    const stopped = new Set(ids);
    const stops = new Map(
      candidates.map((id) => [id, { variant_id: id, stopped: stopped.has(id), version: 1 }]),
    );
    const cloud = new Map(
      catalogStopView(branch, stopped, catalog.products).map((p) => [p.productId, p]),
    );
    for (const item of menu.items) {
      const expected = cloud.get(item.source_id);
      const view = itemStopView(menu, item, stops);
      assert.equal(view.available, expected.available, `${item.source_id} ${ids}`);
      assert.deepEqual(
        [...view.stoppedOptions].sort(),
        expected.stoppedOptions
          .map((s) => optionOf(item.source_id, s.group_id, s.option_id))
          .sort(),
        `${item.source_id} options ${ids}`,
      );
      if (!view.available) assert.match(stopReasonText(view), /стоп-листе|нет доступных/);
      // The cashier refuses a line when the cloud says the combo or a chosen option is stopped.
      // Options published as unavailable are refused earlier by pricing (INVALID_REQUEST).
      for (const group of item.modifier_groups ?? [])
        for (const option of group.options.filter((o) => o.available !== false)) {
          const line = menuLineStopIds(item, [{ group_id: group.id, option_id: option.id }]);
          const refused = line.some((id) => stopped.has(id));
          const blockedByComponent = (item.combo_component_variant_ids ?? []).some((id) =>
            stopped.has(id),
          );
          assert.equal(
            refused,
            stopped.has(item.variant_id) ||
              blockedByComponent ||
              view.stoppedOptions.has(option.id),
            `${item.source_id} ${option.id} ${ids}`,
          );
        }
    }
  }
});

test('POS choice sheet: a stopped default is not preselected; a stopped option is only reduced', () => {
  const menu = parsePosMenu(
    JSON.parse(
      JSON.stringify(
        projectCatalogMenu(ownerCatalog(), branch, 3, at, release, { comboStops: true }),
      ),
    ),
  );
  const master = menu.items.find((i) => i.source_id === 'master-combo');
  const optionIn = (group, id) =>
    master.modifier_groups
      .flatMap((g) => g.options)
      .find((o) => o.id === optionOf('master-combo', group, id));
  const groupOf = (group, id) =>
    master.modifier_groups.find((g) => g.options.includes(optionIn(group, id))).id;
  const stopsOf = (ids) =>
    new Map(ids.map((id) => [id, { variant_id: id, stopped: true, version: 1 }]));
  // Nothing stopped: the published defaults (cola-bottle x1 and the 2-sauce default).
  assert.deepEqual(defaultSelections(master, new Map()), [
    {
      group_id: groupOf('drink', 'cola-bottle'),
      option_id: optionOf('master-combo', 'drink', 'cola-bottle'),
      quantity: 1,
    },
    {
      group_id: groupOf('sauce', 'pick'),
      option_id: optionOf('master-combo', 'sauce', 'pick'),
      quantity: 2,
    },
  ]);
  // The cola product (linked) and the pick sauce (own stop) are out: neither is preselected, so
  // the cashier picks other options instead of being stuck with a default the edge refuses.
  const stops = stopsOf([variantOf('cola'), optionOf('master-combo', 'sauce', 'pick')]);
  assert.deepEqual(defaultSelections(master, stops), []);
  const pick = optionIn('sauce', 'pick');
  const cola = optionIn('drink', 'cola-bottle');
  // An older line may still hold a stopped option: reducing or removing it is allowed...
  assert.equal(optionChangeAllowed(pick, stops, 2, 1), true);
  assert.equal(optionChangeAllowed(pick, stops, 2, 0), true);
  assert.equal(optionChangeAllowed(cola, stops, 1, 1), true);
  // ...adding or increasing it is not.
  assert.equal(optionChangeAllowed(pick, stops, 0, 1), false);
  assert.equal(optionChangeAllowed(pick, stops, 1, 2), false);
  assert.equal(optionChangeAllowed(cola, stops, 0, 1), false);
  assert.equal(optionChangeAllowed(optionIn('sauce', 'hot'), stops, 0, 1), true);
});

test('POS menu parser keeps valid cashier fields and drops malformed ones', () => {
  const extended = projectCatalogMenu(ownerCatalog(), branch, 3, at, release, {
    comboStops: true,
  });
  const parsed = parsePosMenu(JSON.parse(JSON.stringify(extended)));
  const pick = parsed.items.find((i) => i.source_id === 'pick-combo');
  assert.deepEqual(pick.combo_component_variant_ids, [variantOf('fingers'), variantOf('toast')]);
  const raw = JSON.parse(JSON.stringify(extended));
  const rawPick = raw.items.find((i) => i.source_id === 'pick-combo');
  rawPick.combo_component_variant_ids = ['nope'];
  rawPick.modifier_groups[0].options[0].linked_variant_id = 42;
  const loose = parsePosMenu(raw).items.find((i) => i.source_id === 'pick-combo');
  assert.equal(loose.combo_component_variant_ids, undefined);
  assert.equal(loose.modifier_groups[0].options[0].linked_variant_id, undefined);
  // An old snapshot still parses to exactly the old shape.
  const legacy = projectCatalogMenu(ownerCatalog(), branch, 3, at, release);
  assert.equal(hasNewKey(parsePosMenu(JSON.parse(JSON.stringify(legacy)))), false);
});

test('edge menu features are parsed leniently and the cloud flag strictly, default off', () => {
  assert.deepEqual(edgeMenuFeatures('combo_stops'), ['combo_stops']);
  assert.deepEqual(edgeMenuFeatures('future_thing,combo_stops'), ['combo_stops']);
  for (const value of [undefined, '', 'combo-stops', ['combo_stops'], 7, 'x'.repeat(300)])
    assert.deepEqual(edgeMenuFeatures(value), []);
  assert.equal(catalogAdminOptions({}).edgeComboStops, undefined);
  const edge = {
    CATALOG_EDGE_PUBLICATION_ENABLED: 'true',
    CATALOG_EDGE_PUBLICATION_BRANCH_ID: branch,
  };
  assert.equal(catalogAdminOptions(edge).edgeComboStops, undefined);
  assert.equal(
    catalogAdminOptions({ ...edge, CATALOG_EDGE_COMBO_STOPS_ENABLED: 'false' }).edgeComboStops,
    undefined,
  );
  assert.equal(
    catalogAdminOptions({ ...edge, CATALOG_EDGE_COMBO_STOPS_ENABLED: 'true' }).edgeComboStops,
    true,
  );
  assert.throws(
    () => catalogAdminOptions({ ...edge, CATALOG_EDGE_COMBO_STOPS_ENABLED: 'yes' }),
    /CATALOG_EDGE_COMBO_STOPS_CONFIGURATION_INVALID/,
  );
});
