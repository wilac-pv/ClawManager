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
