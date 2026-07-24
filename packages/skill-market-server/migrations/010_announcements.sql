CREATE TABLE announcements (
  id TEXT PRIMARY KEY CHECK (id GLOB 'ann_[a-zA-Z0-9_-]*' AND length(id) BETWEEN 12 AND 68),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  published_by_employee_id TEXT REFERENCES users(employee_id) ON DELETE SET NULL,
  published_at INTEGER NOT NULL
) STRICT;

CREATE INDEX announcements_published ON announcements(published_at DESC, id DESC);

CREATE TRIGGER announcements_no_update
BEFORE UPDATE ON announcements
BEGIN
  SELECT RAISE(ABORT, 'announcements are append-only');
END;

CREATE TRIGGER announcements_no_delete
BEFORE DELETE ON announcements
BEGIN
  SELECT RAISE(ABORT, 'announcements are append-only');
END;
