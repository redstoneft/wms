-- the station launcher must be downloadable again without rotating the token: keep it encrypted at rest (AES-256-GCM, app key)
ALTER TABLE printers ADD COLUMN IF NOT EXISTS agent_token_enc text;
