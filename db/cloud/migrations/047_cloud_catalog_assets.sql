-- Uploaded catalog photos. Bytes live in PostgreSQL so the pg_dump backup covers them and the
-- read-only API container needs no writable volume. Every row is content-addressed and
-- immutable: a new photo is a new asset, never an in-place change of a published one.
CREATE TABLE catalog_assets (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 -- SHA-256 of the canonical re-encoded hero WebP; identical uploads resolve to one asset.
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 -- SHA-256 of the uploaded bytes, kept for provenance only. The original is never stored.
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 40000000),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 40000000),
 uploaded_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id, sha256),
 UNIQUE(id, organization_id),
 FOREIGN KEY(uploaded_by, organization_id) REFERENCES catalog_managers(id, organization_id)
);
CREATE INDEX catalog_assets_org_created_idx ON catalog_assets(organization_id, created_at DESC, id);
-- Re-encoded, metadata-free WebP renditions. The file name of each is its own SHA-256, which
-- the database re-derives from the bytes, so a served file always matches its URL.
CREATE TABLE catalog_asset_variants (
 asset_id uuid NOT NULL REFERENCES catalog_assets(id),
 variant text NOT NULL CHECK(variant IN ('card','hero','thumb')),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 mime text NOT NULL DEFAULT 'image/webp' CHECK(mime = 'image/webp'),
 width integer NOT NULL CHECK(width > 0),
 height integer NOT NULL CHECK(height > 0),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 16 AND 1500000),
 PRIMARY KEY(asset_id, variant),
 CHECK(encode(sha256(bytes), 'hex') = sha256),
 CHECK(substring(bytes FROM 1 FOR 4) = decode('52494646', 'hex')
   AND substring(bytes FROM 9 FOR 4) = decode('57454250', 'hex')),
 CHECK(greatest(width, height) <= CASE variant WHEN 'card' THEN 640 WHEN 'hero' THEN 1280 ELSE 240 END)
);
-- Not unique: a small source yields identical bytes for several variants, and two
-- organisations may upload the same photo. Identical hashes always mean identical bytes.
CREATE INDEX catalog_asset_variants_sha_idx ON catalog_asset_variants(sha256);
-- Append-only upload log: who added which photo from which branch editor. It also backs the
-- per-actor upload rate limit. catalog_audit is tied to draft revisions and cannot hold it.
CREATE TABLE catalog_asset_audit (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 asset_id uuid NOT NULL,
 request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('uploaded','reused')),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id, request_id),
 FOREIGN KEY(branch_id, organization_id) REFERENCES branches(id, organization_id),
 FOREIGN KEY(actor_id, organization_id) REFERENCES catalog_managers(id, organization_id),
 FOREIGN KEY(asset_id, organization_id) REFERENCES catalog_assets(id, organization_id)
);
CREATE INDEX catalog_asset_audit_actor_time_idx ON catalog_asset_audit(actor_id, occurred_at DESC);
CREATE TRIGGER catalog_assets_immutable BEFORE UPDATE OR DELETE ON catalog_assets
 FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
CREATE TRIGGER catalog_asset_variants_immutable BEFORE UPDATE OR DELETE ON catalog_asset_variants
 FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
CREATE TRIGGER catalog_asset_audit_immutable BEFORE UPDATE OR DELETE ON catalog_asset_audit
 FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
