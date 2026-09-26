-- Commercial loyalty only. No TEST order/actor references and no active defaults.
CREATE TABLE loyalty_programs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 version integer NOT NULL CHECK(version>0), rules jsonb NOT NULL,
 approval_reference text NOT NULL, reason text NOT NULL, approved_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,version), UNIQUE(id,organization_id)
);
CREATE TABLE loyalty_activations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 program_id uuid NOT NULL, actor_id uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(program_id,organization_id) REFERENCES loyalty_programs(id,organization_id)
);
CREATE TABLE loyalty_active_programs (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id), program_id uuid NOT NULL,
 FOREIGN KEY(program_id,organization_id) REFERENCES loyalty_programs(id,organization_id)
);
CREATE TABLE loyalty_wallets (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 customer_id uuid NOT NULL REFERENCES identity_customers(id),
 balance_points bigint NOT NULL DEFAULT 0 CHECK(abs(balance_points)<=9000000000000000),
 reserved_points bigint NOT NULL DEFAULT 0 CHECK(reserved_points BETWEEN 0 AND 9000000000000000),
 debt_points bigint NOT NULL DEFAULT 0 CHECK(debt_points BETWEEN 0 AND 9000000000000000),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 UNIQUE(organization_id,customer_id), UNIQUE(id,organization_id)
);
CREATE TABLE loyalty_commands (
 organization_id uuid NOT NULL REFERENCES organizations(id), command_key uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,command_key)
);
CREATE TABLE loyalty_order_refs (
 order_id uuid NOT NULL, organization_id uuid NOT NULL, branch_id uuid NOT NULL,
 wallet_id uuid NOT NULL, program_id uuid NOT NULL,
 PRIMARY KEY(organization_id,order_id), UNIQUE(organization_id,order_id,wallet_id,program_id),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(wallet_id,organization_id) REFERENCES loyalty_wallets(id,organization_id),
 FOREIGN KEY(program_id,organization_id) REFERENCES loyalty_programs(id,organization_id)
);
CREATE TABLE loyalty_ledger (
 id uuid PRIMARY KEY, wallet_id uuid NOT NULL, organization_id uuid NOT NULL,
 delta_points bigint NOT NULL CHECK(delta_points<>0 AND abs(delta_points)<=9000000000000000),
 kind text NOT NULL CHECK(kind IN ('earn','redeem','restore','expire','clawback','adjust')),
 reference_id uuid NOT NULL, actor_id uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(wallet_id,organization_id) REFERENCES loyalty_wallets(id,organization_id)
);
CREATE INDEX loyalty_ledger_wallet ON loyalty_ledger(wallet_id,created_at,id);
CREATE TABLE loyalty_lots (
 id uuid PRIMARY KEY, wallet_id uuid NOT NULL, organization_id uuid NOT NULL, program_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 source_kind text NOT NULL CHECK(source_kind IN ('earn','restore','adjust')), source_id uuid NOT NULL,
 initial_points bigint NOT NULL CHECK(initial_points>0 AND initial_points<=9000000000000000),
 remaining_points bigint NOT NULL CHECK(remaining_points>=0),
 held_points bigint NOT NULL DEFAULT 0 CHECK(held_points>=0 AND held_points<=remaining_points),
 pending_revocation_points bigint NOT NULL DEFAULT 0 CHECK(pending_revocation_points BETWEEN 0 AND held_points),
 redeemed_points bigint NOT NULL DEFAULT 0 CHECK(redeemed_points>=0),
 expired_points bigint NOT NULL DEFAULT 0 CHECK(expired_points>=0),
 revoked_points bigint NOT NULL DEFAULT 0 CHECK(revoked_points>=0),
 debt_settled_points bigint NOT NULL DEFAULT 0 CHECK(debt_settled_points>=0),
 clawed_back_points bigint NOT NULL DEFAULT 0 CHECK(clawed_back_points BETWEEN 0 AND initial_points),
 expired_refund_offset_points bigint NOT NULL DEFAULT 0 CHECK(expired_refund_offset_points BETWEEN 0 AND expired_points),
 expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(initial_points=remaining_points+redeemed_points+expired_points+revoked_points+debt_settled_points),
 UNIQUE(id,wallet_id), UNIQUE(organization_id,source_kind,source_id),
 FOREIGN KEY(wallet_id,organization_id) REFERENCES loyalty_wallets(id,organization_id),
 FOREIGN KEY(program_id,organization_id) REFERENCES loyalty_programs(id,organization_id)
);
CREATE INDEX loyalty_lots_open ON loyalty_lots(wallet_id,sequence) WHERE remaining_points>0;
CREATE INDEX loyalty_lots_expiring ON loyalty_lots(expires_at,wallet_id) WHERE remaining_points>held_points;
CREATE TABLE loyalty_holds (
 id uuid PRIMARY KEY, wallet_id uuid NOT NULL, organization_id uuid NOT NULL,
 order_id uuid NOT NULL, program_id uuid NOT NULL,
 points bigint NOT NULL CHECK(points>0), eligible_minor bigint NOT NULL CHECK(eligible_minor>0),
 state text NOT NULL CHECK(state IN ('held','released','captured')),
 capture_id uuid, resolution_id uuid, resolution_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,order_id), UNIQUE(id,wallet_id), UNIQUE(organization_id,capture_id),
 FOREIGN KEY(wallet_id,organization_id) REFERENCES loyalty_wallets(id,organization_id),
 FOREIGN KEY(organization_id,order_id,wallet_id,program_id) REFERENCES loyalty_order_refs(organization_id,order_id,wallet_id,program_id),
 CHECK((state='held' AND capture_id IS NULL AND resolution_id IS NULL) OR
 (state='captured' AND capture_id IS NOT NULL AND resolution_id IS NULL) OR
 (state='released' AND resolution_id IS NOT NULL AND capture_id IS NULL))
);
CREATE TABLE loyalty_allocations (
 hold_id uuid NOT NULL, lot_id uuid NOT NULL, wallet_id uuid NOT NULL,
 points bigint NOT NULL CHECK(points>0), PRIMARY KEY(hold_id,lot_id),
 FOREIGN KEY(hold_id,wallet_id) REFERENCES loyalty_holds(id,wallet_id),
 FOREIGN KEY(lot_id,wallet_id) REFERENCES loyalty_lots(id,wallet_id)
);
CREATE TABLE loyalty_rewards (
 organization_id uuid NOT NULL, order_id uuid NOT NULL, wallet_id uuid NOT NULL, program_id uuid NOT NULL,
 original_minor bigint NOT NULL CHECK(original_minor BETWEEN 0 AND 9000000000000000),
 refunded_minor bigint NOT NULL DEFAULT 0 CHECK(refunded_minor BETWEEN 0 AND original_minor),
 fulfillment_event_id uuid, initial_awarded_points bigint NOT NULL DEFAULT 0 CHECK(initial_awarded_points>=0),
 lot_id uuid, PRIMARY KEY(organization_id,order_id),
 UNIQUE(organization_id,fulfillment_event_id),
 FOREIGN KEY(organization_id,order_id,wallet_id,program_id) REFERENCES loyalty_order_refs(organization_id,order_id,wallet_id,program_id),
 FOREIGN KEY(lot_id,wallet_id) REFERENCES loyalty_lots(id,wallet_id)
);
CREATE TABLE loyalty_earned_refunds (
 organization_id uuid NOT NULL, source_refund_id uuid NOT NULL, order_id uuid NOT NULL,
 wallet_id uuid NOT NULL, eligible_minor bigint NOT NULL CHECK(eligible_minor>0),
 PRIMARY KEY(organization_id,source_refund_id),
 FOREIGN KEY(organization_id,order_id) REFERENCES loyalty_rewards(organization_id,order_id),
 FOREIGN KEY(wallet_id,organization_id) REFERENCES loyalty_wallets(id,organization_id)
);
CREATE TABLE loyalty_redemption_refunds (
 organization_id uuid NOT NULL, source_refund_id uuid NOT NULL, hold_id uuid NOT NULL,
 wallet_id uuid NOT NULL, points bigint NOT NULL CHECK(points>0),
 PRIMARY KEY(organization_id,source_refund_id),
 FOREIGN KEY(hold_id,wallet_id) REFERENCES loyalty_holds(id,wallet_id),
 FOREIGN KEY(wallet_id,organization_id) REFERENCES loyalty_wallets(id,organization_id)
);
CREATE TABLE loyalty_refund_applications (
 organization_id uuid NOT NULL, source_refund_id uuid NOT NULL, lot_id uuid NOT NULL,
 PRIMARY KEY(organization_id,source_refund_id),
 FOREIGN KEY(organization_id,source_refund_id) REFERENCES loyalty_redemption_refunds(organization_id,source_refund_id),
 FOREIGN KEY(lot_id) REFERENCES loyalty_lots(id)
);
CREATE TABLE loyalty_movements (
 id uuid PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES loyalty_wallets(id),
 lot_id uuid NOT NULL, kind text NOT NULL, points bigint NOT NULL CHECK(points>0),
 reference_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(lot_id,wallet_id) REFERENCES loyalty_lots(id,wallet_id)
);
CREATE FUNCTION loyalty_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'loyalty audit records are immutable'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loyalty_programs','loyalty_activations','loyalty_commands','loyalty_order_refs','loyalty_ledger','loyalty_allocations','loyalty_earned_refunds','loyalty_redemption_refunds','loyalty_refund_applications','loyalty_movements'] LOOP
 EXECUTE format('CREATE TRIGGER loyalty_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION loyalty_immutable()',t);
 END LOOP;
