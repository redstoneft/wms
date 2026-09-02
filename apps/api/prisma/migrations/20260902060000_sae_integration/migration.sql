-- Aspel SAE integration: external references on master data + sync run log
ALTER TABLE skus ADD COLUMN external_source VARCHAR(20), ADD COLUMN external_ref VARCHAR(64), ADD COLUMN model_code VARCHAR(64), ADD COLUMN packaging_layer VARCHAR(10);
CREATE INDEX idx_skus_external ON skus (external_source, external_ref);
CREATE INDEX idx_skus_model ON skus (model_code);
ALTER TABLE customers ADD COLUMN external_source VARCHAR(20), ADD COLUMN external_ref VARCHAR(64);
ALTER TABLE suppliers ADD COLUMN external_source VARCHAR(20), ADD COLUMN external_ref VARCHAR(64);
ALTER TABLE purchase_orders ADD COLUMN external_source VARCHAR(20), ADD COLUMN external_ref VARCHAR(64);
CREATE INDEX idx_po_external ON purchase_orders (external_source, external_ref);

CREATE TABLE integration_runs (
  id            UUID PRIMARY KEY DEFAULT uuidv7(),
  source        VARCHAR(20) NOT NULL,
  entity        VARCHAR(30) NOT NULL,
  trigger       VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
  status        VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  source_rows   INT NOT NULL DEFAULT 0,
  created       INT NOT NULL DEFAULT 0,
  updated       INT NOT NULL DEFAULT 0,
  skipped       INT NOT NULL DEFAULT 0,
  errors        JSONB,
  notes         TEXT,
  user_id       UUID
);
CREATE INDEX idx_integration_runs_entity ON integration_runs (source, entity, started_at DESC);
