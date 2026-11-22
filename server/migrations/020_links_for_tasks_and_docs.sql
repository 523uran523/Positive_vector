ALTER TABLE quick_tasks ADD COLUMN order_id TEXT REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN order_id TEXT REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS quick_tasks_order ON quick_tasks(order_id);
CREATE INDEX IF NOT EXISTS documents_order ON documents(order_id);
