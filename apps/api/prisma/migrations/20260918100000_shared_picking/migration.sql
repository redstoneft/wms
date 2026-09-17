-- Shared picking: several pickers work the same order at once; each line remembers who is on it.
ALTER TABLE pick_task_lines ADD COLUMN picker_id uuid;
CREATE INDEX pick_task_lines_picker_idx ON pick_task_lines (picker_id) WHERE picker_id IS NOT NULL;
