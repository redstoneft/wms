-- One WMS SKU per physical product: the GTIN is the product identity when known.
-- SAE keys (packaging variants, customer item numbers) live in sku_barcodes as aliases.
ALTER TABLE "skus" ADD COLUMN "gtin" VARCHAR(14);
CREATE UNIQUE INDEX "skus_gtin_key" ON "skus"("gtin");
ALTER TABLE "skus" ADD CONSTRAINT "ck_sku_gtin_format" CHECK (gtin IS NULL OR gtin ~ '^[0-9]{8,14}$');
