import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_SPLASH_RELATIONS,
  appSplashGrants,
  appSplashPrivileges,
} from '../../infra/staging/app-splash-grants.mjs';

test('app splash grants: exact rights with both flags, revoke-only otherwise', () => {
  assert.deepEqual(appSplashPrivileges({ backoffice: true, splash: false }), {});
  assert.deepEqual(appSplashPrivileges({ backoffice: false, splash: true }), {});
  const on = appSplashPrivileges({ backoffice: true, splash: true });
  assert.deepEqual(Object.keys(on).sort(), [...APP_SPLASH_RELATIONS].sort());
  assert.deepEqual(on.app_splash_settings, ['SELECT', 'INSERT']);
  assert.equal(on.app_splash_videos.includes('UPDATE'), false);
  const sql = appSplashGrants('pickchick_api', { backoffice: true, splash: true });
  for (const name of APP_SPLASH_RELATIONS) {
    assert.match(sql, new RegExp(`REVOKE ALL ON "public"."${name}" FROM "pickchick_api"`));
    assert.match(sql, new RegExp(`to_regclass\\('public.${name}'\\)`));
  }
  assert.doesNotMatch(
    appSplashGrants('pickchick_api', { backoffice: true, splash: false }),
    /GRANT/,
  );
  assert.throws(() => appSplashGrants('bad role', { backoffice: true, splash: true }));
  assert.throws(() => appSplashPrivileges({ backoffice: 'yes', splash: true }));
});
