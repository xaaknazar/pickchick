import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { hashJson } from '@pickchick/menu-sync';
import { priceCart } from '@pickchick/local-orders';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import { prepareLocalDraft } from '../../scripts/local-pos-draft.mjs';
import { prepareLocalCatalogUpgrade } from '../../scripts/local-pos-catalog-upgrade.mjs';

const oldBytes = await readFile(
  new URL('../../infra/windows/local-pos-draft-catalog.json', import.meta.url),
);
const newBytes = await readFile(
  new URL('../../infra/windows/local-pos-draft-catalog-v2.json', import.meta.url),
);
const oldCatalog = JSON.parse(oldBytes),
  catalog = JSON.parse(newBytes);
function fixture() {
  const setup = {
    format: 'pickchick-local-pos-draft-v1',
    confirmation: 'prepare_local_display_only',
    branch: {
      id: randomUUID(),
      code: 'PREVIEW-UPGRADE-TEST',
      name: 'Isolated catalog test',
      timezone: 'Asia/Almaty',
      ordering_enabled: false,
    },
    staff: {
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      name: 'Test cashier',
      role: 'cashier',
    },
    release_id: randomUUID(),
  };
  const old = prepareLocalDraft(setup, oldBytes, setup.branch.id);
  const record = {
    format: 'pickchick-local-pos-draft-record-v1',
    state: 'local_preview_prepared',
    branch_id: old.branch.id,
    release_id: old.menu.release_id,
    created_at: old.menu.published_at,
    menu_checksum: hashJson(old.menu),
    catalog_sha256: old.catalogSha256,
    source: old.source,
    products: 24,
    ordering_enabled: false,
    content_reviewed: false,
    cloud_registered: false,
    cloud_published: false,
    payments_enabled: false,
    images_in_pos: false,
    modifiers_in_pos: false,
    audit_id: old.auditId,
    staff_setup: old.staff,
  };
  const input = {
    format: 'pickchick-local-pos-upgrade-v2',
    confirmation: 'upgrade_local_display_only',
    branch_id: old.branch.id,
    previous_release_id: old.menu.release_id,
    expected_menu_checksum: hashJson(old.menu),
    release_id: randomUUID(),
  };
  const prepare = (candidate = input, evidence = record) =>
    prepareLocalCatalogUpgrade(
      candidate,
      Buffer.from(JSON.stringify(evidence)),
      oldBytes,
      newBytes,
      old.branch.id,
    );
  return { old, record, input, prepare };
}
const defaults = (item) =>
  (item.modifier_groups ?? []).flatMap((group) =>
    group.options
      .filter((option) => option.default_quantity > 0)
      .map((option) => ({
        group_id: group.id,
        option_id: option.id,
        quantity: option.default_quantity,
      })),
  );

test('v2 preserves v1 identifiers/base prices, owner modifier limits and 23 actual photo hashes', async () => {
  const { old, prepare } = fixture();
  const result = prepare();
  assert.deepEqual(result.previousMenu, old.menu);
  assert.equal(result.menu.version, 2);
  assert.equal(result.menu.items.length, 24);
  for (let i = 0; i < 24; i++) {
    const upgraded = result.menu.items[i],
      original = old.menu.items[i],
      source = catalog.products[i];
    const ownerProduct = testCompleteCatalog.products[i];
    assert.equal(source.source_id, ownerProduct.id);
    assert.equal(source.modifier_groups.length, ownerProduct.modifier_groups.length);
    for (const key of Object.keys(original)) assert.deepEqual(upgraded[key], original[key]);
    assert.equal(source.price_minor, oldCatalog.products[i].price_minor);
    for (let j = 0; j < source.modifier_groups.length; j++) {
      const group = upgraded.modifier_groups[j],
        expected = source.modifier_groups[j];
      const ownerGroup = ownerProduct.modifier_groups[j];
      assert.equal(group.min_selected, expected.min_selected);
      assert.equal(group.max_selected, expected.max_selected);
      assert.equal(group.min_selected, ownerGroup.min);
      assert.equal(group.max_selected, ownerGroup.max);
      assert.equal(group.options.length, ownerGroup.options.length);
      for (let k = 0; k < expected.options.length; k++) {
        const option = group.options[k],
          owner = expected.options[k];
        for (const field of ['price_minor', 'max_quantity', 'default_quantity', 'available'])
          assert.equal(option[field], owner[field]);
        assert.equal(option.price_minor, ownerGroup.options[k].price_delta_minor);
        for (const field of ['max_quantity', 'default_quantity', 'available'])
          assert.equal(option[field], ownerGroup.options[k][field]);
        assert.deepEqual(option.name, { ru: owner.name_ru, kk: '-' });
      }
    }
  }
  assert.deepEqual(prepare().menu.items, result.menu.items);
  assert.equal(result.menu.items.filter((item) => item.image_url).length, 23);
  assert.equal(
    result.menu.items[catalog.products.findIndex((p) => p.source_id === 'piko')].image_url,
    undefined,
  );
  const inventory = JSON.parse(
    await readFile(
      new URL('../../infra/windows/local-pos-photo-inventory-v2.json', import.meta.url),
    ),
  );
  for (const photo of inventory.photos) {
    const bytes = await readFile(
      new URL('../../design/prototype/assets/mockup/' + photo.filename, import.meta.url),
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), photo.sha256);
    assert.equal(bytes.length, photo.bytes);
  }
});

