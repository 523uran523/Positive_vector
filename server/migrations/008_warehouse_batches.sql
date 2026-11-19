CREATE TABLE material_batches (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  material_id TEXT NOT NULL REFERENCES materials(id),
  source_operation_id TEXT REFERENCES warehouse_operations(id),
  received_qty_milli INTEGER NOT NULL,
  remaining_qty_milli INTEGER NOT NULL,
  unit_cost_kopecks INTEGER NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX material_batches_stock ON material_batches(material_id, seq);
CREATE TABLE material_batch_allocations (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES warehouse_operations(id),
  batch_id TEXT NOT NULL REFERENCES material_batches(id),
  qty_milli INTEGER NOT NULL,
  unsettled_milli INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX material_batch_allocations_operation ON material_batch_allocations(operation_id);
CREATE TABLE material_legacy_issued (
  material_id TEXT NOT NULL REFERENCES materials(id),
  order_key TEXT NOT NULL,
  remaining_milli INTEGER NOT NULL,
  PRIMARY KEY(material_id, order_key)
);
INSERT INTO material_legacy_issued(material_id,order_key,remaining_milli)
SELECT material_id,COALESCE(order_id,''),MAX(0,SUM(CASE WHEN op_type='issue' THEN qty_milli WHEN op_type='return' THEN -qty_milli WHEN op_type='consume' AND order_id IS NOT NULL THEN -qty_milli ELSE 0 END))
FROM warehouse_operations WHERE item_type='material' AND material_id IS NOT NULL GROUP BY material_id,COALESCE(order_id,'');
-- The opening balance is an estimate: older movements do not reliably identify their source batches.
INSERT INTO material_batches(id, material_id, received_qty_milli, remaining_qty_milli, unit_cost_kopecks, estimated, created_at)
SELECT lower(hex(randomblob(16))), id, quantity_milli, quantity_milli, purchase_price_kopecks, 1, datetime('now')
FROM materials WHERE quantity_milli > 0;
