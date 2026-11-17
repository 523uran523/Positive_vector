import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { notifyAdmins, writeAuditLog } from '../security.ts';

export interface MaterialActionInput {
  materialId: string;
  opType: 'receipt' | 'issue' | 'consume' | 'return' | 'adjust';
  qtyMilli: number;
  unitCostKopecks?: number;
  orderId?: string | null;
  visitId?: string | null;
  shiftId?: string | null;
  employeeUserId?: string | null;
  actorUserId: string;
  note?: string;
}

export function getOrderMaterialBalance(
  db: DatabaseSync,
  orderId: string,
  materialId: string
): { issuedMilli: number; consumedMilli: number; returnedMilli: number; unconsumedIssuedMilli: number } {
  const rows = db
    .prepare(
      `SELECT op_type, SUM(qty_milli) as total
       FROM warehouse_operations
       WHERE order_id = ? AND item_type = 'material' AND material_id = ?
       GROUP BY op_type`
    )
    .all(orderId, materialId) as Array<{ op_type: string; total: number }>;

  let issuedMilli = 0;
  let consumedMilli = 0;
  let returnedMilli = 0;
  for (const r of rows) {
    if (r.op_type === 'issue') issuedMilli = Number(r.total || 0);
    if (r.op_type === 'consume') consumedMilli = Number(r.total || 0);
    if (r.op_type === 'return') returnedMilli = Number(r.total || 0);
  }
  const unconsumedIssuedMilli = Math.max(0, issuedMilli - consumedMilli - returnedMilli);
  return { issuedMilli, consumedMilli, returnedMilli, unconsumedIssuedMilli };
}

/**
 * Executes an atomic material stock movement inside an existing SQLite transaction.
 * Prevents double deduction when an installer consumes materials already issued to the order.
 */
