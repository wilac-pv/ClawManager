ALTER TABLE skillhub_import_items ADD COLUMN evaluation_state TEXT NOT NULL DEFAULT 'waiting'
  CHECK (evaluation_state IN ('waiting', 'pending', 'running', 'retry_wait', 'completed', 'failed'));
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (evaluation_attempts >= 0);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_next_attempt_at INTEGER;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_lease_owner TEXT;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_lease_expires_at INTEGER;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_trust REAL CHECK (evaluation_trust BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_reliability REAL CHECK (evaluation_reliability BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_adaptability REAL CHECK (evaluation_adaptability BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_convention REAL CHECK (evaluation_convention BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_effectiveness REAL CHECK (evaluation_effectiveness BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_score REAL CHECK (evaluation_score BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_checked_at INTEGER;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_error_summary TEXT CHECK (evaluation_error_summary IS NULL OR length(evaluation_error_summary) BETWEEN 1 AND 500);
UPDATE skillhub_import_items SET evaluation_state = 'pending' WHERE state = 'mirrored';
CREATE INDEX skillhub_evaluation_queue ON skillhub_import_items(evaluation_state, evaluation_next_attempt_at, evaluation_lease_expires_at, evaluation_checked_at, updated_at);
