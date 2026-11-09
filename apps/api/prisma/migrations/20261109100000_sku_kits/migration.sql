-- Sets and batteries: a finished SKU made of N pieces of each component SKU (used by the assembly to balance consumed vs produced).
CREATE TABLE sku_kit_components (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kit_sku_id uuid NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  component_sku_id uuid NOT NULL REFERENCES skus(id),
  qty_per_kit bigint NOT NULL CHECK (qty_per_kit > 0),
  CONSTRAINT sku_kit_components_kit_sku_id_component_sku_id_key UNIQUE (kit_sku_id, component_sku_id),
  CONSTRAINT sku_kit_components_not_self CHECK (kit_sku_id <> component_sku_id)
);
CREATE INDEX sku_kit_components_component_sku_id_idx ON sku_kit_components(component_sku_id);

-- an assembly whose output is a kit is recorded as such
ALTER TABLE assembly_orders DROP CONSTRAINT ck_assembly_mode;
ALTER TABLE assembly_orders ADD CONSTRAINT ck_assembly_mode CHECK (mode IN ('ASSEMBLY','REPACK','KIT'));