END $$;
CREATE FUNCTION loyalty_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'loyalty projections cannot be deleted'; END IF;
 IF TG_TABLE_NAME='loyalty_wallets' THEN IF (NEW.id,NEW.organization_id,NEW.customer_id) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.customer_id) THEN RAISE EXCEPTION 'immutable wallet identity'; END IF; END IF;
 IF TG_TABLE_NAME='loyalty_lots' THEN IF (NEW.id,NEW.wallet_id,NEW.organization_id,NEW.program_id,NEW.sequence,NEW.source_kind,NEW.source_id,NEW.initial_points,NEW.expires_at,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.wallet_id,OLD.organization_id,OLD.program_id,OLD.sequence,OLD.source_kind,OLD.source_id,OLD.initial_points,OLD.expires_at,OLD.created_at) THEN RAISE EXCEPTION 'immutable lot identity'; END IF; END IF;
 IF TG_TABLE_NAME='loyalty_holds' THEN
  IF (NEW.id,NEW.wallet_id,NEW.organization_id,NEW.order_id,NEW.program_id,NEW.points,NEW.eligible_minor,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.wallet_id,OLD.organization_id,OLD.order_id,OLD.program_id,OLD.points,OLD.eligible_minor,OLD.created_at) OR OLD.state<>'held' THEN RAISE EXCEPTION 'immutable hold identity or terminal state'; END IF;
 END IF;
 IF TG_TABLE_NAME='loyalty_rewards' THEN IF ((NEW.organization_id,NEW.order_id,NEW.wallet_id,NEW.program_id,NEW.original_minor) IS DISTINCT FROM (OLD.organization_id,OLD.order_id,OLD.wallet_id,OLD.program_id,OLD.original_minor) OR NEW.refunded_minor<OLD.refunded_minor OR (OLD.fulfillment_event_id IS NOT NULL AND (NEW.fulfillment_event_id,NEW.initial_awarded_points,NEW.lot_id) IS DISTINCT FROM (OLD.fulfillment_event_id,OLD.initial_awarded_points,OLD.lot_id))) THEN RAISE EXCEPTION 'immutable reward identity'; END IF; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loyalty_wallets','loyalty_lots','loyalty_holds','loyalty_rewards'] LOOP
 EXECUTE format('CREATE TRIGGER loyalty_projection_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION loyalty_projection_guard()',t);
 END LOOP;
