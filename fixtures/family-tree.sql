INSERT INTO people (id, given_name, family_name, birth_date, biography, living)
VALUES
  ('fictional-deceased', 'Eleanor', 'Bennett', '1938-05-24', 'Private test biography', 0),
  ('fictional-parent', 'Rose', 'Harlow', NULL, NULL, 0),
  ('fictional-grandparent', 'Clara', 'Harlow', NULL, NULL, 0),
  ('fictional-partner', 'George', 'Bennett', NULL, NULL, 0),
  ('fictional-child', 'Margaret', 'Bennett', NULL, NULL, 0),
  ('fictional-living', 'Alex', 'Bennett', '1991-02-03', 'Private living record', 1)
ON CONFLICT(id) DO NOTHING;

-- A parent edge stores the parent first and the child second.
INSERT INTO relationships (id, person1_id, person2_id, type)
VALUES
  ('fictional-edge-1', 'fictional-parent', 'fictional-deceased', 'parent'),
  ('fictional-edge-2', 'fictional-grandparent', 'fictional-parent', 'parent'),
  ('fictional-edge-3', 'fictional-partner', 'fictional-deceased', 'partner'),
  ('fictional-edge-4', 'fictional-deceased', 'fictional-child', 'parent'),
  ('fictional-edge-5', 'fictional-deceased', 'fictional-living', 'parent')
ON CONFLICT DO NOTHING;
