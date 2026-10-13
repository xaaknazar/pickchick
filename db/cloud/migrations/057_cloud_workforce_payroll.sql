-- Explicit monthly payroll worksheets; source snapshots are retained in audited payloads.
ALTER TABLE bo_workforce_records DROP CONSTRAINT bo_workforce_records_kind_check;
ALTER TABLE bo_workforce_records ADD CONSTRAINT bo_workforce_records_kind_check CHECK(kind IN ('plan','rate','time','bonus','payroll'));
