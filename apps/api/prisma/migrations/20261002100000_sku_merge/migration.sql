-- A SKU that turned out to be the same product as another one is merged into it: it stays as a pointer so that every
-- lookup (SAE key, barcode, code) lands on the surviving SKU and the SAE sync never resurrects the duplicate.
ALTER TABLE skus ADD COLUMN merged_into_id uuid REFERENCES skus(id);
CREATE INDEX idx_skus_merged_into ON skus(merged_into_id) WHERE merged_into_id IS NOT NULL;
