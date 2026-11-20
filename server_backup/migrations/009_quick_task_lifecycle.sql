ALTER TABLE quick_tasks ADD COLUMN cancelled_at TEXT;
CREATE TABLE quick_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES quick_tasks(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX quick_task_events_task ON quick_task_events(task_id, created_at);
