import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopFile } from './support.mjs';

const { createJournalStore } = await import(pathToFileURL(desktopFile('journal.mjs')).href);
const id = (last) => `10000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const session = {
  session_id: id(1),
  staff_id: id(2),
  terminal_id: id(3),
  branch_id: id(4),
  role: 'cashier',
  expires_at: '2030-01-01T01:00:00.000Z',
};
const scope = `${session.branch_id}.${session.staff_id}.${session.terminal_id}`;
const key = `pickchick.pos.journal.v1.${scope}`;
const snapshot = (quantity = 1) =>
  JSON.stringify({
    version: 1,
    scope,
    draft: {
      release_id: id(5),
      service_mode: 'takeaway',
      items: [{ variant_id: id(6), quantity }],
    },
    pending: null,
    known: [],
    selected: null,
  });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-native-journal-'));
  let clock = Date.parse('2030-01-01T00:00:00.000Z');
  const options = { directory, now: () => clock };
  try {
    await run({
      directory,
      options,
      advance: (ms) => {
        clock += ms;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function authorize(store) {
  store.setSession(session, session.session_id);
}

test('modifier selections and pending shift commands survive a native journal restart', async () => {
  await fixture(async ({ options }) => {
    const value = JSON.parse(snapshot());
    const option = { group_id: id(20), option_id: id(21), quantity: 2 };
    value.draft.items.push({ variant_id: id(6), quantity: 1, modifiers: [option] });
    for (const pending of [
      { kind: 'shift_open', path: 'cash-shifts', body: { opening_cash_minor: '100000' } },
      {
        kind: 'shift_close',
        path: `cash-shifts/${id(30)}/close`,
        body: {
          expected_version: 1,
          counted_cash_minor: '100000',
          reason: 'End of synthetic shift',
        },
      },
    ]) {
      value.pending = { ...pending, key: id(31), at: '2030-01-01T00:00:00.000Z' };
      const store = createJournalStore(options);
      authorize(store);
      store.setItem(key, JSON.stringify(value));
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.deepEqual(JSON.parse(restarted.getItem(key)), value);
    }
    const valid = JSON.stringify(value);
    const store = createJournalStore(options);
    authorize(store);
    const invalid = [
      (v) => v.draft.items.push({ variant_id: id(6), quantity: 3 }),
      (v) => v.draft.items[1].modifiers.push({ ...option, quantity: 1 }),
      (v) => {
        v.draft.items[1].modifiers[0].quantity = 0;
      },
      (v) => {
        v.draft.items[1].modifiers[0].quantity = 100;
      },
      (v) => {
        v.pending.path = `orders/${id(30)}/close`;
      },
      (v) => {
        v.pending.body.counted_cash_minor = '-1';
      },
      (v) => {
        v.pending.body.counted_cash_minor = '9223372036854775808';
      },
      (v) => {
        v.pending.body.reason = ' ';
      },
    ];
    for (const change of invalid) {
      const rejected = JSON.parse(valid);
      change(rejected);
      assert.throws(() => store.setItem(key, JSON.stringify(rejected)), /STORAGE_UNAVAILABLE/);
      assert.equal(store.getItem(key), valid, 'Rejected write must preserve pending recovery');
    }
  });
});

test('native journal requires a matching confirmed unexpired staff scope and has no credential fields', async () => {
  await fixture(async ({ options, advance, directory }) => {
    const store = createJournalStore(options);
    assert.throws(() => store.getItem(key));
    assert.throws(() => store.setItem(key, snapshot()));
    store.setSession(session, id(99));
    assert.throws(() => store.getItem(key));
    authorize(store);
    assert.equal(store.getItem(key), null);
    store.setItem(key, snapshot());
    assert.equal(store.getItem(key), snapshot());
    for (const foreign of ['../../config.json', key.replace(session.terminal_id, id(9))]) {
      assert.throws(() => store.getItem(foreign));
      assert.throws(() => store.setItem(foreign, snapshot()));
    }
    assert.throws(() =>
      store.setItem(
        key,
        JSON.stringify({ ...JSON.parse(snapshot()), token: 'synthetic-forbidden' }),
      ),
    );
    assert.equal(store.getItem(key), snapshot());
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{64}\.json$/);
    assert.equal(
      (await readFile(join(directory, files[0]), 'utf8')).includes('synthetic-forbidden'),
      false,
    );
    advance(3600000);
    assert.throws(() => store.getItem(key));
    assert.throws(() => store.setItem(key, snapshot(2)));
    advance(-3600000);
    authorize(store);
    assert.equal(store.getItem(key), snapshot());
    store.setSession({ ...session, role: 'kitchen' }, session.session_id);
    assert.throws(() => store.getItem(key));
    assert.equal((await readdir(directory)).length, 1, 'Revocation must preserve the journal');
  });
});

test('failed flush or replacement never acknowledges a new journal and preserves the previously durable snapshot', async () => {
  await fixture(async ({ options, directory }) => {
    const initial = createJournalStore(options);
    authorize(initial);
    initial.setItem(key, snapshot());
    for (const operation of ['fsyncSync', 'renameSync']) {
      const disk = {
        ...fs,
        [operation]: () => {
          throw Object.assign(new Error('SYNTHETIC_DISK_FAILURE'), { code: 'EIO' });
        },
      };
      const failed = createJournalStore({ ...options, fsImpl: disk });
      authorize(failed);
      assert.throws(() => failed.setItem(key, snapshot(2)), /SYNTHETIC_DISK_FAILURE/);
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.equal(restarted.getItem(key), snapshot());
      assert.equal((await readdir(directory)).length, 1, 'Failed temporary writes must be cleaned');
    }
  });
});

test('a malformed or oversized existing journal blocks reads and replacement instead of silently resetting the order', async () => {
  await fixture(async ({ options, directory }) => {
    const original = createJournalStore(options);
    authorize(original);
    original.setItem(key, snapshot());
    const filename = join(directory, (await readdir(directory))[0]);
    for (const damaged of ['{"version":', 'я'.repeat(60000)]) {
      await writeFile(filename, damaged);
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.throws(() => restarted.getItem(key));
      assert.throws(() => restarted.setItem(key, snapshot(2)));
      assert.equal(
        await readFile(filename, 'utf8'),
        damaged,
        'Corrupt evidence must not be overwritten',
      );
    }
  });
});

test('atomic unpaid kitchen admission survives restart and rejects altered mode without losing the pending order', async () => {
  await fixture(async ({ options }) => {
    const value = JSON.parse(snapshot());
    value.pending = {
      kind: 'create',
      path: 'orders',
      body: { quote_id: id(9), kitchen_admission: 'unpaid' },
      key: id(10),
      at: '2030-01-01T00:00:00.000Z',
    };
    const store = createJournalStore(options);
    authorize(store);
    const expected = JSON.stringify(value);
    store.setItem(key, expected);
    const restarted = createJournalStore(options);
    authorize(restarted);
    assert.equal(restarted.getItem(key), expected);
    for (const mode of ['paid', null, true]) {
      value.pending.body.kitchen_admission = mode;
      assert.throws(() => restarted.setItem(key, JSON.stringify(value)));
      assert.equal(restarted.getItem(key), expected);
    }
    delete value.pending.body.kitchen_admission;
    restarted.setItem(key, JSON.stringify(value));
    assert.deepEqual(
      JSON.parse(restarted.getItem(key)),
      value,
      'Legacy pending create remains readable',
    );
  });
});
