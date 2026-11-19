CREATE TABLE order_cancel_reviews (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  issue_key TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  subject_total_kopecks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(order_id, issue_key)
);
