-- 024_messenger_links.sql
-- Привязка сотрудников к Telegram и MAX для получения уведомлений.
-- Сообщения отправляются по внутреннему id мессенджера (chat_id / user_id),
-- который появляется после того, как сотрудник сам открыл бота.

ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN telegram_username TEXT;
ALTER TABLE users ADD COLUMN telegram_linked_at TEXT;
ALTER TABLE users ADD COLUMN max_user_id TEXT;
ALTER TABLE users ADD COLUMN max_username TEXT;
ALTER TABLE users ADD COLUMN max_linked_at TEXT;

CREATE TABLE IF NOT EXISTS messenger_link_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'max')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messenger_link_tokens_user
  ON messenger_link_tokens(user_id, channel);

CREATE INDEX IF NOT EXISTS idx_users_telegram_chat
  ON users(telegram_chat_id);

CREATE INDEX IF NOT EXISTS idx_users_max_user
  ON users(max_user_id);
