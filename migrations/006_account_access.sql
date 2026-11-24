ALTER TABLE members ADD COLUMN suspended_at INTEGER;
ALTER TABLE members ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;

-- Enforce revocation even when an older Worker is still serving requests.
CREATE TRIGGER suspend_account_sessions AFTER UPDATE OF suspended_at ON members
WHEN NEW.suspended_at IS NOT NULL
BEGIN
  DELETE FROM auth_sessions WHERE member_id = NEW.id;
END;

CREATE TRIGGER require_active_account BEFORE INSERT ON auth_sessions
WHEN EXISTS (SELECT 1 FROM members WHERE id = NEW.member_id AND suspended_at IS NOT NULL)
BEGIN
  SELECT RAISE(IGNORE);
END;
