/**
 * Uploaded catalog photos (cloud049). Reading is always granted: the public and edge media
 * routes and the storefront media map serve existing renditions. Writing is append-only and
 * only while the catalog editor and CATALOG_MEDIA_UPLOAD_ENABLED are both on; rows are never
 * updated or deleted (catalog_reject_mutation triggers back this up).
 */
export function catalogAssetGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid catalog asset grant configuration');
  return (
    `REVOKE ALL ON catalog_assets, catalog_asset_variants, catalog_asset_audit FROM ${role};
    GRANT SELECT ON catalog_assets, catalog_asset_variants TO ${role};` +
    (enabled
      ? `
    GRANT INSERT ON catalog_assets, catalog_asset_variants TO ${role};
    GRANT SELECT, INSERT ON catalog_asset_audit TO ${role};`
      : '')
  );
}
