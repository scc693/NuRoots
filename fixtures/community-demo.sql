-- Additional memberships for the disposable three-account preview.
INSERT INTO communities(id,kind,name) VALUES
  ('sample-bennett','branch','Bennett family'),
  ('sample-quilters','circle','Family Quilters')
ON CONFLICT(id) DO NOTHING;

INSERT INTO community_memberships(community_id,member_id,role)
SELECT 'sample-bennett',id,CASE email WHEN 'editor@example.test' THEN 'steward' ELSE 'member' END
FROM members WHERE email IN ('editor@example.test','viewer@example.test')
ON CONFLICT(community_id,member_id) DO NOTHING;

INSERT INTO community_memberships(community_id,member_id,role)
SELECT 'sample-quilters',id,CASE email WHEN 'viewer@example.test' THEN 'steward' ELSE 'member' END
FROM members WHERE email IN ('owner@example.test','viewer@example.test')
ON CONFLICT(community_id,member_id) DO NOTHING;