export function applyMaterialOperationTx(
  db: DatabaseSync,
  input: MaterialActionInput
): {
  operationId: string;
  newStockMilli: number;
  negativeStockWarning: boolean;
} {
  const mat = db
    .prepare('SELECT id, name, unit, quantity_milli, purchase_price_kopecks, min_threshold_milli FROM materials WHERE id = ?')
    .get(input.materialId) as
    | {
        id: string;
        name: string;
        unit: string;
        quantity_milli: number;
        purchase_price_kopecks: number;
        min_threshold_milli: number;
      }
    | undefined;

  if (!mat) {
    throw new Error('Материал не найден на складе.');
  }

  const qty = Math.round(Number(input.qtyMilli || 0));
  if (qty <= 0 && input.opType !== 'adjust') {
    throw new Error('Количество должно быть больше нуля.');
  }

  let stockDelta = 0;
  const costPerUnit =
    input.unitCostKopecks !== undefined ? Math.max(0, Math.round(input.unitCostKopecks)) : mat.purchase_price_kopecks;

  if (input.opType === 'receipt') {
    stockDelta = qty;
    if (input.unitCostKopecks !== undefined && input.unitCostKopecks >= 0) {
      db.prepare('UPDATE materials SET purchase_price_kopecks = ? WHERE id = ?').run(
        Math.round(input.unitCostKopecks),
        mat.id
      );
    }
  } else if (input.opType === 'issue') {
    stockDelta = -qty;
  } else if (input.opType === 'return') {
    if (input.orderId) {
      const bal = getOrderMaterialBalance(db, input.orderId, mat.id);
      if (qty > bal.unconsumedIssuedMilli) {
        throw new Error(
          `Нельзя вернуть ${qty / 1000} ${mat.unit} «${mat.name}»: на заказе осталось неиспользованным ${bal.unconsumedIssuedMilli / 1000} ${mat.unit}.`
        );
      }
    } else {
      // Without an order context a return may only offset material that was actually issued.
      // This prevents "inventing" stock by repeatedly returning material that was never taken.
      const agg = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN op_type = 'issue' THEN qty_milli ELSE 0 END), 0) -
             COALESCE(SUM(CASE WHEN op_type = 'return' THEN qty_milli ELSE 0 END), 0) AS outstanding
           FROM warehouse_operations
           WHERE item_type = 'material' AND material_id = ?`
        )
        .get(mat.id) as { outstanding: number };
      const outstanding = Math.max(0, Number(agg.outstanding || 0));
      if (qty > outstanding) {
        throw new Error(
          `Нельзя вернуть ${qty / 1000} ${mat.unit} «${mat.name}» без указания заказа: всего не возвращено ${outstanding / 1000} ${mat.unit}.`
        );
      }
    }
    stockDelta = qty;
  } else if (input.opType === 'consume') {
    if (input.orderId) {
      const bal = getOrderMaterialBalance(db, input.orderId, mat.id);
      // Only deduct extra quantity beyond what was already issued (deducted) to this order
      const extraNeeded = Math.max(0, qty - bal.unconsumedIssuedMilli);
      stockDelta = -extraNeeded;
    } else {
      // Workshop shift consumption directly from warehouse
      stockDelta = -qty;
    }
  } else if (input.opType === 'adjust') {
    // Set new absolute quantity via qtyMilli
    stockDelta = qty - mat.quantity_milli;
  }

  const newStockMilli = mat.quantity_milli + stockDelta;
  db.prepare('UPDATE materials SET quantity_milli = ? WHERE id = ?').run(newStockMilli, mat.id);

  const opId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO warehouse_operations
     (id, item_type, material_id, tool_id, tool_instance_id, op_type, qty_milli, unit_cost_kopecks, order_id, visit_id, shift_id, user_id, created_by, note, created_at)
     VALUES (?, 'material', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opId,
    mat.id,
    input.opType,
    qty,
    costPerUnit,
    input.orderId || null,
    input.visitId || null,
    input.shiftId || null,
    input.employeeUserId || input.actorUserId,
    input.actorUserId,
    (input.note || '').trim(),
    new Date().toISOString()
  );

  const negativeStockWarning = newStockMilli < 0;
  if (newStockMilli < 0 || (mat.min_threshold_milli > 0 && newStockMilli <= mat.min_threshold_milli)) {
    notifyAdmins(
      db,
      'low_stock',
      newStockMilli < 0 ? `Отрицательный остаток: ${mat.name}` : `Низкий остаток: ${mat.name}`,
      `Текущий остаток «${mat.name}»: ${(newStockMilli / 1000).toFixed(2)} ${mat.unit}.`,
      'warehouse',
      mat.id
    );
  }

  writeAuditLog(db, input.actorUserId, 'material', mat.id, `material_${input.opType}`, {
    qtyMilli: qty,
    stockDelta,
    newStockMilli,
    orderId: input.orderId || null,
    shiftId: input.shiftId || null,
  });

  return { operationId: opId, newStockMilli, negativeStockWarning };
}

function recalcAvailableQty(db: DatabaseSync, toolId: string): number {
  const tool = db.prepare('SELECT tracking_mode, total_qty FROM tools WHERE id = ?').get(toolId) as
    | { tracking_mode: 'quantity' | 'individual'; total_qty: number }
    | undefined;
  if (!tool) return 0;

  if (tool.tracking_mode === 'individual') {
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM tool_instances WHERE tool_id = ? AND status = 'available'")
      .get(toolId) as { cnt: number };
    const available = Number(row.cnt || 0);
    db.prepare('UPDATE tools SET available_qty = ? WHERE id = ?').run(available, toolId);
    return available;
  }

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN op_type = 'issue' THEN qty_milli ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN op_type = 'return' THEN qty_milli ELSE 0 END), 0) AS active_milli
       FROM warehouse_operations
       WHERE item_type = 'tool' AND tool_id = ?`
    )
    .get(toolId) as { active_milli: number };
  const activeWhole = Math.max(0, Math.round(Number(row.active_milli || 0) / 1000));
  const available = Math.max(0, Number(tool.total_qty || 0) - activeWhole);
  db.prepare('UPDATE tools SET available_qty = ? WHERE id = ?').run(available, toolId);
  return available;
}

