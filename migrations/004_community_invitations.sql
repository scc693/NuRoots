CREATE TABLE community_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  proposer_id TEXT NOT NULL REFERENCES members(id),
  reviewer_id TEXT REFERENCES members(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','revoked','accepted','expired')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_community_open_invitation ON community_invitations(community_id, recipient_id)
WHERE state IN ('pending','approved');
CREATE INDEX idx_community_invitation_review ON community_invitations(community_id,state,created_at,id);
CREATE INDEX idx_community_invitation_recipient ON community_invitations(recipient_id,state,expires_at);