test('source defaults price all dishes and repeated option quantities multiply exact minor units', () => {
  const { prepare } = fixture();
  const { menu } = prepare();
  for (const item of menu.items) {
    const modifiers = defaults(item);
    const quote = priceCart(menu, {
      release_id: menu.release_id,
      service_mode: 'takeaway',
      items: [
        { variant_id: item.variant_id, quantity: 1, ...(modifiers.length ? { modifiers } : {}) },
      ],
    });
    let expected = BigInt(item.price_minor);
    for (const selection of modifiers)
      expected +=
        BigInt(
          item.modifier_groups
            .find((g) => g.id === selection.group_id)
            .options.find((o) => o.id === selection.option_id).price_minor,
        ) * BigInt(selection.quantity);
    assert.equal(quote.total_minor, expected.toString());
  }
  const pick = menu.items[0],
    extraGroup = pick.modifier_groups.find((g) => g.name.ru === 'Добавить к заказу');
  const fingers = extraGroup.options.find((o) => o.name.ru === 'Фингерс, 1 шт');
  const modifiers = [
    ...defaults(pick),
    { group_id: extraGroup.id, option_id: fingers.id, quantity: 3 },
  ];
  const cart = {
    release_id: menu.release_id,
    service_mode: 'takeaway',
    items: [{ variant_id: pick.variant_id, quantity: 2, modifiers }],
  };
  const quote = priceCart(menu, cart);
  assert.equal(quote.total_minor, ((419000n + 69000n * 3n) * 2n).toString());
  assert.equal(
    quote.lines[0].modifiers.find((option) => option.option_id === fingers.id).quantity,
    3,
  );
  assert.throws(() =>
    priceCart(menu, {
      ...cart,
      items: [{ ...cart.items[0], modifiers: [...modifiers, modifiers.at(-1)] }],
    }),
  );
  assert.throws(() =>
    priceCart(menu, {
      ...cart,
      items: [
        { ...cart.items[0], modifiers: [...defaults(pick), { ...modifiers.at(-1), quantity: 11 }] },
      ],
    }),
  );
});

test('upgrade preparation rejects changed preview evidence, approvals and catalog bytes', () => {
  const { old, record, input, prepare } = fixture();
  for (const patch of [
    { branch_id: randomUUID() },
    { previous_release_id: randomUUID() },
    { release_id: input.previous_release_id },
    { expected_menu_checksum: '0'.repeat(64) },
  ])
    assert.throws(() => prepare({ ...input, ...patch }));
  for (const patch of [
    { ordering_enabled: true },
    { cloud_published: true },
    { content_reviewed: true },
    { images_in_pos: true },
    { catalog_sha256: '0'.repeat(64) },
  ])
    assert.throws(() => prepare(input, { ...record, ...patch }));
  assert.throws(
    () =>
      prepareLocalCatalogUpgrade(
        input,
        Buffer.from(JSON.stringify(record)),
        oldBytes,
        Buffer.from('changed'),
        old.branch.id,
      ),
    /catalog bytes/,
  );
});
