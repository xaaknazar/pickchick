import test from 'node:test';
import assert from 'node:assert/strict';
import { channelNumberGrants } from '../../infra/staging/channel-number-grants.mjs';

const tables =
  'channel_number_ranges,channel_number_shifts,channel_number_counters,channel_number_holds';
const functions =
  'channel_number_allocate(uuid,text,uuid),channel_number_release(uuid),channel_number_open_shift(uuid,text)';

test('channel number grants: read tables, execute functions, never write directly', () => {
  assert.equal(
    channelNumberGrants('api_runtime', true),
    [
      `REVOKE ALL ON ${tables} FROM api_runtime;`,
      `REVOKE ALL ON FUNCTION ${functions} FROM api_runtime;`,
      `GRANT SELECT ON ${tables} TO api_runtime;`,
      `GRANT EXECUTE ON FUNCTION ${functions} TO api_runtime;`,
    ].join('\n'),
  );
  assert.doesNotMatch(channelNumberGrants('api_runtime', true), /INSERT|UPDATE|DELETE|TRUNCATE/);
  assert.equal(
    channelNumberGrants('api_runtime', false),
    `REVOKE ALL ON ${tables} FROM api_runtime;\nREVOKE ALL ON FUNCTION ${functions} FROM api_runtime;`,
  );
  for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
    assert.throws(() => channelNumberGrants(role, true));
  for (const enabled of [undefined, null, 'true', 1])
    assert.throws(() => channelNumberGrants('api', enabled));
});
