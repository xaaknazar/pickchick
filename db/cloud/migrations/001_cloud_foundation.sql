CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  bin text NOT NULL CHECK (bin ~ '^[0-9]{12}$'),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, bin)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone text NOT NULL DEFAULT 'Asia/Almaty' CHECK (timezone = 'Asia/Almaty'),
  ordering_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (legal_entity_id, organization_id) REFERENCES legal_entities(id, organization_id),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, code)
);
CREATE INDEX branches_legal_entity_idx ON branches(legal_entity_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('edge', 'pos', 'kiosk', 'kitchen', 'display')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id),
  UNIQUE (id, branch_id)
);
CREATE INDEX devices_branch_idx ON devices(branch_id);

CREATE TABLE categories (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name_ru text NOT NULL CHECK (length(name_ru) > 0),
  name_kk text NOT NULL CHECK (length(name_kk) > 0),
  UNIQUE (id, organization_id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  category_id uuid NOT NULL,
  name_ru text NOT NULL CHECK (length(name_ru) > 0),
  name_kk text NOT NULL CHECK (length(name_kk) > 0),
  archived_at timestamptz,
  FOREIGN KEY (category_id, organization_id) REFERENCES categories(id, organization_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX products_category_idx ON products(category_id);

CREATE TABLE product_variants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid NOT NULL,
  sku text NOT NULL,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, sku)
);
CREATE INDEX product_variants_product_idx ON product_variants(product_id);

CREATE TABLE branch_prices (
  branch_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL DEFAULT 'KZT' CHECK (currency = 'KZT'),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id),
  FOREIGN KEY (variant_id, organization_id) REFERENCES product_variants(id, organization_id),
  PRIMARY KEY (branch_id, variant_id)
);
CREATE INDEX branch_prices_variant_idx ON branch_prices(variant_id);

CREATE TABLE menu_releases (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  version integer NOT NULL CHECK (version > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  published_at timestamptz NOT NULL,
  CHECK (payload ?& ARRAY['release_id', 'branch_id', 'schema_version', 'version', 'items']),
  CHECK (payload->>'release_id' = id::text AND payload->>'branch_id' = branch_id::text),
  CHECK ((payload->>'version')::integer = version),
  CHECK ((payload->>'schema_version')::integer = schema_version),
  CHECK (jsonb_typeof(payload->'items') = 'array'),
  UNIQUE (id, branch_id),
  UNIQUE (branch_id, version)
);

CREATE TABLE branch_menu_activations (
  branch_id uuid PRIMARY KEY REFERENCES branches(id),
  release_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  FOREIGN KEY (release_id, branch_id) REFERENCES menu_releases(id, branch_id)
);

CREATE FUNCTION reject_menu_release_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published menu releases are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER menu_releases_immutable BEFORE UPDATE OR DELETE ON menu_releases
FOR EACH ROW EXECUTE FUNCTION reject_menu_release_mutation();

CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY,
  producer_id uuid NOT NULL,
  producer_sequence bigint NOT NULL CHECK (producer_sequence > 0),
  branch_id uuid NOT NULL REFERENCES branches(id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (producer_id, producer_sequence),
  UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);
CREATE INDEX outbox_pending_idx ON outbox_events(next_attempt_at) WHERE acknowledged_at IS NULL;

CREATE TABLE inbox_messages (
  producer_id uuid NOT NULL,
  event_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (producer_id, event_id)
);
