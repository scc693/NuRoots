CREATE TABLE person_citations (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 180),
  locator TEXT NOT NULL CHECK(length(trim(locator)) BETWEEN 1 AND 400),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_person_citations ON person_citations(person_id, id);
