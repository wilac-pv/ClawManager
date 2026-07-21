CREATE TABLE skillhub_deferred_import_items (
  slug TEXT PRIMARY KEY REFERENCES skillhub_import_items(slug) ON DELETE CASCADE,
  upstream_version TEXT NOT NULL,
  upstream_updated_at INTEGER NOT NULL,
  list_json TEXT NOT NULL CHECK (json_valid(list_json)),
  deferred_at INTEGER NOT NULL
) STRICT;

CREATE INDEX skillhub_deferred_imports ON skillhub_deferred_import_items(deferred_at, slug);
