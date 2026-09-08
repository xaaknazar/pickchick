import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountCanAct,
  accountDestination,
  requiresAccount,
} from '../../apps/mobile/src/account-access.ts';

test('guests and unrestored identities cannot act; both supported account modes can', () => {
  assert.equal(accountCanAct({ ready: true, account: null }), false);
  assert.equal(accountCanAct({ ready: false, account: { kind: 'local_demo' } }), false);
  for (const kind of ['local_demo', 'server_customer']) {
    assert.equal(accountCanAct({ ready: true, account: { kind } }), true);
  }
});

test('all order operations and playable game screens require login, including preview games', () => {
  for (let n = 12; n <= 22; n++) assert.equal(requiresAccount('M' + n, false), true);
  for (const id of ['M27', 'M28']) {
    assert.equal(requiresAccount(id, false), true);
    assert.equal(requiresAccount(id, true), true);
  }
  for (const id of ['M02', 'M03', 'M04', 'M06', 'M07', 'M08', 'M09', 'M26']) {
    assert.equal(requiresAccount(id, false), false);
  }
  assert.equal(requiresAccount('M12', true), false);
});

test('login continuation accepts only known protected destinations', () => {
  for (const id of ['pick-blocks', 'M12', 'M27', 'M28']) assert.equal(accountDestination(id), id);
  for (const value of [undefined, null, ['M12'], '/screen/M12', 'https://example.com', 'M02']) {
    assert.equal(accountDestination(value), null);
  }
});
