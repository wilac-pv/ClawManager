PRAGMA defer_foreign_keys = ON;

DROP TRIGGER submissions_audience_no_update;
DROP TRIGGER submission_group_targets_valid_insert;
DROP TRIGGER submission_group_targets_no_update;
DROP TRIGGER submission_group_targets_no_delete;
DROP TRIGGER submissions_audience_valid_transition;

DROP INDEX submissions_active_company_skill_version;
DROP INDEX submissions_active_personal_skill_version;
DROP INDEX submissions_active_restricted_skill_version;
DROP INDEX submissions_owner_target_updated;
DROP INDEX submissions_owner_updated;
DROP INDEX submissions_status_updated;
DROP INDEX submissions_active_audience_change_source;

CREATE TEMP TABLE submission_group_targets_v12 AS SELECT * FROM submission_group_targets;
CREATE TEMP TABLE submission_revisions_v12 AS SELECT * FROM submission_revisions;
CREATE TEMP TABLE reviews_v12 AS SELECT * FROM reviews;
CREATE TEMP TABLE publish_jobs_v12 AS SELECT * FROM publish_jobs;
CREATE TEMP TABLE community_skills_v12 AS
  SELECT skill_id, current_submission_id FROM community_skills WHERE current_submission_id IS NOT NULL;

CREATE TABLE submissions_v12 (
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
      'published',
      'withdrawn'
    )
  ),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  user_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  target_scope TEXT NOT NULL DEFAULT 'company'
    CHECK (target_scope IN ('company', 'personal', 'groups', 'department')),
  target_department_id TEXT REFERENCES departments(department_id),
  source_publication_id TEXT REFERENCES restricted_publications(id),
  deleted_at INTEGER,
  purge_after INTEGER,
  artifacts_purge_token TEXT,
  artifacts_purge_claimed_at INTEGER,
  artifacts_purged_at INTEGER,
  CHECK (updated_at >= created_at),
  CHECK (
    (deleted_at IS NULL AND purge_after IS NULL AND artifacts_purge_token IS NULL
      AND artifacts_purge_claimed_at IS NULL AND artifacts_purged_at IS NULL) OR
    (target_scope = 'personal' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after > deleted_at
      AND (artifacts_purged_at IS NULL OR artifacts_purged_at >= purge_after)
      AND ((artifacts_purge_token IS NULL AND artifacts_purge_claimed_at IS NULL)
        OR (artifacts_purged_at IS NULL AND artifacts_purge_token IS NOT NULL AND artifacts_purge_claimed_at IS NOT NULL)))
  )
) STRICT;

INSERT INTO submissions_v12 (
  id,
  skill_id,
  owner_employee_id,
  target_version,
  status,
  current_revision,
  version,
  user_message,
  created_at,
  updated_at,
  target_scope,
  target_department_id,
  source_publication_id
)
SELECT
  id,
  skill_id,
  owner_employee_id,
  target_version,
  status,
  current_revision,
  version,
  user_message,
  created_at,
  updated_at,
  target_scope,
  target_department_id,
  source_publication_id
FROM submissions;

DROP TABLE submissions;
ALTER TABLE submissions_v12 RENAME TO submissions;

INSERT INTO submission_group_targets SELECT * FROM submission_group_targets_v12;
INSERT INTO submission_revisions SELECT * FROM submission_revisions_v12;
INSERT INTO reviews SELECT * FROM reviews_v12;
INSERT INTO publish_jobs SELECT * FROM publish_jobs_v12;
UPDATE community_skills
SET current_submission_id = (
  SELECT community_skills_v12.current_submission_id
  FROM community_skills_v12
  WHERE community_skills_v12.skill_id = community_skills.skill_id
)
WHERE skill_id IN (SELECT skill_id FROM community_skills_v12);

CREATE UNIQUE INDEX submissions_active_company_skill_version
  ON submissions(skill_id, target_version)
  WHERE target_scope = 'company'
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE UNIQUE INDEX submissions_active_personal_skill_version
  ON submissions(owner_employee_id, skill_id, target_version)
  WHERE target_scope = 'personal'
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE UNIQUE INDEX submissions_active_restricted_skill_version
  ON submissions(owner_employee_id, skill_id, target_version)
  WHERE target_scope IN ('groups', 'department')
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE INDEX submissions_owner_updated ON submissions(owner_employee_id, updated_at DESC);
CREATE INDEX submissions_status_updated ON submissions(status, updated_at);
CREATE INDEX submissions_owner_target_updated
  ON submissions(owner_employee_id, target_scope, updated_at DESC, id DESC);
CREATE INDEX submissions_personal_trash
  ON submissions(owner_employee_id, purge_after, id)
  WHERE target_scope = 'personal' AND deleted_at IS NOT NULL;

CREATE UNIQUE INDEX submissions_active_audience_change_source
  ON submissions(source_publication_id)
  WHERE source_publication_id IS NOT NULL
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE TRIGGER submissions_audience_no_update
BEFORE UPDATE OF target_scope, target_department_id, source_publication_id ON submissions
WHEN NEW.target_scope IS NOT OLD.target_scope
  OR NEW.target_department_id IS NOT OLD.target_department_id
  OR NEW.source_publication_id IS NOT OLD.source_publication_id
BEGIN
  SELECT RAISE(ABORT, 'submission audience is immutable');
END;

CREATE TRIGGER submission_group_targets_valid_insert
BEFORE INSERT ON submission_group_targets
WHEN NOT EXISTS (
  SELECT 1 FROM submissions
  WHERE submissions.id = NEW.submission_id
    AND submissions.target_scope = 'groups'
    AND submissions.target_department_id IS NULL
    AND submissions.status = 'validating'
)
BEGIN
  SELECT RAISE(ABORT, 'submission group targets require a validating group submission');
END;

CREATE TRIGGER submission_group_targets_no_update
BEFORE UPDATE ON submission_group_targets
BEGIN
  SELECT RAISE(ABORT, 'submission audience is immutable');
END;

CREATE TRIGGER submission_group_targets_no_delete
BEFORE DELETE ON submission_group_targets
BEGIN
  SELECT RAISE(ABORT, 'submission audience is immutable');
END;

CREATE TRIGGER submissions_audience_valid_transition
BEFORE UPDATE OF status ON submissions
WHEN NEW.status != 'validating'
  AND (
    (NEW.target_scope IN ('personal', 'company') AND (
      NEW.target_department_id IS NOT NULL OR
      EXISTS (SELECT 1 FROM submission_group_targets WHERE submission_id = NEW.id)
    )) OR
    (NEW.target_scope = 'department' AND (
      NEW.target_department_id IS NULL OR
      EXISTS (SELECT 1 FROM submission_group_targets WHERE submission_id = NEW.id)
    )) OR
    (NEW.target_scope = 'groups' AND (
      NEW.target_department_id IS NOT NULL OR
      NOT EXISTS (SELECT 1 FROM submission_group_targets WHERE submission_id = NEW.id)
    ))
  )
BEGIN
  SELECT RAISE(ABORT, 'submission audience is incomplete');
END;

CREATE TABLE delist_requests (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  requested_by_employee_id TEXT NOT NULL REFERENCES users(employee_id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  decided_by_employee_id TEXT REFERENCES users(employee_id),
  decided_at INTEGER,
  CHECK (
    (status = 'pending' AND decided_by_employee_id IS NULL AND decided_at IS NULL) OR
    (status IN ('approved', 'rejected') AND decided_by_employee_id IS NOT NULL AND decided_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX delist_requests_pending_submission
  ON delist_requests(submission_id)
  WHERE status = 'pending';
