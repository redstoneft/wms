-- Rack bridges: a beam spanning a walkway between two bays, with pallet positions only on the upper level(s).
-- Stored as JSON on the rack: [{ after_bay, width_m, levels, positions, code }]. Bays after the bridge shift by width_m.
ALTER TABLE racks ADD COLUMN bridges jsonb;
