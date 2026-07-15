ALTER TABLE submission_revisions
ADD COLUMN private_icon_json TEXT
CHECK (private_icon_json IS NULL OR json_valid(private_icon_json));
