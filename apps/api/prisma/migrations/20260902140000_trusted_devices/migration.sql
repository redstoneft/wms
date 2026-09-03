-- "Remember this device": after a successful TOTP check the browser gets an opaque token (hashed here)
-- that lets it skip the second factor for a limited time. Revocable per device; wiped on password change / MFA reset.
CREATE TABLE "trusted_devices" (
  "id"           UUID PRIMARY KEY DEFAULT uuidv7(),
  "user_id"      UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"   VARCHAR(128) NOT NULL UNIQUE,
  "device_id"    VARCHAR(128),
  "user_agent"   VARCHAR(512),
  "ip"           VARCHAR(64),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at"   TIMESTAMPTZ(6) NOT NULL,
  "revoked_at"   TIMESTAMPTZ(6)
);
CREATE INDEX "trusted_devices_user_id_idx" ON "trusted_devices"("user_id");
INSERT INTO "settings" ("key", "value") VALUES ('mfa_trusted_device_days', '30'::jsonb) ON CONFLICT ("key") DO NOTHING;
