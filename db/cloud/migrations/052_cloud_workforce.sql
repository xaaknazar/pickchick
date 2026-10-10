-- Planning and attendance are separate from cashier/fiscal shifts and money payments.
CREATE TABLE bo_workforce_records (
 id uuid NOT NULL,
 branch_id uuid NOT NULL REFERENCES branches(id),
 kind text NOT NULL CHECK(kind IN ('plan','rate','time','bonus')),
 employee_id uuid NOT NULL,
 employee_kind text NOT NULL DEFAULT 'employee' CHECK(employee_kind='employee'),
 revision integer NOT NULL CHECK(revision > 0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,id),
 FOREIGN KEY(branch_id,employee_kind,employee_id) REFERENCES bo_records(branch_id,kind,id)
);
CREATE INDEX bo_workforce_employee_idx ON bo_workforce_records(branch_id,employee_id,kind);
CREATE TABLE bo_workforce_events (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 employee_id uuid NOT NULL,
 employee_kind text NOT NULL DEFAULT 'employee' CHECK(employee_kind='employee'),
 source text NOT NULL,
 external_id text NOT NULL,
 occurred_at timestamptz NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out','break_start','break_end','unknown')),
 payload jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,source,external_id),
 FOREIGN KEY(branch_id,employee_kind,employee_id) REFERENCES bo_records(branch_id,kind,id)
);
CREATE INDEX bo_workforce_events_period_idx ON bo_workforce_events(branch_id,occurred_at,id);
CREATE TABLE bo_workforce_periods (
 branch_id uuid NOT NULL REFERENCES branches(id),
 month date NOT NULL CHECK(extract(day FROM month)=1),
 closed boolean NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 PRIMARY KEY(branch_id,month)
);
CREATE TABLE bo_workforce_commands (
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 request_id uuid NOT NULL,
 branch_id uuid NOT NULL REFERENCES branches(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
