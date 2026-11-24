-- Run after creating the local owner. Give only the fictional preview branch membership.
INSERT INTO communities(id, kind, name) VALUES ('sample-harlow', 'branch', 'Harlow family')
ON CONFLICT(id) DO NOTHING;
INSERT INTO community_memberships(community_id, member_id, role)
SELECT 'sample-harlow', id, 'steward' FROM members WHERE role = 'owner'
ON CONFLICT(community_id, member_id) DO NOTHING;
