-- Branch-scoped operational documents. Existing commerce/edge owners are retained.
CREATE TABLE bo_records (
 id uuid NOT NULL,
 branch_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('ingredient','recipe','promo','game','campaign','ticket','review','station','employee','shift')),
 revision integer NOT NULL CHECK(revision>0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,kind,id),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id)
);
CREATE TABLE bo_audit (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 request_id uuid NOT NULL,
 action text NOT NULL,
 entity_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 before_value jsonb,
 after_value jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id)
);
CREATE INDEX bo_audit_branch_idx ON bo_audit(branch_id,created_at DESC,id);
CREATE TABLE bo_commands (
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 request_id uuid NOT NULL,
 branch_id uuid NOT NULL REFERENCES branches(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE bo_stock_balances (
 branch_id uuid NOT NULL REFERENCES branches(id),
 ingredient_id uuid NOT NULL,
 ingredient_kind text NOT NULL DEFAULT 'ingredient' CHECK(ingredient_kind='ingredient'),
 quantity bigint NOT NULL DEFAULT 0 CHECK(quantity>=0),
 value_minor bigint NOT NULL DEFAULT 0 CHECK(value_minor>=0),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 PRIMARY KEY(branch_id,ingredient_id),
 FOREIGN KEY(branch_id,ingredient_kind,ingredient_id) REFERENCES bo_records(branch_id,kind,id),
 CHECK(quantity<>0 OR value_minor=0)
);
CREATE TABLE bo_stock_documents (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 kind text NOT NULL CHECK(kind IN ('receipt','waste','count','production','consumption','transfer')),
 reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 order_id uuid REFERENCES commerce_orders(id),
 recipe_snapshot jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,branch_id)
);
CREATE UNIQUE INDEX bo_consumption_order_idx ON bo_stock_documents(order_id) WHERE kind='consumption';
CREATE TABLE bo_stock_movements (
 document_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 ingredient_id uuid NOT NULL,
 quantity_delta bigint NOT NULL,
 value_delta_minor bigint NOT NULL,
 balance_after bigint NOT NULL CHECK(balance_after>=0),
 value_after_minor bigint NOT NULL CHECK(value_after_minor>=0),
 PRIMARY KEY(document_id,ingredient_id),
 FOREIGN KEY(document_id,branch_id) REFERENCES bo_stock_documents(id,branch_id),
 FOREIGN KEY(branch_id,ingredient_id) REFERENCES bo_stock_balances(branch_id,ingredient_id)
);
CREATE TABLE bo_publications (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 record_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('promo','game','station')),
 revision integer NOT NULL,
 payload jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,kind,record_id) REFERENCES bo_records(branch_id,kind,id),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 UNIQUE(branch_id,kind,record_id,revision)
);
-- A publication is not an acknowledgement from a device or a push provider.
CREATE TABLE bo_delivery_outbox (
 id uuid PRIMARY KEY REFERENCES bo_publications(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 kind text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER bo_audit_immutable BEFORE UPDATE OR DELETE ON bo_audit FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_commands_immutable BEFORE UPDATE OR DELETE ON bo_commands FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_documents_immutable BEFORE UPDATE OR DELETE ON bo_stock_documents FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_movements_immutable BEFORE UPDATE OR DELETE ON bo_stock_movements FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_publications_immutable BEFORE UPDATE OR DELETE ON bo_publications FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_delivery_immutable BEFORE UPDATE OR DELETE ON bo_delivery_outbox FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TABLE bo_access_grants (
 actor_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('manager','analyst')),
 PRIMARY KEY(actor_id,branch_id),
 FOREIGN KEY(actor_id,branch_id) REFERENCES catalog_manager_branches(actor_id,branch_id)
);
CREATE UNIQUE INDEX bo_menu_recipe_product ON bo_records(branch_id,(payload->>'product_id')) WHERE kind='recipe' AND payload->>'output_ingredient_id' IS NULL;
CREATE TABLE bo_order_recipes (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 snapshot jsonb NOT NULL,
 pinned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION bo_pin_order_recipes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO bo_order_recipes(order_id,branch_id,snapshot)
 SELECT NEW.id,NEW.branch_id,coalesce(jsonb_agg(jsonb_build_object('product_id',l->>'productId','quantity',l->'quantity','recipe_id',r.id,'revision',r.revision,'recipe',r.payload,'selected_details',l->'selectedDetails')),'[]'::jsonb)
 FROM jsonb_array_elements(NEW.snapshot->'lines') l
 LEFT JOIN bo_records r ON r.branch_id=NEW.branch_id AND r.kind='recipe' AND r.payload->>'product_id'=l->>'productId' AND r.payload->>'output_ingredient_id' IS NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER bo_order_recipe_pin AFTER INSERT ON commerce_orders FOR EACH ROW EXECUTE FUNCTION bo_pin_order_recipes();
CREATE TRIGGER bo_order_recipes_immutable BEFORE UPDATE OR DELETE ON bo_order_recipes FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE UNIQUE INDEX bo_game_template_idx ON bo_records(branch_id,(payload->>'template')) WHERE kind='game';
ALTER TABLE bo_access_grants ADD COLUMN lock_anchor boolean NOT NULL DEFAULT true CHECK(lock_anchor);
CREATE TABLE bo_access_audit (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 previous_role text,
 role text NOT NULL,
 source text NOT NULL DEFAULT 'trusted_local_setup' CHECK(source='trusted_local_setup'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER bo_access_audit_immutable BEFORE UPDATE OR DELETE ON bo_access_audit FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
