import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { encrypt } from '../../customer-identity/dist/crypto.js';
import { readGuestContact } from '../../customer-identity/dist/index.js';
import { Backoffice, grantBackoffice, guestView, maskPhone } from '../dist/index.js';

/**
 * «Гости» (owner 15.11.2026): name and phone from the app profile instead of an id. A manager
 * grant sees the full phone and birth date, other roles a masked phone (decision card 15.11).
 * Synthetic data only.
 */
test('maskPhone and guestView', () => {
  assert.equal(maskPhone('+77011234567'), '+7 701 ••• •• 67');
  assert.equal(maskPhone('123'), '•••');
  const contact = () => ({
    phone: '+77011234567',
    nickname: ' Айгерим ',
    birth_date: '1999-04-02',
  });
  assert.deepEqual(guestView(contact, true), {
    name: 'Айгерим',
    phone: '+7 701 123 45 67',
    phone_masked: false,
    birth_date: '1999-04-02',
  });
  assert.deepEqual(guestView(contact, false), {
    name: 'Айгерим',
    phone: '+7 701 ••• •• 67',
    phone_masked: true,
    birth_date: null,
  });
  const broken = () => {
    throw new Error('key');
  };
  assert.deepEqual(guestView(broken, true), {
    name: null,
    phone: null,
    phone_masked: false,
    birth_date: null,
  });
});

test('managers see the guest phone, analysts a masked one, ciphers never leave the server', () =>
  withSyncDatabases(async (c) => {
    const key = randomBytes(32);
    const customer = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at)
       VALUES($1,$2,$3,$4,now())`,
      [
        customer,
        'b'.repeat(64),
        encrypt(key, `phone:${customer}`, '+77011234567'),
        encrypt(key, `profile:${customer}`, {
          nickname: 'Синтетический гость',
          birth_date: '2000-01-31',
          gender: null,
        }),
      ],
    );
    const db = await c.cloud.pool.connect();
    try {
      await db.query('SET session_replication_role = replica');
      await db.query(
        `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,customer_id,quote_id,fiscal_account_id,
          snapshot,total_minor,currency,quote_digest,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,1000,'KZT',$9,now())`,
        [
          randomUUID(),
          c.org,
          c.branch,
          randomUUID(),
          customer,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ channel: 'mobile', lines: [] }),
          'a'.repeat(64),
        ],
      );
    } finally {
      await db.query('SET session_replication_role = DEFAULT');
      db.release();
    }
    const person = async (name, role) => {
      const m = await provisionCatalogManager(c.cloud.pool, {
        organization_id: c.org,
        name,
        branch_ids: [c.branch],
      });
      await grantBackoffice(c.cloud.pool, m.actor_id, c.branch, role);
      return m;
    };
    const manager = await person('Синтетический управляющий', 'manager');
    const analyst = await person('Синтетический аналитик', 'analyst');
    const bo = new Backoffice(c.cloud.pool, true, {
      guestContact: (row) => readGuestContact(key, row),
    });
    const [full] = (await bo.read(manager.token, c.branch)).guests;
    assert.equal(full.id, customer);
    assert.equal(full.name, 'Синтетический гость');
    assert.equal(full.phone, '+7 701 123 45 67');
    assert.equal(full.birth_date, '2000-01-31');
    assert.equal(full.orders, 1);
    assert.equal('phone_cipher' in full || 'profile_cipher' in full, false);
    const [masked] = (await bo.read(analyst.token, c.branch)).guests;
    assert.equal(masked.name, 'Синтетический гость');
    assert.equal(masked.phone, '+7 701 ••• •• 67');
    assert.equal(masked.phone_masked, true);
    assert.equal(masked.birth_date, null);
    // Without the key (customer auth off) the list is exactly as before.
    const [plain] = (await new Backoffice(c.cloud.pool, true).read(manager.token, c.branch)).guests;
    assert.deepEqual(Object.keys(plain).sort(), [
      'created_at',
      'id',
      'last_order_at',
      'marketing_consent',
      'orders',
    ]);
  }));
