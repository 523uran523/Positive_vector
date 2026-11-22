CREATE TABLE chat_message_files (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES chat_files(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, file_id)
);

CREATE INDEX chat_message_files_message_idx ON chat_message_files(message_id, sort_order);
CREATE INDEX chat_message_files_file_idx ON chat_message_files(file_id);

INSERT OR IGNORE INTO chat_message_files (message_id, file_id, sort_order)
SELECT id, file_id, 0
FROM chat_messages
WHERE file_id IS NOT NULL;
