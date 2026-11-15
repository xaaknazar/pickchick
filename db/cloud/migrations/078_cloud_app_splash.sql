-- Video of the mobile app storefront («заставка», owner request 15.11.2026). Until now the video
-- was bundled into the app; the back office uploads a new one and the app plays it instead of
-- the built-in one, falling back to the built-in video without network. Additive: new tables
-- only. Runtime access is granted by infra/staging/app-splash-grants.mjs behind
-- BACKOFFICE_APP_SPLASH_ENABLED (default off).

-- Uploaded videos of an organization, content-addressed. MP4 only (an ISO BMFF «ftyp» box first),
-- at most 25 MiB; the database re-derives the hash from the bytes.
CREATE TABLE app_splash_videos (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1024 AND 26214400),
 uploaded_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id, sha256),
 CHECK(encode(sha256(bytes), 'hex') = sha256),
 CHECK(substring(bytes FROM 5 FOR 4) = decode('66747970', 'hex')),
 FOREIGN KEY(uploaded_by, organization_id) REFERENCES catalog_managers(id, organization_id)
);
CREATE INDEX app_splash_videos_sha_idx ON app_splash_videos(sha256);

-- An upload in progress: the staff portal accepts at most 300 KB per request, so the browser
-- sends the file in parts of at most 256 KiB. Finished or abandoned uploads are deleted.
CREATE TABLE app_splash_uploads (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 uploaded_by uuid NOT NULL,
 total_bytes integer NOT NULL CHECK(total_bytes BETWEEN 1024 AND 26214400),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(uploaded_by, organization_id) REFERENCES catalog_managers(id, organization_id)
);
CREATE TABLE app_splash_upload_parts (
 upload_id uuid NOT NULL REFERENCES app_splash_uploads(id) ON DELETE CASCADE,
 part integer NOT NULL CHECK(part BETWEEN 0 AND 102),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 262144),
 PRIMARY KEY(upload_id, part)
);

-- Which video the app plays. Append-only: the latest row per organization is in force;
-- video_id NULL returns the built-in video.
CREATE TABLE app_splash_settings (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 video_id uuid NULL REFERENCES app_splash_videos(id),
 set_by uuid NOT NULL REFERENCES catalog_managers(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX app_splash_settings_org_idx ON app_splash_settings(organization_id, id DESC);
CREATE FUNCTION app_splash_settings_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app_splash_settings is append-only';
END $$;
CREATE TRIGGER app_splash_settings_append_only BEFORE UPDATE OR DELETE ON app_splash_settings
  FOR EACH ROW EXECUTE FUNCTION app_splash_settings_append_only();
