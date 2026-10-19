-- Release fixes 2026-10-19 (audit 1.4). Cashier display numbers are 1-299 and start again from 1
-- at every opened cash shift (without an open shift: every Almaty business day). Kiosk 300-599
-- and mobile 600-899 are the cloud kitchen ranges (cloud053), so the ranges never overlap. A
-- number still held by a live order is skipped, so two live orders never share a number. The old
-- global sequence stays for rollback; existing reservations keep their numbers.

CREATE TABLE IF NOT EXISTS fulfillment_display_counters (
  branch_id uuid PRIMARY KEY REFERENCES fulfillment_config(branch_id),
  epoch text NOT NULL CHECK (length(epoch) BETWEEN 1 AND 100),
  last_number integer NOT NULL CHECK (last_number BETWEEN 0 AND 299),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Numbers are reused after a reset, so they are unique only among live orders (the allocator
-- below), not forever or per business day.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='fulfillment_reservations'::regclass AND contype='u'
      AND pg_get_constraintdef(oid) LIKE '%display_number%'
  LOOP EXECUTE format('ALTER TABLE fulfillment_reservations DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS fulfillment_display_live_idx ON fulfillment_reservations(branch_id,display_number)
WHERE state IN ('held','accepted','in_production','ready','cancel_requested');

-- Next free number of the branch, or NULL when every number 1-299 is held by a live order (the
-- caller refuses the admission). Live: changed within 12 hours in a kitchen state, or a hold
-- reserved within 6 hours. A forgotten "ready" order or an abandoned unpaid hold therefore never
-- blocks numbering for good. The counter row lock serializes allocations of one branch until
-- commit; each statement then reads with a fresh READ COMMITTED snapshot that includes the
-- previous holder's order.
CREATE OR REPLACE FUNCTION fulfillment_display_allocate(p_branch_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_epoch text; v_last integer; v_saved text; v_candidate integer;
BEGIN
  IF p_branch_id IS NULL THEN RAISE EXCEPTION 'Invalid display number request' USING ERRCODE='22023'; END IF;
  SELECT coalesce(
    (SELECT 'shift:'||s.id::text FROM local_cash_shifts s WHERE s.branch_id=p_branch_id AND s.state='open'
      ORDER BY s.opened_at DESC,s.id LIMIT 1),
    'day:'||((clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date)::text) INTO v_epoch;
  INSERT INTO fulfillment_display_counters(branch_id,epoch,last_number) VALUES(p_branch_id,v_epoch,0)
  ON CONFLICT (branch_id) DO NOTHING;
  SELECT k.epoch,k.last_number INTO v_saved,v_last FROM fulfillment_display_counters k
  WHERE k.branch_id=p_branch_id FOR UPDATE;
  IF v_saved IS DISTINCT FROM v_epoch THEN v_last := 0; END IF;
  SELECT x.n INTO v_candidate FROM generate_series(1,299) g(i)
  CROSS JOIN LATERAL (SELECT ((v_last+g.i-1)%299)+1 AS n) x
  WHERE NOT EXISTS(SELECT 1 FROM fulfillment_reservations r
    WHERE r.branch_id=p_branch_id AND r.display_number=x.n
      AND ((r.state IN ('accepted','in_production','ready','cancel_requested')
          AND r.updated_at>clock_timestamp()-interval '12 hours')
        OR (r.state='held' AND r.created_at>clock_timestamp()-interval '6 hours')))
  ORDER BY g.i LIMIT 1;
  IF v_candidate IS NULL THEN RETURN NULL; END IF;
  UPDATE fulfillment_display_counters SET epoch=v_epoch,last_number=v_candidate,updated_at=clock_timestamp()
  WHERE branch_id=p_branch_id;
  RETURN v_candidate;
END $$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.fulfillment_display_allocate(uuid) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE ALL ON FUNCTION fulfillment_display_allocate(uuid) FROM PUBLIC;
