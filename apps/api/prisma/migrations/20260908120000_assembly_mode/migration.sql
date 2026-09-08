-- REPACK: input and output are the same SKU (bodies and assembled pans share the SAE key); only packaging and pallet count change.
ALTER TABLE assembly_orders ADD COLUMN mode varchar(10) NOT NULL DEFAULT 'ASSEMBLY';
ALTER TABLE assembly_orders ADD CONSTRAINT ck_assembly_mode CHECK (mode IN ('ASSEMBLY','REPACK'));
