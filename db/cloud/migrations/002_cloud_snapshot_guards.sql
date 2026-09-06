-- JSON null would otherwise make SQL CHECK expressions evaluate to unknown.
ALTER TABLE menu_releases ADD CONSTRAINT menu_release_identity_not_null CHECK (
  payload->>'release_id' IS NOT NULL
  AND payload->>'branch_id' IS NOT NULL
  AND payload->>'version' IS NOT NULL
  AND payload->>'schema_version' IS NOT NULL
  AND jsonb_typeof(payload->'version') = 'number'
  AND jsonb_typeof(payload->'schema_version') = 'number'
  AND jsonb_typeof(payload->'items') = 'array'
);
