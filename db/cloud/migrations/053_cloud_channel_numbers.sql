-- Display numbers for cloud-owned channels (ADR-0014, docs/architecture/cloud-kitchen-channel.md,
-- section 3). Kiosk 300-599 and mobile 600-899; the cashier keeps 1-299 on the edge (edge 021,
-- later). Numbers wrap inside the channel range per branch and skip numbers still held by an
-- active order. The shift epoch changes only when the cashier's shift-open event reaches the cloud;
-- while the cashier is offline numbering simply continues. Nothing in production calls these
-- functions yet: the payment transaction wiring and the release trigger come in later stages.

-- Fixed, non-overlapping ranges. The CHECK pins the values so a bad row cannot overlap POS 1-299.
CREATE TABLE channel_number_ranges (
 channel text PRIMARY KEY CHECK(channel IN ('kiosk','mobile')),
 low integer NOT NULL,
 high integer NOT NULL,
 CHECK((channel='kiosk' AND low=300 AND high=599) OR (channel='mobile' AND low=600 AND high=899))
);
INSERT INTO channel_number_ranges(channel,low,high) VALUES('kiosk',300,599),('mobile',600,899);

-- Every cashier shift-open seen by the cloud, once per (branch, shift_key). Redelivery of the
-- same event, in any order, never resets numbering again.
CREATE TABLE channel_number_shifts (
 branch_id uuid NOT NULL REFERENCES branches(id),
 shift_key text NOT NULL CHECK(length(shift_key) BETWEEN 1 AND 200),
 epoch bigint NOT NULL CHECK(epoch > 0),
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,shift_key),
 UNIQUE(branch_id,epoch)
);

-- One counter row per branch and channel. last_number = low-1 means "next is low".
CREATE TABLE channel_number_counters (
 branch_id uuid NOT NULL REFERENCES branches(id),
 channel text NOT NULL REFERENCES channel_number_ranges(channel),
 shift_epoch bigint NOT NULL CHECK(shift_epoch >= 0),
 last_number integer NOT NULL CHECK(
  (channel='kiosk' AND last_number BETWEEN 299 AND 599) OR
  (channel='mobile' AND last_number BETWEEN 599 AND 899)),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,channel)
);

-- A number issued to an order. Active until released (handed over, cancelled); an active number
-- is never issued twice in a branch channel, across shift epochs as well (the display may still
-- show an order from the previous shift).
CREATE TABLE channel_number_holds (
 order_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 channel text NOT NULL REFERENCES channel_number_ranges(channel),
 display_number integer NOT NULL CHECK(
  (channel='kiosk' AND display_number BETWEEN 300 AND 599) OR
  (channel='mobile' AND display_number BETWEEN 600 AND 899)),
 shift_epoch bigint NOT NULL CHECK(shift_epoch >= 0),
 allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 released_at timestamptz,
 CHECK(released_at IS NULL OR released_at >= allocated_at)
);
CREATE UNIQUE INDEX channel_number_holds_active_idx
 ON channel_number_holds(branch_id,channel,display_number) WHERE released_at IS NULL;

CREATE FUNCTION channel_number_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Channel number holds cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.order_id,NEW.branch_id,NEW.channel,NEW.display_number,NEW.shift_epoch,NEW.allocated_at)
    IS DISTINCT FROM (OLD.order_id,OLD.branch_id,OLD.channel,OLD.display_number,OLD.shift_epoch,OLD.allocated_at)
    OR OLD.released_at IS NOT NULL THEN
  RAISE EXCEPTION 'Channel number hold is immutable once released' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_number_hold_guard BEFORE UPDATE OR DELETE ON channel_number_holds
 FOR EACH ROW EXECUTE FUNCTION channel_number_hold_guard();

