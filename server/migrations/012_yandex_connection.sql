CREATE TABLE yandex_connection (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  encrypted_tokens TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  connected_by TEXT REFERENCES users(id)
);
