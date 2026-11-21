CREATE TABLE visit_work_times (
  visit_id TEXT NOT NULL REFERENCES order_visits(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (visit_id, user_id, work_date)
);
