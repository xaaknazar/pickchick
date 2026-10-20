-- Restore fencing (finding 6.4, docs/operations/edge-restore.md). Additive only.
-- A logical restore (pg_restore into a new database or cluster) brings this ledger back with
-- the identity of the database the backup was taken from. The edge service compares it with the
-- live PostgreSQL system identifier and database OID at start. On a mismatch every
-- edge-to-cloud producer sequence moves past anything the lost timeline may have used (the cloud
-- accepts gaps but never a reused sequence), and the menu cursor may skip forward once to the
-- oldest publication the cloud still has unacknowledged. Nothing is deleted or replayed.
CREATE TABLE edge_database_epochs (
  epoch integer PRIMARY KEY CHECK (epoch > 0),
  system_identifier bigint NOT NULL,
  database_oid bigint NOT NULL,
  reason text NOT NULL CHECK (reason IN ('initial', 'restore', 'operator')),
  sequence_gap bigint NOT NULL CHECK (sequence_gap >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_edge_database_epochs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Edge database epochs are append-only' USING ERRCODE = '23514';
END; $$;
CREATE TRIGGER edge_database_epochs_guard BEFORE UPDATE OR DELETE ON edge_database_epochs
FOR EACH ROW EXECUTE FUNCTION guard_edge_database_epochs();

-- Menu cursor at the last fence. While last_sequence still equals it, one delivery from the same
-- cloud producer may skip ahead; the first applied delivery moves the cursor and ends that.
ALTER TABLE menu_sync_state ADD COLUMN restore_resync_from bigint;

-- Idempotent: 'initial' on first use, 'current' while the identity is unchanged, 'restore' once
-- after a restore. p_force records an operator fence for a file-level restore that kept the
-- identity. Owner rights (SECURITY DEFINER) so the least-privileged runtime may run it without
-- sequence UPDATE rights; it can only ever add the fixed gap.
CREATE FUNCTION edge_restore_fence(p_force boolean DEFAULT false)
RETURNS TABLE(state text, epoch integer, sequence_gap bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
#variable_conflict use_column
DECLARE
  gap constant bigint := 1000000000;
  live_system bigint;
  live_oid bigint;
  last_epoch edge_database_epochs%ROWTYPE;
  source text;
  sequence_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pickchick:edge_restore_fence:' || current_schema(), 0));
  SELECT c.system_identifier INTO live_system FROM pg_control_system() c;
  SELECT d.oid::bigint INTO live_oid FROM pg_database d WHERE d.datname = current_database();
  SELECT * INTO last_epoch FROM edge_database_epochs e ORDER BY e.epoch DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO edge_database_epochs(epoch, system_identifier, database_oid, reason, sequence_gap)
      VALUES (1, live_system, live_oid, 'initial', 0);
    RETURN QUERY SELECT 'initial'::text, 1, 0::bigint;
    RETURN;
  END IF;
  IF NOT p_force AND last_epoch.system_identifier = live_system
    AND last_epoch.database_oid = live_oid THEN
    RETURN QUERY SELECT 'current'::text, last_epoch.epoch, 0::bigint;
    RETURN;
  END IF;
  UPDATE local_order_streams SET last_sequence = last_sequence + gap;
  FOREACH source IN ARRAY ARRAY['cashier_report_outbox', 'fulfillment_outbox'] LOOP
    IF to_regclass(source) IS NOT NULL THEN
      sequence_name := pg_get_serial_sequence(source, 'sequence');
      IF sequence_name IS NOT NULL THEN
        PERFORM setval(sequence_name::regclass,
          coalesce(pg_sequence_last_value(sequence_name::regclass), 0) + gap, true);
      END IF;
    END IF;
  END LOOP;
  UPDATE menu_sync_state SET restore_resync_from = last_sequence;
  INSERT INTO edge_database_epochs(epoch, system_identifier, database_oid, reason, sequence_gap)
    VALUES (last_epoch.epoch + 1, live_system, live_oid,
      CASE WHEN p_force THEN 'operator' ELSE 'restore' END, gap);
  RETURN QUERY SELECT CASE WHEN p_force THEN 'operator' ELSE 'restore' END, last_epoch.epoch + 1, gap;
END; $$;
REVOKE EXECUTE ON FUNCTION edge_restore_fence(boolean) FROM PUBLIC;
-- Record this database's identity now, so even a backup taken before the next service start
-- carries it.
SELECT edge_restore_fence();
