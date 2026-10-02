-- Each merma (damage) registered from the handheld, so the person who registered it can see it again and charge it
-- to the order it really belonged to (the order then re-plans the damaged pieces).
CREATE TABLE damage_reports (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users(id),
  username    varchar(64) NOT NULL,
  lpn_id      uuid NOT NULL REFERENCES lpns(id),
  lpn_code    varchar(30) NOT NULL,
  sku_id      uuid NOT NULL REFERENCES skus(id),
  qty         bigint NOT NULL CHECK (qty > 0),
  reason      varchar(300) NOT NULL,
  mode        varchar(10) NOT NULL, -- STORAGE | OUTBOUND
  order_id    uuid REFERENCES orders(id),
  linked_at   timestamptz,
  task_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_damage_reports_user ON damage_reports(user_id, created_at DESC);
