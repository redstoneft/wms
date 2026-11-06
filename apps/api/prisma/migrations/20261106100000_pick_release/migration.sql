-- When an order is fully picked, its outbound pallets leave the rack positions (PICK_RELEASE: same LPN, same status,
-- new location). A plain move for wms_validate_movement (FROM and TO sides), so only the type list changes.

ALTER TABLE inventory_movements DROP CONSTRAINT ck_mov_type;
ALTER TABLE inventory_movements ADD CONSTRAINT ck_mov_type CHECK (movement_type IN
    ('RECEIPT','PUTAWAY','TRANSFER_START','TRANSFER_COMPLETE','TRANSFER_CANCEL','REPLENISH_START','REPLENISH_COMPLETE',
     'ALLOCATE','DEALLOCATE','PICK','UNPICK','STAGE','LOAD','UNLOAD','SHIP','ADJUST_IN','ADJUST_OUT',
     'COUNT_ADJUST_IN','COUNT_ADJUST_OUT','QUARANTINE_IN','QUARANTINE_OUT','DAMAGE','DAMAGE_RELEASE','BLOCK','UNBLOCK',
     'RETURN_RECEIPT','SCRAP','LPN_SPLIT','LPN_CONSOLIDATE','INITIAL_LOAD','ASSEMBLY_OUT','ASSEMBLY_IN','RECEIPT_UNDO','SHIP_UNDO',
     'PICK_RELEASE'));
