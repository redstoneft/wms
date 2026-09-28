-- Product colour for the 3D map (pallets are drawn in the colour of what they hold). NULL = derived from the name/code.
ALTER TABLE skus ADD COLUMN color varchar(20);
