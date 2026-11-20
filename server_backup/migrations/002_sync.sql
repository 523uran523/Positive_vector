CREATE TABLE IF NOT EXISTS mutation_receipts (
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_receipts_created ON mutation_receipts(created_at);
CREATE TABLE IF NOT EXISTS file_deletions (
  stored_name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_error TEXT
);
