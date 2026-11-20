CREATE TABLE quick_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  completed_by TEXT REFERENCES users(id),
  completed_at TEXT,
  completion_comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE quick_task_assignees (
  task_id TEXT NOT NULL REFERENCES quick_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY(task_id,user_id)
);
CREATE INDEX quick_tasks_due_date ON quick_tasks(due_date);
CREATE INDEX quick_task_assignees_user ON quick_task_assignees(user_id,task_id);