-- Allocate the next free number for an order. Idempotent per order. The counter row lock
-- (UPDATE ... RETURNING) serializes allocations of one branch channel; each later statement
-- reads with a fresh READ COMMITTED snapshot, so it sees holds committed by the previous holder.
-- Outcomes: 'allocated' (new number), 'existing' (this order's active number), 'not_ready'
-- (every number in the range is held; the caller must not open payment).
CREATE FUNCTION channel_number_allocate(p_branch_id uuid, p_channel text, p_order_id uuid)
RETURNS TABLE(outcome text, display_number integer, shift_epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r channel_number_ranges%ROWTYPE; c channel_number_counters%ROWTYPE;
 h channel_number_holds%ROWTYPE; size integer; candidate integer;
BEGIN
 SELECT * INTO r FROM channel_number_ranges x WHERE x.channel=p_channel;
 IF NOT FOUND OR p_branch_id IS NULL OR p_order_id IS NULL THEN
  RAISE EXCEPTION 'Invalid channel number request' USING ERRCODE='22023';
 END IF;
 INSERT INTO channel_number_counters AS k(branch_id,channel,shift_epoch,last_number)
  VALUES(p_branch_id,p_channel,
   coalesce((SELECT max(s.epoch) FROM channel_number_shifts s WHERE s.branch_id=p_branch_id),0),
   r.low-1)
  ON CONFLICT ON CONSTRAINT channel_number_counters_pkey DO NOTHING;
 UPDATE channel_number_counters k SET updated_at=clock_timestamp()
  WHERE k.branch_id=p_branch_id AND k.channel=p_channel RETURNING * INTO STRICT c;
 SELECT * INTO h FROM channel_number_holds x WHERE x.order_id=p_order_id;
 IF FOUND THEN
  IF h.branch_id<>p_branch_id OR h.channel<>p_channel OR h.released_at IS NOT NULL THEN
   RAISE EXCEPTION 'Order already has a channel number' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT 'existing'::text,h.display_number,h.shift_epoch;
  RETURN;
 END IF;
 size := r.high-r.low+1;
 SELECT r.low+((c.last_number-r.low+n)%size) INTO candidate
  FROM generate_series(1,size) n
  WHERE NOT EXISTS(SELECT 1 FROM channel_number_holds x
   WHERE x.branch_id=p_branch_id AND x.channel=p_channel AND x.released_at IS NULL
    AND x.display_number=r.low+((c.last_number-r.low+n)%size))
  ORDER BY n LIMIT 1;
 IF candidate IS NULL THEN
  RETURN QUERY SELECT 'not_ready'::text,NULL::integer,c.shift_epoch;
  RETURN;
 END IF;
 UPDATE channel_number_counters k SET last_number=candidate
  WHERE k.branch_id=p_branch_id AND k.channel=p_channel;
 INSERT INTO channel_number_holds(order_id,branch_id,channel,display_number,shift_epoch)
  VALUES(p_order_id,p_branch_id,p_channel,candidate,c.shift_epoch);
 RETURN QUERY SELECT 'allocated'::text,candidate,c.shift_epoch;
END $$;

-- Release an order's number (handed over or cancelled). True only for the first release.
CREATE FUNCTION channel_number_release(p_order_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 UPDATE channel_number_holds SET released_at=clock_timestamp()
  WHERE order_id=p_order_id AND released_at IS NULL;
 RETURN FOUND;
END $$;

-- Cashier shift opened (consumed later from the transport event). The first delivery of a
-- shift_key starts a new epoch and restarts every channel of the branch at its low number;
-- active holds stay held and are skipped. Redelivery returns the recorded epoch, opened=false.
CREATE FUNCTION channel_number_open_shift(p_branch_id uuid, p_shift_key text)
RETURNS TABLE(epoch bigint, opened boolean)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE known bigint; next_epoch bigint;
BEGIN
 IF p_branch_id IS NULL OR p_shift_key IS NULL THEN
  RAISE EXCEPTION 'Invalid channel shift' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('channel_numbers:'||p_branch_id::text,0));
 SELECT s.epoch INTO known FROM channel_number_shifts s
  WHERE s.branch_id=p_branch_id AND s.shift_key=p_shift_key;
 IF FOUND THEN
  RETURN QUERY SELECT known,false;
  RETURN;
 END IF;
 SELECT coalesce(max(s.epoch),0)+1 INTO next_epoch FROM channel_number_shifts s
  WHERE s.branch_id=p_branch_id;
 INSERT INTO channel_number_shifts(branch_id,shift_key,epoch) VALUES(p_branch_id,p_shift_key,next_epoch);
 INSERT INTO channel_number_counters AS k(branch_id,channel,shift_epoch,last_number)
  SELECT p_branch_id,x.channel,next_epoch,x.low-1 FROM channel_number_ranges x
  ON CONFLICT ON CONSTRAINT channel_number_counters_pkey DO UPDATE
   SET shift_epoch=EXCLUDED.shift_epoch,last_number=EXCLUDED.last_number,updated_at=clock_timestamp();
 RETURN QUERY SELECT next_epoch,true;
END $$;

-- Pin the owner-controlled schema, including in isolated integration-test schemas.
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.channel_number_allocate(uuid,text,uuid) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
 EXECUTE format('ALTER FUNCTION %I.channel_number_release(uuid) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
 EXECUTE format('ALTER FUNCTION %I.channel_number_open_shift(uuid,text) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE ALL ON FUNCTION channel_number_allocate(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION channel_number_release(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION channel_number_open_shift(uuid,text) FROM PUBLIC;
