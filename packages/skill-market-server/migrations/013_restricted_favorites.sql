ALTER TABLE submissions ADD COLUMN withdrawn_artifacts_purged_at INTEGER;

CREATE TABLE skill_favorites_v13 (
  employee_id TEXT NOT NULL REFERENCES users(employee_id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('skillhub', 'enterprise', 'community', 'restricted')),
  skill_id TEXT NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (employee_id, source, skill_id)
) STRICT;

INSERT INTO skill_favorites_v13 (employee_id, source, skill_id, created_at)
SELECT employee_id, source, skill_id, created_at FROM skill_favorites;

DROP INDEX skill_favorites_employee_created;
DROP TABLE skill_favorites;
ALTER TABLE skill_favorites_v13 RENAME TO skill_favorites;

CREATE INDEX skill_favorites_employee_created
  ON skill_favorites(employee_id, created_at DESC, source, skill_id);
