-- Resolution cases and everything recorded about them.
CREATE TABLE cases (
  id            TEXT PRIMARY KEY,
  customer_ref  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN (
                  'open', 'needs_information', 'needs_review', 'awaiting_approval', 'ready_to_submit',
                  'executing', 'awaiting_verification', 'needs_reconciliation', 'resolved',
                  'not_eligible', 'closed')),
  goal_type     TEXT NOT NULL CHECK (goal_type IN ('return', 'exchange', 'unknown')),
  product_query TEXT,
  as_of         TEXT NOT NULL,
  title         TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX cases_by_customer ON cases (customer_ref, updated_at);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('customer', 'assistant')),
  text                TEXT NOT NULL,
  channel             TEXT NOT NULL,
  interpretation_json TEXT,
  assessment_id       TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX messages_by_case ON messages (case_id, created_at);

CREATE TABLE evidence (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  source_type      TEXT NOT NULL,
  source_name      TEXT NOT NULL,
  source_reference TEXT,
  simulated        INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  observed_at      TEXT NOT NULL,
  verification     TEXT NOT NULL CHECK (verification IN ('verified', 'unverified', 'failed')),
  status           TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected')),
  facts_json       TEXT NOT NULL,
  policy_json      TEXT,
  note             TEXT,
  UNIQUE (case_id, seq)
);

CREATE TABLE assessments (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  case_version     INTEGER NOT NULL,
  compiler_version TEXT NOT NULL,
  next_step        TEXT NOT NULL,
  next_state       TEXT NOT NULL,
  body_json        TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX assessments_by_case ON assessments (case_id, created_at);

CREATE TABLE proposals (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  assessment_id       TEXT NOT NULL REFERENCES assessments (id),
  action_type         TEXT NOT NULL,
  parameters_json     TEXT NOT NULL,
  digest              TEXT NOT NULL CHECK (length(digest) = 64),
  preconditions_json  TEXT NOT NULL,
  postconditions_json TEXT NOT NULL,
  verification_json   TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'declined', 'superseded')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
-- At most one live proposal for the same exact action on a case.
CREATE UNIQUE INDEX proposals_live_digest ON proposals (case_id, digest)
  WHERE status IN ('prepared', 'approved');

CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals (id),
  case_id     TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  digest      TEXT NOT NULL CHECK (length(digest) = 64),
  approved_by TEXT NOT NULL,
  channel     TEXT NOT NULL,
  statement   TEXT NOT NULL,
  approved_at TEXT NOT NULL
);

CREATE TABLE operations (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  proposal_id     TEXT NOT NULL UNIQUE REFERENCES proposals (id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN (
                    'submitting', 'accepted', 'confirmed', 'rejected', 'failed', 'outcome_unknown')),
  attempts        INTEGER NOT NULL CHECK (attempts >= 0),
  external_ref    TEXT,
  last_error      TEXT,
  observed_json   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE operation_attempts (
  id           TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('submit', 'reconcile', 'verify')),
  outcome      TEXT NOT NULL,
  detail       TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL
);
CREATE INDEX attempts_by_operation ON operation_attempts (operation_id, started_at);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  data_json  TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, seq)
);
