CREATE TABLE expert_packages (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  scene TEXT NOT NULL CHECK (length(scene) BETWEEN 1 AND 80),
  sub_scene TEXT,
  content TEXT NOT NULL,
  skill_slugs_json TEXT NOT NULL,
  skill_count INTEGER NOT NULL CHECK (skill_count >= 0),
  upstream_updated_at INTEGER NOT NULL,
  synchronized_at INTEGER NOT NULL
) STRICT;

CREATE INDEX expert_packages_scene_updated
  ON expert_packages(scene, upstream_updated_at DESC, slug);

CREATE TABLE skill_favorites (
  employee_id TEXT NOT NULL REFERENCES users(employee_id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('skillhub', 'enterprise', 'community')),
  skill_id TEXT NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (employee_id, source, skill_id)
) STRICT;

CREATE INDEX skill_favorites_employee_created
  ON skill_favorites(employee_id, created_at DESC, source, skill_id);
