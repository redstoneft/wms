-- Building geometry from the topographic survey (columns, openings, neighbours, yard, north) and the default warehouse for the 3D map.
ALTER TABLE "warehouses" ADD COLUMN "features" JSONB;
ALTER TABLE "warehouses" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "warehouses_one_default" ON "warehouses"((is_default)) WHERE is_default;
