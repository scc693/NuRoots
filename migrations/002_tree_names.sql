-- Version existing names without copying or rewriting people.
ALTER TABLE people ADD COLUMN name_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_name_history ON change_log(entity_id, entity_type, action);

CREATE INDEX idx_deceased_names ON people(given_name COLLATE NOCASE, family_name COLLATE NOCASE, id)
WHERE living = 0;
