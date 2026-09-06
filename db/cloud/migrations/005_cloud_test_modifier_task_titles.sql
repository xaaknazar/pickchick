-- Retain the complete chosen composition in synthetic kitchen tasks. Existing
-- orders and immutable quote snapshots are not rewritten by this rollout.
ALTER TABLE test_kitchen_tasks DROP CONSTRAINT test_kitchen_tasks_title_check;
ALTER TABLE test_kitchen_tasks ADD CONSTRAINT test_kitchen_tasks_title_check
  CHECK(length(title) BETWEEN 1 AND 4000);
