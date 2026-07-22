CREATE TABLE departments (
  department_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (length(department_id) BETWEEN 1 AND 128),
  CHECK (length(display_name) BETWEEN 1 AND 100),
  CHECK (first_seen_at <= last_seen_at)
);

CREATE INDEX departments_last_seen ON departments(last_seen_at DESC, department_id);

ALTER TABLE users ADD COLUMN department_id TEXT REFERENCES departments(department_id);
CREATE INDEX users_department ON users(department_id, employee_id);
