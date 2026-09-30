-- Additive neutral catalog. No TEST menu, ordering flag, money or edge activation is changed.
CREATE UNIQUE INDEX branches_catalog_org_identity_idx ON branches(id, organization_id);
CREATE TABLE catalog_managers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(id, organization_id)
);
CREATE TABLE catalog_manager_branches (
  actor_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY(actor_id, branch_id),
  FOREIGN KEY(actor_id,organization_id) REFERENCES catalog_managers(id,organization_id),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id)
);
CREATE TABLE catalog_draft_versions (
  branch_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  base_version integer CHECK (base_version>0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND payload ?& ARRAY['schema_version','currency','content_reviewed','products','categories'] AND jsonb_typeof(payload->'products')='array' AND jsonb_typeof(payload->'categories')='array' AND jsonb_typeof(payload->'content_reviewed')='boolean' AND payload->>'schema_version'='1' AND payload->>'currency'='KZT' AND NOT(payload ? 'synthetic')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(branch_id,revision),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
  FOREIGN KEY(actor_id,organization_id) REFERENCES catalog_managers(id,organization_id)
);
CREATE TABLE catalog_publications (
  branch_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  source_revision integer NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND payload ?& ARRAY['schema_version','currency','content_reviewed','products','categories'] AND jsonb_typeof(payload->'products')='array' AND jsonb_typeof(payload->'categories')='array' AND jsonb_typeof(payload->'content_reviewed')='boolean' AND payload->>'schema_version'='1' AND payload->>'currency'='KZT' AND payload->>'content_reviewed'='true' AND NOT(payload ? 'synthetic')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(branch_id,version),
  FOREIGN KEY(branch_id,source_revision) REFERENCES catalog_draft_versions(branch_id,revision),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
  FOREIGN KEY(actor_id,organization_id) REFERENCES catalog_managers(id,organization_id)
);
ALTER TABLE catalog_draft_versions ADD CONSTRAINT catalog_draft_base_version_fk FOREIGN KEY(branch_id,base_version) REFERENCES catalog_publications(branch_id,version);
CREATE TABLE catalog_branch_heads (
  branch_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  draft_revision integer CHECK(draft_revision>0),
  published_version integer CHECK(published_version>0),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
  FOREIGN KEY(branch_id,draft_revision) REFERENCES catalog_draft_versions(branch_id,revision),
  FOREIGN KEY(branch_id,published_version) REFERENCES catalog_publications(branch_id,version)
);
CREATE TABLE catalog_audit (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('seeded','saved','published')),
  from_revision integer NOT NULL CHECK(from_revision>=0),
  to_revision integer NOT NULL CHECK(to_revision>from_revision),
  published_version integer CHECK(published_version>0),
  before_hash text CHECK(before_hash ~ '^[a-f0-9]{64}$'),
  after_hash text NOT NULL CHECK(after_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
  FOREIGN KEY(actor_id,organization_id) REFERENCES catalog_managers(id,organization_id),
  FOREIGN KEY(branch_id,to_revision) REFERENCES catalog_draft_versions(branch_id,revision)
);
CREATE INDEX catalog_audit_branch_time_idx ON catalog_audit(branch_id,occurred_at DESC,id);
CREATE TABLE catalog_command_receipts (
  actor_id uuid NOT NULL REFERENCES catalog_managers(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE catalog_manager_audit (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES catalog_managers(id),
  action text NOT NULL CHECK(action IN ('provisioned','revoked')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION catalog_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Catalog history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER catalog_drafts_immutable BEFORE UPDATE OR DELETE ON catalog_draft_versions FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
CREATE TRIGGER catalog_publications_immutable BEFORE UPDATE OR DELETE ON catalog_publications FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
CREATE TRIGGER catalog_audit_immutable BEFORE UPDATE OR DELETE ON catalog_audit FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
CREATE TRIGGER catalog_receipts_immutable BEFORE UPDATE OR DELETE ON catalog_command_receipts FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
CREATE TRIGGER catalog_manager_audit_immutable BEFORE UPDATE OR DELETE ON catalog_manager_audit FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
CREATE FUNCTION catalog_check_publication_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM catalog_draft_versions d WHERE d.branch_id=NEW.branch_id AND d.revision=NEW.source_revision AND d.organization_id=NEW.organization_id AND d.payload=NEW.payload AND d.payload_hash=NEW.payload_hash) THEN
    RAISE EXCEPTION 'Publication differs from its source draft' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_publication_source BEFORE INSERT ON catalog_publications FOR EACH ROW EXECUTE FUNCTION catalog_check_publication_source();
