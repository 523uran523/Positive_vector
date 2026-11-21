CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  subscription_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

INSERT OR IGNORE INTO push_subscriptions (endpoint, user_id, session_id, subscription_json, created_at)
SELECT endpoint, user_id, session_id, subscription_json, datetime('now')
FROM chat_push_subscriptions;

DROP TABLE IF EXISTS chat_push_subscriptions;
