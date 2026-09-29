-- Kaspi remote invoice (счёт на номер телефона) for one payment attempt.
-- An attempt has at most one invoice and a Kaspi operation id belongs to one
-- attempt only, so an observed payment can never be credited twice.
-- No phone number is stored: the worker resolves it from identity only while issuing.
CREATE TABLE commerce_kaspi_invoices (
  attempt_id uuid PRIMARY KEY REFERENCES commerce_payment_attempts(id),
  order_id uuid NOT NULL REFERENCES commerce_orders(id),
  account_id uuid NOT NULL REFERENCES commerce_provider_accounts(id),
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor%100=0),
  -- issuing: the request may already have reached Kaspi, no operation id yet;
  -- issued: the invoice exists; unknown: must be found by reference or resolved manually.
  -- Each state is entered at most once, so (attempt, state) is a stable event id.
  state text NOT NULL CHECK(state IN ('issuing','issued','paid','failed','unknown')),
  state_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Random token placed in the invoice comment; the only link for recovery via history.
  reference text NOT NULL UNIQUE CHECK(reference ~ '^[A-Z0-9]{10}$'),
  operation_id text UNIQUE CHECK(operation_id ~ '^[1-9][0-9]{0,19}$'),
  remote_status text CHECK(remote_status ~ '^[A-Za-z0-9_]{1,64}$'),
  paid_minor bigint CHECK(paid_minor>0),
  issue_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issued_at timestamptz,
  expires_at timestamptz,
  cancel_requested_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Worker lease for one status check; independent of next_check_at (webhook hints).
  lease_until timestamptz,
  lease_token uuid,
  -- State delivery to the commerce inbox is retried after a crash.
  delivered_at timestamptz,
  checks integer NOT NULL DEFAULT 0 CHECK(checks>=0),
  CHECK(state NOT IN ('issued','paid') OR operation_id IS NOT NULL),
  CHECK((issued_at IS NULL)=(operation_id IS NULL)),
  CHECK((expires_at IS NULL)=(issued_at IS NULL)),
  CHECK((state='paid')=(paid_minor IS NOT NULL))
);
CREATE INDEX commerce_kaspi_invoices_due_idx ON commerce_kaspi_invoices(account_id,next_check_at)
  WHERE state IN ('issuing','issued','unknown') OR delivered_at IS NULL;
CREATE INDEX commerce_kaspi_invoices_order_idx ON commerce_kaspi_invoices(order_id);