function activeToolMilliForUser(
  db: DatabaseSync,
  toolId: string,
  userId: string,
  orderId?: string | null
): number {
  const params: Array<string> = [toolId, userId];
  let orderClause = '';
  if (orderId) {
    orderClause = ' AND order_id = ?';
    params.push(orderId);
  }
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN op_type = 'issue' THEN qty_milli ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN op_type = 'return' THEN qty_milli ELSE 0 END), 0) AS active_milli
       FROM warehouse_operations
       WHERE item_type = 'tool' AND tool_id = ? AND user_id = ?${orderClause}`
    )
    .get(...params) as { active_milli: number };
  return Math.max(0, Number(row.active_milli || 0));
}

export function issueToolTx(
  db: DatabaseSync,
  params: {
    toolId: string;
    toolInstanceId?: string | null;
    qty: number;
    orderId?: string | null;
    visitId?: string | null;
    holderUserId: string;
    actorUserId: string;
    note?: string;
  }
): string {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(params.toolId) as
    | { id: string; name: string; tracking_mode: 'quantity' | 'individual'; total_qty: number; available_qty: number }
    | undefined;
  if (!tool) throw new Error('Инструмент не найден.');

  const now = new Date().toISOString();
  const opId = crypto.randomUUID();

  if (tool.tracking_mode === 'individual') {
    let instanceId = params.toolInstanceId || null;
    if (!instanceId) {
      const firstAvail = db
        .prepare("SELECT id FROM tool_instances WHERE tool_id = ? AND status = 'available' ORDER BY serial_number ASC LIMIT 1")
        .get(tool.id) as { id: string } | undefined;
      if (!firstAvail) throw new Error(`Нет свободных экземпляров инструмента «${tool.name}».`);
      instanceId = firstAvail.id;
    }

    const inst = db.prepare('SELECT * FROM tool_instances WHERE id = ? AND tool_id = ?').get(instanceId, tool.id) as
      | { id: string; serial_number: string; status: string }
      | undefined;
    if (!inst) throw new Error('Экземпляр инструмента не найден.');
    if (inst.status !== 'available') {
      throw new Error(`Экземпляр #${inst.serial_number} уже выдан или недоступен.`);
    }

    db.prepare(
      `UPDATE tool_instances SET status = 'issued', holder_user_id = ?, current_order_id = ?, issued_at = ? WHERE id = ?`
    ).run(params.holderUserId, params.orderId || null, now, inst.id);

    db.prepare(
      `INSERT INTO warehouse_operations
       (id, item_type, material_id, tool_id, tool_instance_id, op_type, qty_milli, unit_cost_kopecks, order_id, visit_id, shift_id, user_id, created_by, note, created_at)
       VALUES (?, 'tool', NULL, ?, ?, 'issue', 1000, 0, ?, ?, NULL, ?, ?, ?, ?)`
    ).run(
      opId,
      tool.id,
      inst.id,
      params.orderId || null,
      params.visitId || null,
      params.holderUserId,
      params.actorUserId,
      params.note || `Экземпляр #${inst.serial_number}`,
      now
    );
    recalcAvailableQty(db, tool.id);
    return opId;
  }

  const qty = Math.max(1, Math.round(params.qty || 1));
  if (tool.available_qty < qty) {
    throw new Error(`Недостаточно инструмента «${tool.name}» на складе (доступно: ${tool.available_qty}).`);
  }

  db.prepare(
    `INSERT INTO warehouse_operations
     (id, item_type, material_id, tool_id, tool_instance_id, op_type, qty_milli, unit_cost_kopecks, order_id, visit_id, shift_id, user_id, created_by, note, created_at)
     VALUES (?, 'tool', NULL, ?, NULL, 'issue', ?, 0, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    opId,
    tool.id,
    qty * 1000,
    params.orderId || null,
    params.visitId || null,
    params.holderUserId,
    params.actorUserId,
    params.note || '',
    now
  );
  recalcAvailableQty(db, tool.id);
  return opId;
}

export function returnToolTx(
  db: DatabaseSync,
  params: {
    toolId: string;
    toolInstanceId?: string | null;
    qty: number;
    orderId?: string | null;
    visitId?: string | null;
    holderUserId: string;
    actorUserId: string;
    note?: string;
    /** Admins may return an item on behalf of any holder. */
    force?: boolean;
  }
): string {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(params.toolId) as
    | { id: string; name: string; tracking_mode: 'quantity' | 'individual'; total_qty: number; available_qty: number }
    | undefined;
  if (!tool) throw new Error('Инструмент не найден.');

  const now = new Date().toISOString();
  const opId = crypto.randomUUID();

  if (tool.tracking_mode === 'individual') {
    if (!params.toolInstanceId) {
      throw new Error('Укажите конкретный номер экземпляра для возврата.');
    }
    const inst = db
      .prepare('SELECT id, serial_number, status, holder_user_id FROM tool_instances WHERE id = ? AND tool_id = ?')
      .get(params.toolInstanceId, tool.id) as
      | { id: string; serial_number: string; status: string; holder_user_id: string | null }
      | undefined;
    if (!inst) throw new Error('Экземпляр инструмента не найден.');
    if (inst.status !== 'issued') throw new Error(`Экземпляр #${inst.serial_number} уже находится на складе.`);
    if (!params.force && inst.holder_user_id && inst.holder_user_id !== params.holderUserId) {
      throw new Error(`Экземпляр #${inst.serial_number} выдан другому сотруднику.`);
    }

    db.prepare(
      `UPDATE tool_instances SET status = 'available', holder_user_id = NULL, current_order_id = NULL, issued_at = NULL WHERE id = ?`
    ).run(inst.id);

    db.prepare(
      `INSERT INTO warehouse_operations
       (id, item_type, material_id, tool_id, tool_instance_id, op_type, qty_milli, unit_cost_kopecks, order_id, visit_id, shift_id, user_id, created_by, note, created_at)
       VALUES (?, 'tool', NULL, ?, ?, 'return', 1000, 0, ?, ?, NULL, ?, ?, ?, ?)`
    ).run(
      opId,
      tool.id,
      inst.id,
      params.orderId || null,
      params.visitId || null,
      params.holderUserId,
      params.actorUserId,
      params.note || `Возврат #${inst.serial_number}`,
      now
    );
    recalcAvailableQty(db, tool.id);
    return opId;
  }

  const qty = Math.max(1, Math.round(params.qty || 1));
  const issuedTotal = (
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN op_type = 'issue' THEN qty_milli ELSE 0 END), 0) -
           COALESCE(SUM(CASE WHEN op_type = 'return' THEN qty_milli ELSE 0 END), 0) as active_milli
         FROM warehouse_operations
         WHERE item_type = 'tool' AND tool_id = ?`
      )
      .get(tool.id) as { active_milli: number }
  ).active_milli;

  const activeWhole = Math.max(0, Math.round(Number(issuedTotal || 0) / 1000));
  if (qty > activeWhole) {
    throw new Error(`Нельзя вернуть больше выданных единиц (на руках всего: ${activeWhole}).`);
  }

  if (!params.force) {
    const holderMilli = activeToolMilliForUser(db, tool.id, params.holderUserId, params.orderId);
    const holderWhole = Math.floor(holderMilli / 1000);
    if (qty > holderWhole) {
      throw new Error(
        `Нельзя вернуть ${qty} ед. «${tool.name}»: у сотрудника на руках ${holderWhole} ед.` +
          (params.orderId ? ' по этому заказу.' : '.')
      );
    }
  }

  db.prepare(
    `INSERT INTO warehouse_operations
     (id, item_type, material_id, tool_id, tool_instance_id, op_type, qty_milli, unit_cost_kopecks, order_id, visit_id, shift_id, user_id, created_by, note, created_at)
     VALUES (?, 'tool', NULL, ?, NULL, 'return', ?, 0, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    opId,
    tool.id,
    qty * 1000,
    params.orderId || null,
    params.visitId || null,
    params.holderUserId,
    params.actorUserId,
    params.note || '',
    now
  );
  recalcAvailableQty(db, tool.id);
  return opId;
}
