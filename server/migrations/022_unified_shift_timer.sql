ALTER TABLE workshop_shifts ADD COLUMN shift_type TEXT NOT NULL DEFAULT 'workshop' CHECK (shift_type IN ('workshop', 'visit', 'quick_task'));
ALTER TABLE workshop_shifts ADD COLUMN order_id TEXT REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE workshop_shifts ADD COLUMN visit_id TEXT REFERENCES order_visits(id) ON DELETE SET NULL;
ALTER TABLE workshop_shifts ADD COLUMN quick_task_id TEXT REFERENCES quick_tasks(id) ON DELETE SET NULL;
ALTER TABLE workshop_shifts ADD COLUMN work_date TEXT NOT NULL DEFAULT '';
ALTER TABLE workshop_shifts ADD COLUMN is_manual_entry INTEGER NOT NULL DEFAULT 0;

UPDATE workshop_shifts SET work_date = substr(started_at, 1, 10) WHERE work_date = '';

CREATE INDEX IF NOT EXISTS idx_shifts_visit_id ON workshop_shifts(visit_id);
CREATE INDEX IF NOT EXISTS idx_shifts_order_id ON workshop_shifts(order_id);
CREATE INDEX IF NOT EXISTS idx_shifts_quick_task_id ON workshop_shifts(quick_task_id);
CREATE INDEX IF NOT EXISTS idx_shifts_work_date_user ON workshop_shifts(work_date, user_id);

CREATE TABLE IF NOT EXISTS shift_edit_requests (
  id TEXT PRIMARY KEY,
  shift_id TEXT REFERENCES workshop_shifts(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL DEFAULT 'workshop' CHECK (target_type IN ('workshop', 'visit', 'quick_task')),
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  visit_id TEXT REFERENCES order_visits(id) ON DELETE SET NULL,
  quick_task_id TEXT REFERENCES quick_tasks(id) ON DELETE SET NULL,
  work_date TEXT NOT NULL,
  requested_started_at TEXT NOT NULL,
  requested_ended_at TEXT NOT NULL,
  work_done TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_comment TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shift_edit_requests_user ON shift_edit_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shift_edit_requests_status ON shift_edit_requests(status, created_at DESC);
