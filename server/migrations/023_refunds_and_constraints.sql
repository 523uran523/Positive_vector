-- 023_refunds_and_constraints.sql
-- Разрешаем операцию возврата клиенту (payment_type = 'refund') с отрицательной суммой amount_kopecks < 0.
-- Для обычных поступлений ('advance', 'partial', 'full') сумма остаётся строго > 0.

CREATE TABLE client_payments_new (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  company_id TEXT,
  contact_id TEXT,
  amount_kopecks INTEGER NOT NULL CHECK (
    (payment_type = 'refund' AND amount_kopecks < 0)
    OR (payment_type IN ('advance', 'partial', 'full') AND amount_kopecks > 0)
  ),
  payment_type TEXT NOT NULL DEFAULT 'partial' CHECK (payment_type IN ('advance', 'partial', 'full', 'refund')),
  paid_at TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO client_payments_new (id, order_id, company_id, contact_id, amount_kopecks, payment_type, paid_at, comment, created_by, created_at)
SELECT id, order_id, company_id, contact_id, amount_kopecks, payment_type, paid_at, comment, created_by, created_at
FROM client_payments;

DROP TABLE client_payments;
ALTER TABLE client_payments_new RENAME TO client_payments;

CREATE INDEX IF NOT EXISTS idx_client_payments_order ON client_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_client_payments_paid_at ON client_payments(paid_at);
