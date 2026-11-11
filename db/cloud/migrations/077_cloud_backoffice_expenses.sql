-- «Расходы» of the back office (owner request 11.11.2026, docs/operations/backoffice-expenses.md).
-- Management accounting of the organization: expenses per branch and day (or per month), company
-- expenses without a branch, the cash desk of a branch and day, closed months and an action log.
-- Never creates captures, refunds, fiscal documents or bank state. Additive: new tables only; the
-- old «Финансы» ledger (cloud042 bo_finance_*) is not touched. Runtime access is granted by
-- infra/staging/backoffice-expenses-grants.mjs behind BACKOFFICE_EXPENSES_ENABLED (default off).
-- Money is signed integer tiyn. Days are Asia/Almaty calendar days.

-- Access to the section. Append-only: the latest row per organization and actor is in force,
-- role NULL takes access away. A director closes and opens months and gives access; finance and
-- economist enter and change records; viewer only reads. A login with the «manager» grant on
-- every branch of the organization is a director without a row here (the owner).
CREATE TABLE bo_expense_access (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 role text NULL CHECK(role IN ('director','finance','economist','viewer')),
 granted_by uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX bo_expense_access_actor_idx ON bo_expense_access(organization_id,actor_id,id DESC);

-- One record = one amount. location_id NULL = «Общие расходы компании». A grid cell (cell=true)
-- is unique per day (or month), branch, article and source; records «с контрагентом» are not.
-- pl_month is the month of the P&L (first day). A monthly record is dated the last day of its
-- month and belongs to that month.
CREATE TABLE bo_expense_entries (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 location_id uuid NULL,
 date date NOT NULL CHECK(date BETWEEN '2000-01-01' AND '2099-12-31'),
 category text NOT NULL CHECK(category ~ '^[a-z][a-z0-9_]{1,40}$'),
 source text NOT NULL CHECK(source IN ('cash','kaspi','halyk','bank')),
 amount_minor bigint NOT NULL CHECK(amount_minor<>0 AND abs(amount_minor)<=99999999999999),
 pl_month date NOT NULL CHECK(extract(day FROM pl_month)=1),
 monthly boolean NOT NULL DEFAULT false,
 cell boolean NOT NULL,
 counterparty text NOT NULL DEFAULT '' CHECK(length(counterparty)<=200),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=1000),
 author_id uuid NOT NULL REFERENCES catalog_managers(id),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 FOREIGN KEY(location_id,organization_id) REFERENCES branches(id,organization_id),
 CHECK(NOT monthly OR (date=(date_trunc('month',date)+interval '1 month - 1 day')::date
   AND pl_month=date_trunc('month',date)::date))
);
CREATE UNIQUE INDEX bo_expense_cells_idx ON bo_expense_entries(
 organization_id,coalesce(location_id,'00000000-0000-0000-0000-000000000000'::uuid),date,monthly,category,source)
 WHERE cell;
CREATE INDEX bo_expense_entries_date_idx ON bo_expense_entries(organization_id,date);
CREATE INDEX bo_expense_entries_pl_idx ON bo_expense_entries(organization_id,pl_month);

-- Row defaults of the grid: the month of the P&L and the comment of an article on a day (or
-- month) of a branch, kept even while the row has no amount; new cells of the row take them.
CREATE TABLE bo_expense_rows (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 location_key uuid NOT NULL,
 date date NOT NULL,
 monthly boolean NOT NULL,
 category text NOT NULL CHECK(category ~ '^[a-z][a-z0-9_]{1,40}$'),
 pl_month date NOT NULL CHECK(extract(day FROM pl_month)=1),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=1000),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,location_key,date,monthly,category)
);

-- Cash desk of a branch and day: the opening balance (NULL = the cashier's count of the
-- previous day) and the cashier's count at the end of the day.
CREATE TABLE bo_expense_cash (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 location_id uuid NOT NULL,
 date date NOT NULL CHECK(date BETWEEN '2000-01-01' AND '2099-12-31'),
 opening_minor bigint NULL CHECK(abs(opening_minor)<=99999999999999),
 counted_minor bigint NULL CHECK(abs(counted_minor)<=99999999999999),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=1000),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(location_id,date),
 FOREIGN KEY(location_id,organization_id) REFERENCES branches(id,organization_id)
);

-- A row = a closed month of the organization. Opening a month deletes its row (the log keeps it).
CREATE TABLE bo_expense_months (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 month date NOT NULL CHECK(extract(day FROM month)=1),
 closed_by uuid NOT NULL REFERENCES catalog_managers(id),
 closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,month)
);

-- Who did what: entry.create/update/delete, row, cash, month.close/open, access. Append-only.
CREATE TABLE bo_expense_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 action text NOT NULL CHECK(action IN ('entry.create','entry.update','entry.delete','row','cash','month.close','month.open','access')),
 location_id uuid NULL,
 date date NULL,
 before_value jsonb NULL,
 after_value jsonb NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX bo_expense_log_org_idx ON bo_expense_log(organization_id,id DESC);

CREATE FUNCTION guard_bo_expense_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='23514';
END $$;
CREATE TRIGGER bo_expense_access_append_only BEFORE UPDATE OR DELETE ON bo_expense_access
FOR EACH ROW EXECUTE FUNCTION guard_bo_expense_append_only();
CREATE TRIGGER bo_expense_log_append_only BEFORE UPDATE OR DELETE ON bo_expense_log
FOR EACH ROW EXECUTE FUNCTION guard_bo_expense_append_only();

-- A closed month refuses every change of its records and cash days, whoever writes (the API
-- checks first and answers MONTH_CLOSED; this is the last line).
CREATE FUNCTION guard_bo_expense_closed_month() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END),
                                 (CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END)) v(row)
           WHERE row IS NOT NULL LOOP
    IF EXISTS(SELECT 1 FROM bo_expense_months m WHERE m.organization_id=(r.row->>'organization_id')::uuid
        AND (m.month=date_trunc('month',(r.row->>'date')::date)::date
          OR m.month=(r.row->>'pl_month')::date)) THEN
      RAISE EXCEPTION 'The month is closed' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER bo_expense_entries_closed BEFORE INSERT OR UPDATE OR DELETE ON bo_expense_entries
FOR EACH ROW EXECUTE FUNCTION guard_bo_expense_closed_month();
CREATE TRIGGER bo_expense_cash_closed BEFORE INSERT OR UPDATE OR DELETE ON bo_expense_cash
FOR EACH ROW EXECUTE FUNCTION guard_bo_expense_closed_month();
CREATE TRIGGER bo_expense_rows_closed BEFORE INSERT OR UPDATE OR DELETE ON bo_expense_rows
FOR EACH ROW EXECUTE FUNCTION guard_bo_expense_closed_month();
