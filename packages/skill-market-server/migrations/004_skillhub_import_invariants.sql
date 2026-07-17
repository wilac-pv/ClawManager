CREATE TEMP TABLE skillhub_active_generation_survivor (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('running', 'paused'))
) STRICT;

INSERT INTO skillhub_active_generation_survivor (id, state)
SELECT
  id,
  CASE
    WHEN EXISTS (SELECT 1 FROM skillhub_generations WHERE state = 'running') THEN 'running'
    ELSE 'paused'
  END
FROM skillhub_generations
WHERE state IN ('running', 'paused')
ORDER BY started_at, rowid
LIMIT 1;

CREATE TABLE skillhub_generations_v4 (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'completed', 'failed')),
  upstream_total INTEGER NOT NULL CHECK (upstream_total >= 0),
  discovery_page INTEGER NOT NULL DEFAULT 0 CHECK (discovery_page >= 0),
  sweep INTEGER NOT NULL DEFAULT 0 CHECK (sweep >= 0),
  new_in_sweep INTEGER NOT NULL DEFAULT 0 CHECK (new_in_sweep >= 0),
  last_published_count INTEGER NOT NULL DEFAULT 0 CHECK (last_published_count >= 0),
  last_published_at INTEGER,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
  recent_error_code TEXT,
  recent_error_summary TEXT,
  recent_error_at INTEGER,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  discovery_completed_at INTEGER,
  completed_at INTEGER,
  CHECK (updated_at >= started_at),
  CHECK (discovery_completed_at IS NULL OR discovery_completed_at >= started_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR discovery_completed_at IS NOT NULL),
  CHECK (recent_error_code IS NULL OR recent_error_code IN ('upstream', 'download', 'validation', 'storage', 'rate_limited')),
  CHECK (recent_error_summary IS NULL OR length(recent_error_summary) BETWEEN 1 AND 500),
  CHECK (
    (recent_error_code IS NULL AND recent_error_summary IS NULL AND recent_error_at IS NULL) OR
    (recent_error_code IS NOT NULL AND recent_error_summary IS NOT NULL AND recent_error_at IS NOT NULL)
  )
) STRICT;

INSERT INTO skillhub_generations_v4 (
  id,
  state,
  upstream_total,
  discovery_page,
  sweep,
  new_in_sweep,
  last_published_count,
  last_published_at,
  uploaded_bytes,
  recent_error_code,
  recent_error_summary,
  recent_error_at,
  started_at,
  updated_at,
  discovery_completed_at,
  completed_at
)
SELECT
  generation.id,
  CASE
    WHEN generation.state NOT IN ('running', 'paused') THEN generation.state
    WHEN generation.id = (SELECT id FROM skillhub_active_generation_survivor) THEN
      (SELECT state FROM skillhub_active_generation_survivor)
    ELSE 'failed'
  END,
  generation.upstream_total,
  generation.discovery_page,
  generation.sweep,
  generation.new_in_sweep,
  CASE
    WHEN generation.id = (SELECT id FROM skillhub_active_generation_survivor) THEN
      (SELECT MAX(last_published_count) FROM skillhub_generations WHERE state IN ('running', 'paused'))
    ELSE generation.last_published_count
  END,
  CASE
    WHEN generation.id = (SELECT id FROM skillhub_active_generation_survivor) THEN
      (SELECT MAX(last_published_at) FROM skillhub_generations WHERE state IN ('running', 'paused'))
    ELSE generation.last_published_at
  END,
  generation.uploaded_bytes,
  CASE
    WHEN generation.recent_error_code IS NULL AND generation.recent_error_summary IS NULL AND generation.recent_error_at IS NULL THEN NULL
    WHEN generation.recent_error_code IN ('upstream', 'download', 'validation', 'storage', 'rate_limited') THEN generation.recent_error_code
    ELSE 'upstream'
  END,
  CASE
    WHEN generation.recent_error_code IS NULL AND generation.recent_error_summary IS NULL AND generation.recent_error_at IS NULL THEN NULL
    WHEN length(trim(COALESCE(generation.recent_error_summary, ''))) > 0 THEN substr(generation.recent_error_summary, 1, 500)
    ELSE 'Migrated SkillHub import error'
  END,
  CASE
    WHEN generation.recent_error_code IS NULL AND generation.recent_error_summary IS NULL AND generation.recent_error_at IS NULL THEN NULL
    ELSE COALESCE(generation.recent_error_at, generation.updated_at)
  END,
  generation.started_at,
  generation.updated_at,
  CASE
    WHEN generation.state = 'completed' THEN COALESCE(generation.completed_at, generation.updated_at)
    ELSE generation.completed_at
  END,
  CASE
    WHEN generation.state = 'completed' THEN COALESCE(generation.completed_at, generation.updated_at)
    ELSE NULL
  END
FROM skillhub_generations AS generation;

