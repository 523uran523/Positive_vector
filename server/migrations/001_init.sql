PRAGMA foreign_keys = ON;

-- 1. Пользователи и авторизация
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  shift_rate_kopecks INTEGER NOT NULL DEFAULT 300000 CHECK (shift_rate_kopecks >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 0 CHECK (granted IN (0, 1)),
  PRIMARY KEY (user_id, permission_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  key_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

-- 2. Клиенты: Компании и Контактные лица
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  inn TEXT NOT NULL DEFAULT '',
  requisites TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

-- 3. Заказы и многодневные выезды
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'completed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  scheduled_at TEXT,
  company_id TEXT,
  client_contact_id TEXT,
  site_contact_name TEXT NOT NULL DEFAULT '',
  site_contact_phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (price_kopecks >= 0),
  cost_override_kopecks INTEGER,
  tags_json TEXT NOT NULL DEFAULT '[]',
  comments TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
  FOREIGN KEY (client_contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_scheduled ON orders(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_assignees (
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (order_id, user_id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_visits (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  title TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  actual_start_at TEXT,
  actual_end_at TEXT,
  completed_by TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (completed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_visits_order ON order_visits(order_id);
CREATE INDEX IF NOT EXISTS idx_visits_scheduled ON order_visits(scheduled_at);

CREATE TABLE IF NOT EXISTS visit_assignees (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_lead INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0, 1)),
  wage_kopecks INTEGER CHECK (wage_kopecks IS NULL OR wage_kopecks >= 0),
  wage_assigned_at TEXT,
  wage_assigned_by TEXT,
  UNIQUE (visit_id, user_id),
  FOREIGN KEY (visit_id) REFERENCES order_visits(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (wage_assigned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS visit_reports (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  work_done TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (visit_id) REFERENCES order_visits(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. Вложения (фотографии и документы)
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('order', 'visit', 'report', 'tool')),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'document')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);

-- 5. Смены в цеху
CREATE TABLE IF NOT EXISTS workshop_shifts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  work_done TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  rate_snapshot_kopecks INTEGER NOT NULL CHECK (rate_snapshot_kopecks >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_shift_per_user
  ON workshop_shifts(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shifts_started ON workshop_shifts(started_at);

-- 6. Зарплаты: Начисления и выплаты
CREATE TABLE IF NOT EXISTS salary_accruals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('visit', 'shift', 'manual')),
  source_id TEXT,
  amount_kopecks INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_accrual_source
  ON salary_accruals(source_type, source_id, user_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accruals_user ON salary_accruals(user_id);

CREATE TABLE IF NOT EXISTS salary_payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'bank', 'card')),
  paid_at TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_payouts_user ON salary_payouts(user_id);

-- 7. Финансы: Платежи клиентов и расходы компании
CREATE TABLE IF NOT EXISTS client_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  company_id TEXT,
  contact_id TEXT,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  payment_type TEXT NOT NULL DEFAULT 'partial' CHECK (payment_type IN ('advance', 'partial', 'full')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'bank', 'card')),
  paid_at TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'bank', 'card')),
  expense_date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  order_id TEXT,
  warehouse_op_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 8. Склад: Материалы (ресурсы) и Инструменты
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Прочее',
  unit TEXT NOT NULL DEFAULT 'шт',
  quantity_milli INTEGER NOT NULL DEFAULT 0,
  purchase_price_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_kopecks >= 0),
  min_threshold_milli INTEGER NOT NULL DEFAULT 0 CHECK (min_threshold_milli >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0071E3',
  icon_emoji TEXT NOT NULL DEFAULT '🔧',
  tracking_mode TEXT NOT NULL DEFAULT 'quantity' CHECK (tracking_mode IN ('quantity', 'individual')),
  total_qty INTEGER NOT NULL DEFAULT 1 CHECK (total_qty >= 0),
  available_qty INTEGER NOT NULL DEFAULT 1 CHECK (available_qty >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_instances (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'issued', 'maintenance')),
  holder_user_id TEXT,
  current_order_id TEXT,
  issued_at TEXT,
  UNIQUE (tool_id, serial_number),
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE,
  FOREIGN KEY (holder_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (current_order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_planned_resources (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('material', 'tool')),
  material_id TEXT,
  tool_id TEXT,
  planned_qty_milli INTEGER NOT NULL DEFAULT 1000 CHECK (planned_qty_milli > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS warehouse_operations (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('material', 'tool')),
  material_id TEXT,
  tool_id TEXT,
  tool_instance_id TEXT,
  op_type TEXT NOT NULL CHECK (op_type IN ('receipt', 'issue', 'consume', 'return', 'adjust')),
  qty_milli INTEGER NOT NULL CHECK (qty_milli >= 0),
  unit_cost_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_kopecks >= 0),
  order_id TEXT,
  visit_id TEXT,
  shift_id TEXT,
  user_id TEXT,
  created_by TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE,
  FOREIGN KEY (tool_instance_id) REFERENCES tool_instances(id) ON DELETE SET NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY (visit_id) REFERENCES order_visits(id) ON DELETE SET NULL,
  FOREIGN KEY (shift_id) REFERENCES workshop_shifts(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_wh_ops_order ON warehouse_operations(order_id);
CREATE INDEX IF NOT EXISTS idx_wh_ops_material ON warehouse_operations(material_id);
CREATE INDEX IF NOT EXISTS idx_wh_ops_tool ON warehouse_operations(tool_id);

-- 9. Уведомления, Настройки и Журнал изменений
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link_entity_type TEXT,
  link_entity_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
