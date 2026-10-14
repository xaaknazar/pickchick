-- Inventory is distinct from an authenticated device and never grants access.
CREATE TABLE device_inventory (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  kind text NOT NULL CHECK (kind IN ('registered','usb_tv')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  location text NOT NULL CHECK (length(location)<=120),
  notes text NOT NULL CHECK (length(notes)<=500),
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE device_inventory_commands (
  actor_id uuid NOT NULL REFERENCES catalog_managers(id),
  request_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid NOT NULL REFERENCES device_inventory(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  before_state jsonb,
  after_state jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,request_id)
);
CREATE FUNCTION device_inventory_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Device inventory audit is immutable'; END $$;
CREATE TRIGGER device_inventory_audit_immutable BEFORE UPDATE OR DELETE ON device_inventory_commands
  FOR EACH ROW EXECUTE FUNCTION device_inventory_audit_immutable();
CREATE TABLE device_presence (
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('edge','terminal','kiosk')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  app_version text CHECK (length(app_version)<=60),
  state text NOT NULL CHECK (state IN ('active','background')),
  issue text NOT NULL CHECK (issue IN ('none','connection','data','login','demo')),
  menu_version integer CHECK (menu_version>0),
  PRIMARY KEY(branch_id,device_id,source)
);
