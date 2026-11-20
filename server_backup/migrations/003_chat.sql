ALTER TABLE users ADD COLUMN chat_history_after INTEGER NOT NULL DEFAULT 0;
CREATE TABLE chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  file_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);
CREATE TABLE chat_files (
  id TEXT PRIMARY KEY,
  stored_name TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'avatar')),
  created_at TEXT NOT NULL
);
CREATE TABLE chat_avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  file_id TEXT NOT NULL REFERENCES chat_files(id)
);
CREATE TABLE chat_reads (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  last_read_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE chat_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subscription_json TEXT NOT NULL
);
