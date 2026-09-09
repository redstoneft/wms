-- Print agent: a printer connected by USB to a PC. The PC runs a small agent that PULLS queued labels from the API
-- (token auth) and sends them to the Windows RAW queue. Nothing to open on the LAN.
ALTER TABLE printers ADD COLUMN mode varchar(10) NOT NULL DEFAULT 'NETWORK';
ALTER TABLE printers ADD CONSTRAINT ck_printer_mode CHECK (mode IN ('NETWORK','AGENT'));
ALTER TABLE printers ADD COLUMN agent_token_hash varchar(64);
ALTER TABLE printers ADD COLUMN agent_last_seen_at timestamptz(6);
ALTER TABLE printers ADD COLUMN agent_host varchar(120);
ALTER TABLE label_prints ADD COLUMN claimed_at timestamptz(6);
ALTER TABLE label_prints ADD COLUMN sent_at timestamptz(6);
CREATE INDEX label_prints_queue_idx ON label_prints (printer_id, status) WHERE status IN ('QUEUED','PRINTING');
