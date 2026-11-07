/**
 * Review BOUI-R3: rolling the API image back to the cloud lane build while cloud075 stays.
 *
 * The cloud lane parses ingredient, recipe and employee cards with its strict schemas (save,
 * produce), so a card that carries a P1 field (quick_waste, count_daily, group, stock_policy,
 * position_code, extra_position_codes, pos_access) could no longer be saved or produced. The
 * schema owner runs P1_PAYLOAD_STASH_SQL in one transaction right before such a rollback: it
 * moves those fields into the side table bo_p1_payload_stash (created there, owner only, no API
 * rights) and bumps the card revision, so an editor that is still open gets CONFLICT instead of
 * overwriting. P1_PAYLOAD_RESTORE_SQL puts the newest stashed fields back once the bo-ui build
 * runs again. Both are idempotent and touch nothing else. The runbook
 * (docs/operations/backoffice-p1-cutover.md, «Откат образа API») quotes them verbatim; a test
 * keeps the two in step.
 */
export const P1_PAYLOAD_STASH_SQL = `CREATE TABLE IF NOT EXISTS bo_p1_payload_stash (
  branch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ingredient','recipe','employee')),
  record_id uuid NOT NULL,
  stashed_revision integer NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  stashed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  restored_at timestamptz NULL,
  PRIMARY KEY (branch_id, kind, record_id, stashed_revision)
);
REVOKE ALL ON bo_p1_payload_stash FROM PUBLIC;
WITH p1 AS (
  SELECT r.branch_id, r.kind, r.id, r.revision,
    (SELECT coalesce(jsonb_object_agg(k, r.payload->k), '{}'::jsonb)
       FROM unnest(CASE r.kind
         WHEN 'ingredient' THEN ARRAY['quick_waste','count_daily','group']
         WHEN 'recipe' THEN ARRAY['stock_policy']
         ELSE ARRAY['position_code','extra_position_codes','pos_access'] END) k
      WHERE r.payload ? k) AS fields
  FROM bo_records r WHERE r.kind IN ('ingredient','recipe','employee')
  FOR UPDATE OF r
), moved AS (
  INSERT INTO bo_p1_payload_stash (branch_id, kind, record_id, stashed_revision, fields)
  SELECT branch_id, kind, id, revision + 1, fields FROM p1 WHERE fields <> '{}'::jsonb
  RETURNING branch_id, kind, record_id, fields
)
UPDATE bo_records r
   SET payload = r.payload - ARRAY(SELECT jsonb_object_keys(m.fields)),
       revision = r.revision + 1, updated_at = clock_timestamp()
  FROM moved m
 WHERE r.branch_id = m.branch_id AND r.kind = m.kind AND r.id = m.record_id;
`;
export const P1_PAYLOAD_RESTORE_SQL = `WITH s AS (
  SELECT DISTINCT ON (branch_id, kind, record_id) branch_id, kind, record_id, stashed_revision, fields
    FROM bo_p1_payload_stash WHERE restored_at IS NULL
   ORDER BY branch_id, kind, record_id, stashed_revision DESC
), back AS (
  UPDATE bo_records r
     SET payload = s.fields || r.payload, revision = r.revision + 1, updated_at = clock_timestamp()
    FROM s
   WHERE r.branch_id = s.branch_id AND r.kind = s.kind AND r.id = s.record_id
  RETURNING r.branch_id, r.kind, r.id
)
UPDATE bo_p1_payload_stash t SET restored_at = clock_timestamp()
  FROM s
 WHERE t.restored_at IS NULL AND t.branch_id = s.branch_id AND t.kind = s.kind
   AND t.record_id = s.record_id AND t.stashed_revision <= s.stashed_revision
   AND EXISTS (SELECT 1 FROM back b WHERE b.branch_id = s.branch_id AND b.kind = s.kind AND b.id = s.record_id);
`;
