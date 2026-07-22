ALTER TABLE submissions ADD COLUMN target_scope TEXT NOT NULL DEFAULT 'company'
  CHECK (target_scope IN ('company', 'personal'));

DROP INDEX submissions_active_skill_version;

CREATE UNIQUE INDEX submissions_active_company_skill_version
  ON submissions(skill_id, target_version)
  WHERE target_scope = 'company'
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE UNIQUE INDEX submissions_active_personal_skill_version
  ON submissions(owner_employee_id, skill_id, target_version)
  WHERE target_scope = 'personal'
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE INDEX submissions_owner_target_updated
  ON submissions(owner_employee_id, target_scope, updated_at DESC, id DESC);
