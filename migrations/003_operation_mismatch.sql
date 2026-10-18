-- Add the 'mismatch' operation status: the retailer has a return for the
-- request, but its terms differ from what the customer approved. This is
-- distinct from 'rejected' (nothing was created).
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Attempts
-- reference operations, so they are set aside first and restored after.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE operation_attempts_backup AS SELECT * FROM operation_attempts;
DROP TABLE operation_attempts;

CREATE TABLE operations_next (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  proposal_id     TEXT NOT NULL UNIQUE REFERENCES proposals (id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN (
                    'submitting', 'accepted', 'confirmed', 'rejected', 'failed', 'outcome_unknown',
                    'mismatch')),
  attempts        INTEGER NOT NULL CHECK (attempts >= 0),
  external_ref    TEXT,
  last_error      TEXT,
  observed_json   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
INSERT INTO operations_next SELECT * FROM operations;
DROP TABLE operations;
ALTER TABLE operations_next RENAME TO operations;

CREATE TABLE operation_attempts (
  id           TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('submit', 'reconcile', 'verify')),
  outcome      TEXT NOT NULL,
  detail       TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL
);
INSERT INTO operation_attempts SELECT * FROM operation_attempts_backup;
DROP TABLE operation_attempts_backup;
CREATE INDEX attempts_by_operation ON operation_attempts (operation_id, started_at);
