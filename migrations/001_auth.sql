-- Existing members remain the identity and role source. Add new sign-in methods separately.
CREATE TABLE IF NOT EXISTS auth_passwords (
  member_id TEXT PRIMARY KEY NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_member ON auth_sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_invites (
  email TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_invites_expiry ON auth_invites(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts > 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_expiry ON auth_attempts(expires_at);
