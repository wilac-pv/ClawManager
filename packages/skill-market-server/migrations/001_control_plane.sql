CREATE TABLE users (
  employee_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  email TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  disabled_at INTEGER
) STRICT;

CREATE TABLE role_assignments (
  employee_id TEXT NOT NULL REFERENCES users(employee_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reviewer', 'admin')),
  created_by TEXT REFERENCES users(employee_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (employee_id, role)
) STRICT;

CREATE TABLE login_attempts (
  attempt_hash TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
) STRICT;

CREATE INDEX login_attempts_expiry ON login_attempts(expires_at, consumed_at);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(employee_id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  CHECK (last_activity_at >= created_at),
  CHECK (absolute_expires_at > created_at)
) STRICT;

CREATE INDEX sessions_employee ON sessions(employee_id);
CREATE INDEX sessions_expiry ON sessions(absolute_expires_at, last_activity_at);

CREATE TABLE community_skills (
  skill_id TEXT PRIMARY KEY,
  owner_employee_id TEXT NOT NULL REFERENCES users(employee_id),
  current_version TEXT,
  current_submission_id TEXT,
  public_status TEXT CHECK (public_status IS NULL OR public_status IN ('published', 'delisted')),
  delist_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (public_status IS NOT 'delisted' OR delist_reason IS NOT NULL),
  FOREIGN KEY (current_submission_id) REFERENCES submissions(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX community_skills_owner ON community_skills(owner_employee_id, updated_at DESC);
CREATE INDEX community_skills_public ON community_skills(public_status, updated_at DESC);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  owner_employee_id TEXT NOT NULL REFERENCES users(employee_id),
  target_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'validating',
      'validation_failed',
      'pending_review',
      'changes_requested',
      'rejected',
      'publishing',
      'publish_failed',
      'published'
    )
  ),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  user_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX submissions_active_skill_version
  ON submissions(skill_id, target_version)
  WHERE status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');
CREATE INDEX submissions_owner_updated ON submissions(owner_employee_id, updated_at DESC);
CREATE INDEX submissions_status_updated ON submissions(status, updated_at);

CREATE TABLE submission_revisions (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  private_package_key TEXT NOT NULL,
  package_sha256 TEXT NOT NULL CHECK (length(package_sha256) = 64),
  package_size INTEGER NOT NULL CHECK (package_size > 0),
  metadata_json TEXT NOT NULL,
  manifest_json TEXT,
  scan_json TEXT,
  validation_errors_json TEXT,
  validation_lease_owner TEXT,
  validation_lease_expires_at INTEGER,
  validation_completed_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (submission_id, revision_number),
  CHECK (
    (validation_lease_owner IS NULL AND validation_lease_expires_at IS NULL) OR
    (validation_lease_owner IS NOT NULL AND validation_lease_expires_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX submission_revisions_validation_queue
  ON submission_revisions(validation_completed_at, validation_lease_expires_at, created_at);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  reviewer_employee_id TEXT NOT NULL REFERENCES users(employee_id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'request_changes', 'reject')),
  comment TEXT,
  accepted_risk_summary TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (submission_id, revision_number)
    REFERENCES submission_revisions(submission_id, revision_number) ON DELETE RESTRICT,
  CHECK (decision IS 'approve' OR comment IS NOT NULL)
) STRICT;

CREATE INDEX reviews_submission_created ON reviews(submission_id, created_at DESC);
CREATE INDEX reviews_reviewer_created ON reviews(reviewer_employee_id, created_at DESC);

CREATE TABLE publish_jobs (
  id TEXT PRIMARY KEY,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('publish', 'catalog_rebuild')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'failed', 'completed')),
  target_revision TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT,
  error_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (kind IS NOT 'publish' OR submission_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX publish_jobs_active_submission
  ON publish_jobs(submission_id)
  WHERE submission_id IS NOT NULL AND status IN ('pending', 'running');
CREATE INDEX publish_jobs_queue ON publish_jobs(status, lease_expires_at, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_employee_id TEXT REFERENCES users(employee_id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX audit_events_created ON audit_events(created_at DESC, id);
CREATE INDEX audit_events_object ON audit_events(object_type, object_id, created_at DESC);
CREATE INDEX audit_events_actor ON audit_events(actor_employee_id, created_at DESC);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TABLE idempotency_keys (
  employee_id TEXT NOT NULL REFERENCES users(employee_id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (employee_id, route, idempotency_key),
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX idempotency_keys_expiry ON idempotency_keys(expires_at);
