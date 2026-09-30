-- Local operator enrollment only: the edge runtime cannot create/reset verifiers.
CREATE TABLE local_staff_passwords (
  staff_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  login text NOT NULL CHECK (login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  algorithm text NOT NULL DEFAULT 'scrypt-v1' CHECK (algorithm = 'scrypt-v1'),
  salt text NOT NULL CHECK (salt ~ '^[a-f0-9]{64}$'),
  verifier text NOT NULL CHECK (verifier ~ '^[a-f0-9]{64}$'),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (branch_id, login),
  FOREIGN KEY (staff_id, branch_id) REFERENCES local_staff(id, branch_id)
);

-- One row per provisioned terminal, never one row per arbitrary input login.
CREATE TABLE local_staff_login_limits (
  terminal_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 10),
  FOREIGN KEY (terminal_id, branch_id) REFERENCES local_terminals(id, branch_id)
);