END $$;
-- Deferred checks use final transaction state; wallet locks serialize library writers.
CREATE FUNCTION loyalty_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; b bigint; r bigint; d bigint; BEGIN
 IF TG_TABLE_NAME='loyalty_wallets' THEN w=NEW.id; ELSE w=NEW.wallet_id; END IF;
 SELECT balance_points,reserved_points,debt_points INTO b,r,d FROM loyalty_wallets WHERE id=w;
 IF b<>(SELECT coalesce(sum(delta_points),0) FROM loyalty_ledger WHERE wallet_id=w)
 OR r<>(SELECT coalesce(sum(points),0) FROM loyalty_holds WHERE wallet_id=w AND state='held')
 OR b<>(SELECT coalesce(sum(remaining_points-pending_revocation_points),0)-d FROM loyalty_lots WHERE wallet_id=w)
 OR EXISTS(SELECT 1 FROM loyalty_lots l WHERE l.wallet_id=w AND l.held_points<>(SELECT coalesce(sum(a.points),0) FROM loyalty_allocations a JOIN loyalty_holds h ON h.id=a.hold_id WHERE a.lot_id=l.id AND h.state='held'))
 OR EXISTS(SELECT 1 FROM loyalty_holds h WHERE h.wallet_id=w AND h.points<>(SELECT coalesce(sum(a.points),0) FROM loyalty_allocations a WHERE a.hold_id=h.id))
 THEN RAISE EXCEPTION 'loyalty balance invariant failed'; END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loyalty_wallets','loyalty_ledger','loyalty_lots','loyalty_holds','loyalty_allocations'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER loyalty_balance_invariant AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loyalty_check_balance()',t);
 END LOOP;
END $$;

CREATE INDEX loyalty_lots_wallet ON loyalty_lots(wallet_id);
CREATE INDEX loyalty_holds_wallet ON loyalty_holds(wallet_id,state);
CREATE INDEX loyalty_allocations_lot ON loyalty_allocations(lot_id);
CREATE INDEX loyalty_redemption_refunds_hold ON loyalty_redemption_refunds(hold_id);
CREATE INDEX loyalty_movements_wallet ON loyalty_movements(wallet_id,created_at,id);
