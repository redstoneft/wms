-- A SKU name edited by hand in the WMS must survive the SAE sync (which otherwise rewrites descriptions every run).
ALTER TABLE skus ADD COLUMN description_locked boolean NOT NULL DEFAULT false;
