-- Future Claude-only check on the point after schema028, before first POS sync Install.
-- Execute with the existing protected local database client; never print its password.
-- No row payloads or personal data are returned. A missing table means STOP.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT json_build_object(
  'event', 'pos_sales_backlog',
  'checked_at', statement_timestamp(),
  'branch_count', (SELECT count(*) FROM branch_config),
  'expected_branch_present', EXISTS (
    SELECT 1 FROM branch_config WHERE id = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
  ),
  'unacknowledged', count(*) FILTER (WHERE acknowledged_at IS NULL),
  'other_branch_unacknowledged', count(*) FILTER (
    WHERE acknowledged_at IS NULL AND branch_id <> '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
  ),
  'with_error', count(*) FILTER (WHERE acknowledged_at IS NULL AND last_error IS NOT NULL),
  'first_at', min(occurred_at) FILTER (WHERE acknowledged_at IS NULL),
  'last_at', max(occurred_at) FILTER (WHERE acknowledged_at IS NULL),
  'decision_required', count(*) FILTER (WHERE acknowledged_at IS NULL) > 0,
  'changed', false
)
FROM pos_sale_outbox;
ROLLBACK;