CREATE TABLE skillhub_import_items_v4 (
  slug TEXT PRIMARY KEY CHECK (length(slug) BETWEEN 1 AND 256),
  generation_id TEXT NOT NULL REFERENCES skillhub_generations_v4(id),
  upstream_version TEXT NOT NULL,
  upstream_updated_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'mirrored', 'retry_wait', 'rejected')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  list_json TEXT NOT NULL CHECK (json_valid(list_json)),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  detail_key TEXT,
  detail_sha256 TEXT CHECK (detail_sha256 IS NULL OR length(detail_sha256) = 64),
  original_package_sha256 TEXT CHECK (original_package_sha256 IS NULL OR length(original_package_sha256) = 64),
  package_sha256 TEXT CHECK (package_sha256 IS NULL OR length(package_sha256) = 64),
  package_size INTEGER CHECK (package_size IS NULL OR package_size > 0),
  repair_json TEXT CHECK (repair_json IS NULL OR json_valid(repair_json)),
  error_code TEXT,
  error_summary TEXT,
  mirrored_at INTEGER,
  last_seen_generation TEXT NOT NULL,
  last_seen_sweep INTEGER NOT NULL DEFAULT 0 CHECK (last_seen_sweep >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'retry_wait') = (next_attempt_at IS NOT NULL)),
  CHECK (error_code IS NULL OR error_code IN ('upstream', 'download', 'validation', 'storage', 'rate_limited')),
  CHECK ((error_code IS NULL) = (error_summary IS NULL)),
  CHECK (error_summary IS NULL OR length(error_summary) BETWEEN 1 AND 500),
  CHECK (state NOT IN ('retry_wait', 'rejected') OR error_code IS NOT NULL),
  CHECK (state != 'mirrored' OR (summary_json IS NOT NULL AND detail_key IS NOT NULL AND detail_sha256 IS NOT NULL)),
  CHECK ((state = 'mirrored') = (mirrored_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
) STRICT;

INSERT INTO skillhub_import_items_v4 (
  slug,
  generation_id,
  upstream_version,
  upstream_updated_at,
  state,
  attempts,
  next_attempt_at,
  lease_owner,
  lease_expires_at,
  list_json,
  record_json,
  summary_json,
  detail_key,
  detail_sha256,
  original_package_sha256,
  package_sha256,
  package_size,
  repair_json,
  error_code,
  error_summary,
  mirrored_at,
  last_seen_generation,
  last_seen_sweep,
  created_at,
  updated_at
)
SELECT
  slug,
  CASE
    WHEN generation_id IN (
      SELECT id FROM skillhub_generations WHERE state IN ('running', 'paused')
    ) THEN (SELECT id FROM skillhub_active_generation_survivor)
    ELSE generation_id
  END,
  upstream_version,
  upstream_updated_at,
  CASE
    WHEN state = 'running' AND (lease_owner IS NULL OR lease_expires_at IS NULL) THEN 'pending'
    WHEN state = 'mirrored' AND (summary_json IS NULL OR detail_key IS NULL OR detail_sha256 IS NULL) THEN 'pending'
    ELSE state
  END,
  attempts,
  CASE WHEN state = 'retry_wait' THEN COALESCE(next_attempt_at, updated_at) ELSE NULL END,
  CASE WHEN state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL THEN lease_owner ELSE NULL END,
  CASE WHEN state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL THEN lease_expires_at ELSE NULL END,
  list_json,
  record_json,
  summary_json,
  detail_key,
  detail_sha256,
  original_package_sha256,
  package_sha256,
  package_size,
  repair_json,
  CASE
    WHEN state NOT IN ('retry_wait', 'rejected') THEN NULL
    WHEN error_code IN ('upstream', 'download', 'validation', 'storage', 'rate_limited') THEN error_code
    ELSE 'upstream'
  END,
  CASE
    WHEN state NOT IN ('retry_wait', 'rejected') THEN NULL
    WHEN length(trim(COALESCE(error_summary, ''))) > 0 THEN substr(error_summary, 1, 500)
    ELSE 'Migrated SkillHub import error'
  END,
  CASE
    WHEN state = 'mirrored' AND summary_json IS NOT NULL AND detail_key IS NOT NULL AND detail_sha256 IS NOT NULL
      THEN updated_at
    ELSE NULL
  END,
  last_seen_generation,
  last_seen_sweep,
  created_at,
  updated_at
FROM skillhub_import_items;

DROP TABLE skillhub_import_items;
DROP TABLE skillhub_generations;
ALTER TABLE skillhub_generations_v4 RENAME TO skillhub_generations;
ALTER TABLE skillhub_import_items_v4 RENAME TO skillhub_import_items;

CREATE UNIQUE INDEX skillhub_single_unsettled_generation ON skillhub_generations((1)) WHERE state IN ('running', 'paused');
CREATE INDEX skillhub_import_queue ON skillhub_import_items(state, next_attempt_at, lease_expires_at, updated_at);
CREATE INDEX skillhub_import_generation ON skillhub_import_items(last_seen_generation, state);
CREATE INDEX skillhub_import_detail ON skillhub_import_items(detail_key) WHERE detail_key IS NOT NULL;

DROP TABLE skillhub_active_generation_survivor;
