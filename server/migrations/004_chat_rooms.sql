CREATE TABLE chat_rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
INSERT INTO chat_rooms(id, name, created_at) VALUES ('general', 'Общий чат', CURRENT_TIMESTAMP);
CREATE TABLE chat_room_members (
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  history_after INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id, user_id)
);
ALTER TABLE chat_messages RENAME TO chat_messages_legacy;
CREATE TABLE chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  file_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  room_id TEXT NOT NULL DEFAULT 'general' REFERENCES chat_rooms(id)
);
INSERT INTO chat_messages(seq,id,author_id,body,file_id,created_at,edited_at,deleted_at,room_id)
SELECT seq,id,author_id,body,file_id,created_at,edited_at,deleted_at,'general' FROM chat_messages_legacy;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'chat_messages',seq FROM sqlite_sequence WHERE name='chat_messages_legacy'
AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='chat_messages');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='chat_messages_legacy'),0)) WHERE name='chat_messages';
DROP TABLE chat_messages_legacy;
CREATE INDEX chat_messages_room_seq ON chat_messages(room_id, seq);
ALTER TABLE chat_reads RENAME TO chat_reads_legacy;
CREATE TABLE chat_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, room_id)
);
INSERT INTO chat_reads(user_id, room_id, last_read_seq) SELECT user_id, 'general', last_read_seq FROM chat_reads_legacy;
DROP TABLE chat_reads_legacy;
