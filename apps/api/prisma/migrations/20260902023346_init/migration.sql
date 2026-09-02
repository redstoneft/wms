-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "username" VARCHAR(64) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(254),
    "password_hash" VARCHAR(512) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_enc" VARCHAR(512),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(80) NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token_hash" VARCHAR(128) NOT NULL,
    "user_id" UUID NOT NULL,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "device_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID,
    "username" VARCHAR(64),
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" VARCHAR(64),
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" VARCHAR(64),
    "device_id" VARCHAR(128),
    "request_id" VARCHAR(64),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "scope_key" VARCHAR(256) NOT NULL,
    "user_id" UUID NOT NULL,
    "fingerprint" VARCHAR(128) NOT NULL,
    "response_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope_key")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "authorizations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "exception_type" VARCHAR(60) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "requested_by" UUID NOT NULL,
    "supervisor_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "address" TEXT,
    "width_m" DECIMAL(8,2) NOT NULL DEFAULT 60,
    "depth_m" DECIMAL(8,2) NOT NULL DEFAULT 40,
    "height_m" DECIMAL(8,2) NOT NULL DEFAULT 10,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "warehouse_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "zone_type" VARCHAR(30) NOT NULL,
    "color" VARCHAR(16),
    "x_m" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "y_m" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "width_m" DECIMAL(8,2) NOT NULL DEFAULT 10,
    "depth_m" DECIMAL(8,2) NOT NULL DEFAULT 10,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aisles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "zone_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120),

    CONSTRAINT "aisles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "racks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "aisle_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "bays" INTEGER NOT NULL DEFAULT 1,
    "levels" INTEGER NOT NULL DEFAULT 1,
    "positions_per_bay" INTEGER NOT NULL DEFAULT 1,
    "bay_width_m" DECIMAL(6,2) NOT NULL DEFAULT 2.7,
    "level_height_m" DECIMAL(6,2) NOT NULL DEFAULT 1.8,
    "depth_m" DECIMAL(6,2) NOT NULL DEFAULT 1.2,
    "x_m" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "y_m" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "rotation_deg" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "racks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "warehouse_id" UUID NOT NULL,
    "zone_id" UUID,
    "rack_id" UUID,
    "code" VARCHAR(40) NOT NULL,
    "barcode" VARCHAR(64) NOT NULL,
    "location_type" VARCHAR(30) NOT NULL,
    "bay" INTEGER,
    "level" INTEGER,
    "position" INTEGER,
    "width_m" DECIMAL(6,2) NOT NULL DEFAULT 1.2,
    "depth_m" DECIMAL(6,2) NOT NULL DEFAULT 1.2,
    "height_m" DECIMAL(6,2) NOT NULL DEFAULT 1.8,
    "pallet_capacity" INTEGER NOT NULL DEFAULT 1,
    "max_weight_kg" DECIMAL(10,2) NOT NULL DEFAULT 1500,
    "x_m" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "y_m" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "z_m" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "admin_status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "block_reason" TEXT,
    "restrictions" JSONB,
    "pick_sequence" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "family" VARCHAR(60),
    "compatibility_group" VARCHAR(60),
    "abc_class" VARCHAR(1) NOT NULL DEFAULT 'C',
    "base_uom" VARCHAR(10) NOT NULL DEFAULT 'PIECE',
    "unit_weight_kg" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "case_length_cm" DECIMAL(8,2),
    "case_width_cm" DECIMAL(8,2),
    "case_height_cm" DECIMAL(8,2),
    "pallet_height_cm" DECIMAL(8,2),
    "requires_lot" BOOLEAN NOT NULL DEFAULT false,
    "requires_expiry" BOOLEAN NOT NULL DEFAULT false,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_barcodes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "sku_id" UUID NOT NULL,
    "barcode" VARCHAR(64) NOT NULL,
    "uom_code" VARCHAR(10) NOT NULL DEFAULT 'PIECE',

    CONSTRAINT "sku_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_uoms" (
    "sku_id" UUID NOT NULL,
    "uom_code" VARCHAR(10) NOT NULL,
    "base_qty" BIGINT NOT NULL,

    CONSTRAINT "sku_uoms_pkey" PRIMARY KEY ("sku_id","uom_code")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "tax_id" VARCHAR(40),
    "contact" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "tax_id" VARCHAR(40),
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carriers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "po_number" VARCHAR(60) NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "expected_date" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "po_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "sku_id" UUID NOT NULL,
    "ordered_qty" BIGINT NOT NULL,
    "received_qty" BIGINT NOT NULL DEFAULT 0,
    "uom_code" VARCHAR(10) NOT NULL DEFAULT 'CASE',
    "uom_qty" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "containers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "container_number" VARCHAR(40) NOT NULL,
    "supplier_id" UUID,
    "po_id" UUID,
    "carrier_id" UUID,
    "bl_number" VARCHAR(80),
    "seal_number" VARCHAR(80),
    "plates" VARCHAR(40),
    "driver_name" VARCHAR(120),
    "status" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_at" TIMESTAMPTZ(6),
    "arrived_at" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6),
    "unload_started_at" TIMESTAMPTZ(6),
    "unload_finished_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "operator_id" UUID,
    "dock_location_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "receipt_number" VARCHAR(40) NOT NULL,
    "container_id" UUID,
    "po_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "receiving_location_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "received_by" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "receipt_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "expected_qty" BIGINT NOT NULL DEFAULT 0,
    "received_qty" BIGINT NOT NULL DEFAULT 0,
    "damaged_qty" BIGINT NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lpns" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(30) NOT NULL,
    "lpn_type" VARCHAR(20) NOT NULL DEFAULT 'INBOUND',
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "warehouse_id" UUID NOT NULL,
    "current_location_id" UUID,
    "receipt_id" UUID,
    "container_id" UUID,
    "supplier_id" UUID,
    "order_id" UUID,
    "shipment_id" UUID,
    "cases_count" INTEGER NOT NULL DEFAULT 0,
    "weight_kg" DECIMAL(10,3),
    "length_cm" DECIMAL(8,2),
    "width_cm" DECIMAL(8,2),
    "height_cm" DECIMAL(8,2),
    "lot" VARCHAR(60),
    "expiry_date" DATE,
    "parent_lpn_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lpns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "lpn_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "qty" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" BIGSERIAL NOT NULL,
    "movement_type" VARCHAR(30) NOT NULL,
    "sku_id" UUID NOT NULL,
    "qty" BIGINT NOT NULL,
    "uom_code" VARCHAR(10) NOT NULL DEFAULT 'PIECE',
    "uom_qty" BIGINT NOT NULL DEFAULT 0,
    "from_lpn_id" UUID,
    "to_lpn_id" UUID,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "user_id" UUID,
    "device_id" VARCHAR(128),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_type" VARCHAR(40),
    "reference_id" VARCHAR(64),
    "order_id" UUID,
    "receipt_id" UUID,
    "shipment_id" UUID,
    "transfer_id" UUID,
    "task_id" UUID,
    "incident_id" UUID,
    "reason" VARCHAR(120),
    "note" TEXT,
    "idempotency_key" VARCHAR(256),

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slotting_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(100) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "weights" JSONB NOT NULL,
    "conditions" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slotting_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "putaway_tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "lpn_id" UUID NOT NULL,
    "suggested_location_id" UUID,
    "final_location_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "explanation" JSONB,
    "override_reason" TEXT,
    "override_by" UUID,
    "assigned_to" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "putaway_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "transfer_type" VARCHAR(20) NOT NULL DEFAULT 'LOCATION',
    "lpn_id" UUID NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'IN_TRANSIT',
    "started_by" UUID NOT NULL,
    "completed_by" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "reason" TEXT,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replenishment_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "sku_id" UUID NOT NULL,
    "pick_location_id" UUID NOT NULL,
    "min_qty" BIGINT NOT NULL,
    "max_qty" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "replenishment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replenishment_tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "rule_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "source_lpn_id" UUID,
    "from_location_id" UUID,
    "to_location_id" UUID NOT NULL,
    "qty" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "transfer_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "assigned_to" UUID,

    CONSTRAINT "replenishment_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "count_tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "count_type" VARCHAR(20) NOT NULL,
    "scope" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "is_blind" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_for" TIMESTAMPTZ(6),
    "assigned_to" UUID,
    "incident_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "notes" TEXT,

    CONSTRAINT "count_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "count_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "count_task_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "lpn_id" UUID,
    "sku_id" UUID NOT NULL,
    "system_qty" BIGINT NOT NULL,
    "counted_qty" BIGINT,
    "recount_qty" BIGINT,
    "final_qty" BIGINT,
    "variance" BIGINT,
    "counted_by" UUID,
    "counted_at" TIMESTAMPTZ(6),
    "recounted_by" UUID,
    "recounted_at" TIMESTAMPTZ(6),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "adjustment_movement_id" BIGINT,

    CONSTRAINT "count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_number" VARCHAR(60) NOT NULL,
    "customer_id" UUID NOT NULL,
    "destination" TEXT,
    "order_date" DATE,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "status" VARCHAR(20) NOT NULL DEFAULT 'IMPORTED',
    "source" VARCHAR(20) NOT NULL DEFAULT 'IMPORT',
    "external_ref" VARCHAR(80),
    "shipment_id" UUID,
    "picker_id" UUID,
    "verifier_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "sku_id" UUID NOT NULL,
    "required_qty" BIGINT NOT NULL,
    "uom_code" VARCHAR(10) NOT NULL DEFAULT 'PIECE',
    "uom_qty" BIGINT NOT NULL DEFAULT 0,
    "allocated_qty" BIGINT NOT NULL DEFAULT 0,
    "picked_qty" BIGINT NOT NULL DEFAULT 0,
    "verified_qty" BIGINT NOT NULL DEFAULT 0,
    "loaded_qty" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_line_id" UUID NOT NULL,
    "lpn_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "qty" BIGINT NOT NULL,
    "picked_qty" BIGINT NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "strategy" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "assigned_to" UUID,
    "outbound_lpn_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pick_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_task_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "pick_task_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "allocation_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "location_id" UUID NOT NULL,
    "lpn_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "qty" BIGINT NOT NULL,
    "picked_qty" BIGINT NOT NULL DEFAULT 0,
    "full_pallet" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "scan_step" INTEGER NOT NULL DEFAULT 0,
    "picked_at" TIMESTAMPTZ(6),

    CONSTRAINT "pick_task_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staging_assignments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "staging_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "verifier_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
    "same_user_authorization_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "notes" TEXT,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "verification_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lpn_id" UUID,
    "expected_qty" BIGINT NOT NULL,
    "scanned_qty" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "verification_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipment_number" VARCHAR(40) NOT NULL,
    "carrier_id" UUID,
    "vehicle" VARCHAR(80),
    "plates" VARCHAR(40),
    "driver_name" VARCHAR(120),
    "destination" TEXT,
    "dock_location_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "loading_started_at" TIMESTAMPTZ(6),
    "loading_finished_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "released_by" UUID,
    "departed_at" TIMESTAMPTZ(6),
    "release_check" JSONB,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "incident_number" VARCHAR(40) NOT NULL,
    "incident_type" VARCHAR(30) NOT NULL,
    "severity" VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "entity_type" VARCHAR(40),
    "entity_id" VARCHAR(64),
    "sku_id" UUID,
    "lpn_id" UUID,
    "location_id" UUID,
    "order_id" UUID,
    "shipment_id" UUID,
    "receipt_id" UUID,
    "qty" BIGINT,
    "reported_by" UUID NOT NULL,
    "assigned_to" UUID,
    "resolution" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "authorized_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_comments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "incident_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quarantine_reasons" (
    "code" VARCHAR(40) NOT NULL,
    "description" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "quarantine_reasons_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "returns" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "return_number" VARCHAR(40) NOT NULL,
    "customer_id" UUID NOT NULL,
    "original_order_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "reason" TEXT,
    "received_by" UUID,
    "received_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "return_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "expected_qty" BIGINT NOT NULL DEFAULT 0,
    "received_qty" BIGINT NOT NULL DEFAULT 0,
    "disposition" VARCHAR(20),
    "disposition_qty" BIGINT NOT NULL DEFAULT 0,
    "lpn_id" UUID,
    "inspected_by" UUID,
    "notes" TEXT,

    CONSTRAINT "return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_path" VARCHAR(512) NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "dpi" INTEGER NOT NULL DEFAULT 203,
    "label_width_mm" INTEGER NOT NULL DEFAULT 100,
    "label_height_mm" INTEGER NOT NULL DEFAULT 150,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_prints" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "label_type" VARCHAR(20) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "lpn_id" UUID,
    "printer_id" UUID,
    "is_reprint" BOOLEAN NOT NULL DEFAULT false,
    "reprint_reason" TEXT,
    "printed_by" UUID NOT NULL,
    "zpl" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_prints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "import_type" VARCHAR(30) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_sha256" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'VALIDATED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "summary" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequences_meta" (
    "name" VARCHAR(40) NOT NULL,
    "prefix" VARCHAR(10) NOT NULL,
    "description" TEXT,

    CONSTRAINT "sequences_meta_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_is_active_idx" ON "users"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_occurred_at_idx" ON "audit_logs"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "authorizations_entity_type_entity_id_idx" ON "authorizations"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "zones_warehouse_id_code_key" ON "zones"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "aisles_zone_id_code_key" ON "aisles"("zone_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "racks_aisle_id_code_key" ON "racks"("aisle_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "locations_barcode_key" ON "locations"("barcode");

-- CreateIndex
CREATE INDEX "locations_rack_id_idx" ON "locations"("rack_id");

-- CreateIndex
CREATE INDEX "locations_zone_id_idx" ON "locations"("zone_id");

-- CreateIndex
CREATE INDEX "locations_location_type_admin_status_idx" ON "locations"("location_type", "admin_status");

-- CreateIndex
CREATE UNIQUE INDEX "locations_warehouse_id_code_key" ON "locations"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "skus_code_key" ON "skus"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sku_barcodes_barcode_key" ON "sku_barcodes"("barcode");

-- CreateIndex
CREATE INDEX "sku_barcodes_sku_id_idx" ON "sku_barcodes"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "carriers_code_key" ON "carriers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_po_number_key" ON "purchase_orders"("po_number");

-- CreateIndex
CREATE INDEX "purchase_order_lines_sku_id_idx" ON "purchase_order_lines"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_po_id_line_no_key" ON "purchase_order_lines"("po_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "containers_container_number_key" ON "containers"("container_number");

-- CreateIndex
CREATE INDEX "containers_status_idx" ON "containers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_receipt_number_key" ON "receipts"("receipt_number");

-- CreateIndex
CREATE INDEX "receipts_status_idx" ON "receipts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_lines_receipt_id_sku_id_key" ON "receipt_lines"("receipt_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "lpns_code_key" ON "lpns"("code");

-- CreateIndex
CREATE INDEX "lpns_current_location_id_idx" ON "lpns"("current_location_id");

-- CreateIndex
CREATE INDEX "lpns_status_idx" ON "lpns"("status");

-- CreateIndex
CREATE INDEX "lpns_order_id_idx" ON "lpns"("order_id");

-- CreateIndex
CREATE INDEX "lpns_shipment_id_idx" ON "lpns"("shipment_id");

-- CreateIndex
CREATE INDEX "inventory_balances_sku_id_status_idx" ON "inventory_balances"("sku_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_lpn_id_sku_id_status_key" ON "inventory_balances"("lpn_id", "sku_id", "status");

-- CreateIndex
CREATE INDEX "inventory_movements_sku_id_occurred_at_idx" ON "inventory_movements"("sku_id", "occurred_at");

-- CreateIndex
CREATE INDEX "inventory_movements_from_lpn_id_idx" ON "inventory_movements"("from_lpn_id");

-- CreateIndex
CREATE INDEX "inventory_movements_to_lpn_id_idx" ON "inventory_movements"("to_lpn_id");

-- CreateIndex
CREATE INDEX "inventory_movements_order_id_idx" ON "inventory_movements"("order_id");

-- CreateIndex
CREATE INDEX "inventory_movements_shipment_id_idx" ON "inventory_movements"("shipment_id");

-- CreateIndex
CREATE INDEX "inventory_movements_occurred_at_idx" ON "inventory_movements"("occurred_at");

-- CreateIndex
CREATE INDEX "inventory_movements_movement_type_idx" ON "inventory_movements"("movement_type");

-- CreateIndex
CREATE INDEX "putaway_tasks_status_idx" ON "putaway_tasks"("status");

-- CreateIndex
CREATE INDEX "putaway_tasks_suggested_location_id_idx" ON "putaway_tasks"("suggested_location_id");

-- CreateIndex
CREATE INDEX "transfers_status_idx" ON "transfers"("status");

-- CreateIndex
CREATE INDEX "transfers_lpn_id_idx" ON "transfers"("lpn_id");

-- CreateIndex
CREATE UNIQUE INDEX "replenishment_rules_sku_id_pick_location_id_key" ON "replenishment_rules"("sku_id", "pick_location_id");

-- CreateIndex
CREATE INDEX "replenishment_tasks_status_idx" ON "replenishment_tasks"("status");

-- CreateIndex
CREATE INDEX "count_tasks_status_idx" ON "count_tasks"("status");

-- CreateIndex
CREATE INDEX "count_lines_count_task_id_idx" ON "count_lines"("count_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- CreateIndex
CREATE INDEX "orders_shipment_id_idx" ON "orders"("shipment_id");

-- CreateIndex
CREATE INDEX "order_lines_sku_id_idx" ON "order_lines"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_line_no_key" ON "order_lines"("order_id", "line_no");

-- CreateIndex
CREATE INDEX "allocations_lpn_id_status_idx" ON "allocations"("lpn_id", "status");

-- CreateIndex
CREATE INDEX "allocations_order_line_id_idx" ON "allocations"("order_line_id");

-- CreateIndex
CREATE INDEX "pick_tasks_status_idx" ON "pick_tasks"("status");

-- CreateIndex
CREATE INDEX "pick_tasks_assigned_to_idx" ON "pick_tasks"("assigned_to");

-- CreateIndex
CREATE INDEX "pick_task_lines_pick_task_id_sequence_idx" ON "pick_task_lines"("pick_task_id", "sequence");

-- CreateIndex
CREATE INDEX "staging_assignments_location_id_released_at_idx" ON "staging_assignments"("location_id", "released_at");

-- CreateIndex
CREATE INDEX "verifications_order_id_idx" ON "verifications"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_lines_verification_id_sku_id_lpn_id_key" ON "verification_lines"("verification_id", "sku_id", "lpn_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_shipment_number_key" ON "shipments"("shipment_number");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "shipments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_incident_number_key" ON "incidents"("incident_number");

-- CreateIndex
CREATE INDEX "incidents_status_severity_idx" ON "incidents"("status", "severity");

-- CreateIndex
CREATE INDEX "incidents_entity_type_entity_id_idx" ON "incidents"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "returns_return_number_key" ON "returns"("return_number");

-- CreateIndex
CREATE INDEX "attachments_entity_type_entity_id_idx" ON "attachments"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "printers_code_key" ON "printers"("code");

-- CreateIndex
CREATE INDEX "label_prints_label_type_entity_id_idx" ON "label_prints"("label_type", "entity_id");

-- CreateIndex
CREATE INDEX "import_jobs_import_type_file_sha256_idx" ON "import_jobs"("import_type", "file_sha256");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aisles" ADD CONSTRAINT "aisles_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "racks" ADD CONSTRAINT "racks_aisle_id_fkey" FOREIGN KEY ("aisle_id") REFERENCES "aisles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_rack_id_fkey" FOREIGN KEY ("rack_id") REFERENCES "racks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_barcodes" ADD CONSTRAINT "sku_barcodes_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_uoms" ADD CONSTRAINT "sku_uoms_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "containers" ADD CONSTRAINT "containers_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "containers" ADD CONSTRAINT "containers_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "containers" ADD CONSTRAINT "containers_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carriers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpns" ADD CONSTRAINT "lpns_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpns" ADD CONSTRAINT "lpns_current_location_id_fkey" FOREIGN KEY ("current_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpns" ADD CONSTRAINT "lpns_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpns" ADD CONSTRAINT "lpns_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpns" ADD CONSTRAINT "lpns_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpns" ADD CONSTRAINT "lpns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpns" ADD CONSTRAINT "lpns_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_lpn_id_fkey" FOREIGN KEY ("lpn_id") REFERENCES "lpns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_from_lpn_id_fkey" FOREIGN KEY ("from_lpn_id") REFERENCES "lpns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_to_lpn_id_fkey" FOREIGN KEY ("to_lpn_id") REFERENCES "lpns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_tasks" ADD CONSTRAINT "putaway_tasks_lpn_id_fkey" FOREIGN KEY ("lpn_id") REFERENCES "lpns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_lpn_id_fkey" FOREIGN KEY ("lpn_id") REFERENCES "lpns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_rules" ADD CONSTRAINT "replenishment_rules_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_rules" ADD CONSTRAINT "replenishment_rules_pick_location_id_fkey" FOREIGN KEY ("pick_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_count_task_id_fkey" FOREIGN KEY ("count_task_id") REFERENCES "count_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_lpn_id_fkey" FOREIGN KEY ("lpn_id") REFERENCES "lpns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_tasks" ADD CONSTRAINT "pick_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_task_lines" ADD CONSTRAINT "pick_task_lines_pick_task_id_fkey" FOREIGN KEY ("pick_task_id") REFERENCES "pick_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_task_lines" ADD CONSTRAINT "pick_task_lines_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staging_assignments" ADD CONSTRAINT "staging_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staging_assignments" ADD CONSTRAINT "staging_assignments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_lines" ADD CONSTRAINT "verification_lines_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carriers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_original_order_id_fkey" FOREIGN KEY ("original_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_lpn_id_fkey" FOREIGN KEY ("lpn_id") REFERENCES "lpns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
