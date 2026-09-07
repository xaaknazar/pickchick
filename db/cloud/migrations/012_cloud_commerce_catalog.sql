-- Published catalog quotes coexist with legacy foundation menu-release quotes.
-- PostgreSQL FOR SHARE requires UPDATE on some column; this grants no ability
-- to publish or edit the head when runtime has UPDATE(lock_anchor) only.
ALTER TABLE catalog_branch_heads ADD COLUMN lock_anchor boolean NOT NULL DEFAULT true CHECK(lock_anchor IS TRUE);
CREATE UNIQUE INDEX catalog_publication_commerce_ref_idx
 ON catalog_publications(branch_id,version,organization_id,payload_hash);
ALTER TABLE commerce_quotes ALTER COLUMN release_id DROP NOT NULL;
ALTER TABLE commerce_quotes
 ADD COLUMN catalog_version integer,
 ADD COLUMN catalog_payload_hash text,
 ADD COLUMN catalog_published_at timestamptz,
 ADD CONSTRAINT commerce_quote_catalog_fk
 FOREIGN KEY(branch_id,catalog_version,organization_id,catalog_payload_hash)
 REFERENCES catalog_publications(branch_id,version,organization_id,payload_hash),
 ADD CONSTRAINT commerce_quote_single_catalog_source CHECK (
  (release_id IS NOT NULL AND catalog_version IS NULL AND catalog_payload_hash IS NULL AND catalog_published_at IS NULL AND NOT(snapshot ? 'catalogReference'))
  OR (release_id IS NULL AND catalog_version IS NOT NULL AND catalog_payload_hash IS NOT NULL AND catalog_published_at IS NOT NULL AND NOT(snapshot ? 'releaseId'))
 ),
 ADD CONSTRAINT commerce_quote_catalog_snapshot CHECK (
  catalog_version IS NULL OR (
   snapshot->'catalogReference'->>'organizationId'=organization_id::text
   AND snapshot->'catalogReference'->>'branchId'=branch_id::text
   AND snapshot->'catalogReference'->>'version'=catalog_version::text
   AND snapshot->'catalogReference'->>'payloadHash'=catalog_payload_hash
   AND (snapshot->'catalogReference'->>'publishedAt')::timestamptz=catalog_published_at
   AND (snapshot->>'ttlSeconds')::integer BETWEEN 1 AND 300
   AND expires_at=created_at+(snapshot->>'ttlSeconds')::integer*interval '1 second'
  ) IS TRUE
 );

-- JSON dates have millisecond precision; PostgreSQL publications retain microseconds.
CREATE FUNCTION commerce_check_catalog_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_version integer;
BEGIN
 IF NEW.catalog_version IS NOT NULL THEN
  SELECT published_version INTO current_version FROM catalog_branch_heads
   WHERE branch_id=NEW.branch_id AND organization_id=NEW.organization_id FOR SHARE;
  IF current_version IS DISTINCT FROM NEW.catalog_version THEN
   RAISE EXCEPTION 'New quote requires current publication' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.catalog_version IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM catalog_publications p WHERE p.branch_id=NEW.branch_id
  AND p.organization_id=NEW.organization_id AND p.version=NEW.catalog_version
  AND p.payload_hash=NEW.catalog_payload_hash
  AND date_trunc('milliseconds',p.published_at)=NEW.catalog_published_at
 ) THEN RAISE EXCEPTION 'Published catalog reference mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.catalog_version IS NOT NULL THEN
  IF jsonb_typeof(NEW.snapshot->'taxBinding') IS DISTINCT FROM 'object'
   OR NOT EXISTS(SELECT 1 FROM branches b WHERE b.id=NEW.branch_id AND b.organization_id=NEW.organization_id
     AND b.legal_entity_id::text=NEW.snapshot->'taxBinding'->>'legalEntityId')
   OR coalesce(length(btrim(NEW.snapshot->'taxBinding'->>'approvalReference')),0)<3
   OR coalesce((NEW.snapshot->'taxBinding'->>'version')::integer,0)<1
   OR jsonb_typeof(NEW.snapshot->'lines') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Approved tax binding required' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(NEW.snapshot->'lines')=0 OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'lines') line
   WHERE jsonb_typeof(line->'taxCode') IS DISTINCT FROM 'string' OR coalesce(length(btrim(line->>'taxCode')),0)=0
  ) THEN RAISE EXCEPTION 'Tax code required on every line' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_catalog_quote_reference BEFORE INSERT ON commerce_quotes
 FOR EACH ROW EXECUTE FUNCTION commerce_check_catalog_quote();
