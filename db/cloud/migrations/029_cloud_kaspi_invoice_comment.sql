-- Persist exactly what was submitted. NULL identifies legacy reference-bearing invoices.
ALTER TABLE commerce_kaspi_invoices ADD COLUMN invoice_comment text
  CHECK(invoice_comment IS NULL OR length(invoice_comment) BETWEEN 1 AND 255);
CREATE INDEX commerce_kaspi_comment_idx ON commerce_kaspi_invoices(account_id,invoice_comment)
  WHERE invoice_comment IS NOT NULL;
CREATE FUNCTION guard_kaspi_invoice_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_comment IS DISTINCT FROM OLD.invoice_comment THEN
    RAISE EXCEPTION 'Submitted invoice message is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kaspi_invoice_comment_guard BEFORE UPDATE ON commerce_kaspi_invoices
FOR EACH ROW EXECUTE FUNCTION guard_kaspi_invoice_comment();
