-- Unified-menu apply v2. Adds a content-addressed media cache and one durable
-- apply result per delivered menu release. Existing tables are unchanged.

-- Card photos the cashier POS loads offline through the edge. The key is the
-- SHA-256 of the exact bytes, enforced here as well as by the downloader.
CREATE TABLE menu_media (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime text NOT NULL CHECK (mime IN ('image/webp')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1500000),
  fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (encode(sha256(bytes), 'hex') = sha256)
);
CREATE TRIGGER menu_media_immutable BEFORE UPDATE OR DELETE ON menu_media
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();

-- Applied or rejected outcome of each delivered release. A rejected release
-- advances the menu cursor only; the active menu and routing stay unchanged.
CREATE TABLE menu_apply_results (
  release_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  event_id uuid NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version > 0),
  result text NOT NULL CHECK (result IN ('applied', 'rejected')),
  reason text CHECK (
    reason IN ('ROUTING_UNRESOLVED', 'VERSION_NOT_NEWER', 'MEDIA_UNAVAILABLE', 'INVALID_MENU')
  ),
  routing_version integer CHECK (routing_version > 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((result = 'rejected') = (reason IS NOT NULL)),
  CHECK (result = 'applied' OR routing_version IS NULL)
);
CREATE TRIGGER menu_apply_results_immutable BEFORE UPDATE OR DELETE ON menu_apply_results
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();
