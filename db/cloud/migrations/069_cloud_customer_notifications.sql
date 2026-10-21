-- Notification state is independent of money and the kitchen transport acknowledgements.
CREATE TABLE customer_notification_preferences (
  customer_id uuid PRIMARY KEY REFERENCES identity_customers(id),
  locale text NOT NULL DEFAULT 'ru' CHECK(locale IN ('ru','kk','en')),
  orders boolean NOT NULL DEFAULT false,
  promotions boolean NOT NULL DEFAULT false,
  orders_enabled_at timestamptz,
  promotions_consent_version text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(NOT promotions OR promotions_consent_version='notifications-v1')
);
CREATE TABLE customer_notification_consents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES identity_customers(id),
  orders boolean NOT NULL, promotions boolean NOT NULL,
  consent_version text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE customer_push_devices (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES identity_customers(id),
  session_id uuid NOT NULL REFERENCES identity_sessions(id),
  installation_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('apns','fcm')),
  environment text NOT NULL CHECK(environment IN ('development','production')),
  bundle_id text NOT NULL CHECK(bundle_id IN ('kz.pickchick.app','kz.pickchick.app.dev')),
  token_hash text NOT NULL UNIQUE,
  token_cipher text,
  disabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(customer_id, installation_id)
);
CREATE TABLE customer_notifications (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES identity_customers(id),
  order_id uuid NOT NULL REFERENCES commerce_orders(id),
  kind text NOT NULL CHECK(kind IN ('paid','preparing','ready','handed_over')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  UNIQUE(customer_id,order_id,kind)
);
CREATE INDEX customer_notifications_inbox_idx ON customer_notifications(customer_id,created_at DESC);
CREATE TABLE customer_push_deliveries (
  notification_id uuid NOT NULL REFERENCES customer_notifications(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES customer_push_devices(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','discarded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid, lease_until timestamptz,
  last_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(notification_id,device_id)
);
CREATE INDEX customer_push_pending_idx ON customer_push_deliveries(available_at) WHERE state IN ('pending','sending');
