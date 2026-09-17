-- Free picking: an order built on the handheld by scanning pallets over time (different moments/days), closed explicitly.
ALTER TABLE pick_tasks ADD COLUMN mode varchar(10) NOT NULL DEFAULT 'ALLOCATED';
ALTER TABLE pick_tasks ADD CONSTRAINT ck_pick_task_mode CHECK (mode IN ('ALLOCATED','FREE'));
