-- Owner requested permanent TEST access. Preserve the existing identity, token
-- hash, role and every order; revoked credentials must never be reactivated.
-- PostgreSQL infinity is genuinely unbounded. The API provides an ISO sentinel
-- only for backwards compatibility with published clients' strict schemas.
ALTER TABLE test_actors ALTER COLUMN expires_at SET DEFAULT 'infinity';
UPDATE test_actors SET expires_at='infinity' WHERE revoked_at IS NULL;
COMMENT ON COLUMN test_actors.expires_at IS
  'TEST access: infinity means valid until explicit revocation; finite timestamps remain supported for legacy credentials.';
CREATE INDEX test_quotes_actor_created_idx ON test_quotes(actor_id,created_at);
