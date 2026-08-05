CREATE TABLE market_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  owner_employee_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE market_group_members (
  group_id TEXT NOT NULL REFERENCES market_groups(id),
  employee_id TEXT NOT NULL,
  added_by_employee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, employee_id)
) STRICT;

CREATE INDEX market_group_members_employee ON market_group_members(employee_id, group_id);

ALTER TABLE submissions ADD COLUMN target_scope_v11 TEXT;
UPDATE submissions SET target_scope_v11 = target_scope;

DROP INDEX submissions_active_company_skill_version;
DROP INDEX submissions_active_personal_skill_version;
DROP INDEX submissions_owner_target_updated;

ALTER TABLE submissions DROP COLUMN target_scope;
ALTER TABLE submissions ADD COLUMN target_scope TEXT NOT NULL DEFAULT 'company'
  CHECK (target_scope IN ('company', 'personal', 'groups', 'department'));
UPDATE submissions SET target_scope = target_scope_v11;
ALTER TABLE submissions DROP COLUMN target_scope_v11;

ALTER TABLE submissions ADD COLUMN target_department_id TEXT REFERENCES departments(department_id);

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

CREATE INDEX submissions_owner_target_updated
  ON submissions(owner_employee_id, target_scope, updated_at DESC, id DESC);

CREATE TABLE submission_group_targets (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES market_groups(id),
  PRIMARY KEY (submission_id, group_id)
) STRICT;

CREATE INDEX submission_group_targets_group ON submission_group_targets(group_id, submission_id);

CREATE TABLE restricted_publications (
  id TEXT PRIMARY KEY CHECK (id GLOB 'pub_[a-zA-Z0-9_-]*' AND length(id) BETWEEN 12 AND 68),
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  skill_id TEXT NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 128),
  owner_employee_id TEXT NOT NULL REFERENCES users(employee_id),
  version TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('groups', 'department')),
  department_id TEXT REFERENCES departments(department_id),
  package_key TEXT NOT NULL CHECK (length(package_key) > 0 AND instr(package_key, '://') = 0),
  package_sha256 TEXT NOT NULL CHECK (length(package_sha256) = 64),
  package_size INTEGER NOT NULL CHECK (package_size > 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  status TEXT NOT NULL CHECK (status IN ('published', 'delisted')),
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK ((scope = 'department') = (department_id IS NOT NULL))
) STRICT;

CREATE INDEX restricted_publications_owner
  ON restricted_publications(owner_employee_id, status, updated_at DESC, id);
CREATE INDEX restricted_publications_department
  ON restricted_publications(department_id, status, updated_at DESC, id)
  WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX restricted_publications_live_owner_skill_version
  ON restricted_publications(owner_employee_id, skill_id, version)
  WHERE status = 'published';

CREATE TABLE restricted_publication_groups (
  publication_id TEXT NOT NULL REFERENCES restricted_publications(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES market_groups(id),
  PRIMARY KEY (publication_id, group_id)
) STRICT;

CREATE INDEX restricted_publication_groups_group
  ON restricted_publication_groups(group_id, publication_id);

ALTER TABLE submissions ADD COLUMN source_publication_id TEXT REFERENCES restricted_publications(id);

ALTER TABLE reviews ADD COLUMN approved_package_key TEXT;
ALTER TABLE reviews ADD COLUMN approved_package_sha256 TEXT
  CHECK (approved_package_sha256 IS NULL OR length(approved_package_sha256) = 64);
ALTER TABLE reviews ADD COLUMN approved_package_size INTEGER
  CHECK (approved_package_size IS NULL OR approved_package_size > 0);
ALTER TABLE reviews ADD COLUMN approved_metadata_json TEXT
  CHECK (approved_metadata_json IS NULL OR json_valid(approved_metadata_json));

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
