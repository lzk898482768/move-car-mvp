CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_token TEXT NOT NULL UNIQUE,
  owner_token TEXT NOT NULL UNIQUE,
  plate_number_masked TEXT NOT NULL,
  plate_number_hash TEXT NOT NULL,
  owner_phone_encrypted TEXT,
  showdoc_webhook TEXT NOT NULL,
  showdoc_token_encrypted TEXT,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  privacy_call_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicles_vehicle_token ON vehicles (vehicle_token);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner_token ON vehicles (owner_token);

CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  error_summary TEXT,
  visitor_ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles (id)
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_vehicle_created
  ON notification_logs (vehicle_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_logs_rate_limit
  ON notification_logs (vehicle_id, visitor_ip_hash, created_at);
