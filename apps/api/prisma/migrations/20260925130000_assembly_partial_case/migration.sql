-- Assembly outputs: a pallet may end with one incomplete case (59 full cases + 1 case of 10) and defective pieces
-- found while assembling that pallet.
ALTER TABLE assembly_outputs
  ADD COLUMN IF NOT EXISTS partial_pieces integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS defective_qty  bigint  NOT NULL DEFAULT 0;
