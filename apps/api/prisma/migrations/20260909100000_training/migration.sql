-- Guided training (capacitación obligatoria en modo almacén): one row per user and step.
CREATE TABLE training_progress (
  user_id      uuid NOT NULL,
  step         varchar(20) NOT NULL,
  status       varchar(20) NOT NULL DEFAULT 'PENDING', -- PENDING | COMPLETED
  prepared     jsonb,
  prepared_at  timestamptz(6),
  completed_at timestamptz(6),
  evidence     jsonb,
  attempts     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, step)
);
ALTER TABLE users ADD COLUMN training_completed_at timestamptz(6);
ALTER TABLE users ADD COLUMN training_completed_by uuid;
