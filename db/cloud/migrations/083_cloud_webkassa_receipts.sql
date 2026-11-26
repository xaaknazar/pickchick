-- Webkassa receipts of app and kiosk orders (audit 26.11 P0-1, webkassa-cloud.ts): the data of an
-- issued sale receipt that a refund receipt must name in ReturnBasisDetails (number, date and time
-- as Webkassa printed them, cashbox registration number, offline flag). Written once per document.
CREATE TABLE commerce_webkassa_receipts (
  document_id uuid PRIMARY KEY REFERENCES commerce_fiscal_documents(id),
  check_number text NOT NULL CHECK(length(check_number) BETWEEN 1 AND 64),
  issued_at text NOT NULL CHECK(issued_at ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}$'),
  registration_number text NOT NULL CHECK(length(registration_number) BETWEEN 1 AND 64),
  offline boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION commerce_webkassa_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Webkassa receipt data is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER commerce_webkassa_receipt_guard BEFORE UPDATE OR DELETE ON commerce_webkassa_receipts
  FOR EACH ROW EXECUTE FUNCTION commerce_webkassa_receipt_guard();
