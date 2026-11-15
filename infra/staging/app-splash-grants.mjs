/**
 * Cloud schema078 (video of the app storefront, owner request 15.11.2026): rights of the shared
 * API role on the 078 relations, with BACKOFFICE_ENABLED and BACKOFFICE_APP_SPLASH_ENABLED on.
 *
 * - app_splash_videos: SELECT, INSERT (a video is never changed; a new one is a new row).
 * - app_splash_uploads, app_splash_upload_parts: SELECT, INSERT, DELETE (parts of an upload in
 *   progress; deleted once the video is assembled or the upload is abandoned).
 * - app_splash_settings: SELECT, INSERT (append-only, refused by its trigger).
 *
 * The SQL is a reset of the 078 relations only (revoke all, then grant the enabled set); with a
 * flag off it only revokes; on a database without 078 it is a no-op (to_regclass guards).
 */
export const MIGRATION = '078_cloud_app_splash.sql';
export const APP_SPLASH_RELATIONS = Object.freeze([
  'app_splash_videos',
  'app_splash_uploads',
  'app_splash_upload_parts',
  'app_splash_settings',
]);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Exact rights of the shared API role on the 078 relations. */
export function appSplashPrivileges(input) {
  if (!input || typeof input.backoffice !== 'boolean' || typeof input.splash !== 'boolean')
    throw new Error('Invalid app splash grants');
  if (!input.backoffice || !input.splash) return Object.freeze({});
  return Object.freeze({
    app_splash_videos: ['SELECT', 'INSERT'],
    app_splash_uploads: ['SELECT', 'INSERT', 'DELETE'],
    app_splash_upload_parts: ['SELECT', 'INSERT', 'DELETE'],
    app_splash_settings: ['SELECT', 'INSERT'],
  });
}

/** Reset SQL for `role` on the 078 relations (module comment). */
export function appSplashGrants(role, input, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema)) throw new Error('Invalid app splash grants');
  const privileges = appSplashPrivileges(input);
  const relation = (name) => `"${schema}"."${name}"`;
  const reset = APP_SPLASH_RELATIONS.map(
    (name) =>
      `IF to_regclass('${schema}.${name}') IS NOT NULL THEN ` +
      `REVOKE ALL ON ${relation(name)} FROM "${role}";` +
      (privileges[name]
        ? `GRANT ${privileges[name].join(', ')} ON ${relation(name)} TO "${role}";`
        : '') +
      ' END IF;',
  ).join(' ');
  return `DO $app_splash$ BEGIN ${reset} END $app_splash$;`;
}
