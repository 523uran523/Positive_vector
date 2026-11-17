import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { hasPermission, writeAuditLog } from '../security.ts';
import { applyMaterialOperationTx, issueToolTx, returnToolTx } from '../services/warehouseService.ts';

export function createWarehouseRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/', requireAuth, (_req, res) => {
    const materials = db
      .prepare('SELECT * FROM materials ORDER BY category ASC, name ASC')
      .all() as Array<Record<string, unknown>>;

    const tools = db
      .prepare('SELECT * FROM tools ORDER BY name ASC')
      .all() as Array<Record<string, unknown>>;

    const instances = db
      .prepare(
        `SELECT ti.*, u.full_name as holder_name, o.order_number
         FROM tool_instances ti
         LEFT JOIN users u ON u.id = ti.holder_user_id
         LEFT JOIN orders o ON o.id = ti.current_order_id
         ORDER BY ti.serial_number ASC`
      )
      .all() as Array<Record<string, unknown>>;

    // Calculate active quantity-mode holders per tool
    const qtyHolderRows = db
      .prepare(
        `SELECT wo.tool_id, wo.user_id, u.full_name as holder_name,
                SUM(CASE WHEN wo.op_type = 'issue' THEN wo.qty_milli ELSE 0 END) -
                SUM(CASE WHEN wo.op_type = 'return' THEN wo.qty_milli ELSE 0 END) as held_milli
         FROM warehouse_operations wo
         LEFT JOIN users u ON u.id = wo.user_id
         JOIN tools t ON t.id = wo.tool_id
         WHERE wo.item_type = 'tool' AND t.tracking_mode = 'quantity'
         GROUP BY wo.tool_id, wo.user_id
         HAVING held_milli > 0`
      )
      .all() as Array<{ tool_id: string; user_id: string; holder_name: string; held_milli: number }>;

    const enrichedTools = tools.map((t) => ({
      ...t,
      instances: instances.filter((i) => i.tool_id === t.id),
      activeHolders: qtyHolderRows
        .filter((h) => h.tool_id === t.id)
        .map((h) => ({
          userId: h.user_id,
          holderName: h.holder_name || 'Сотрудник',
          qty: Math.round(h.held_milli / 1000),
        })),
    }));

    const operations = db
      .prepare(
        `SELECT wo.*, m.name as material_name, m.unit as material_unit,
                t.name as tool_name, ti.serial_number as tool_serial,
                u.full_name as employee_name, o.order_number
         FROM warehouse_operations wo
         LEFT JOIN materials m ON m.id = wo.material_id
         LEFT JOIN tools t ON t.id = wo.tool_id
         LEFT JOIN tool_instances ti ON ti.id = wo.tool_instance_id
         LEFT JOIN users u ON u.id = wo.user_id
         LEFT JOIN orders o ON o.id = wo.order_id
         ORDER BY wo.created_at DESC
         LIMIT 150`
      )
      .all();

    res.json({ materials, tools: enrichedTools, operations });
  });

  // Create new material
  router.post('/materials', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (
      user.role !== 'admin' &&
      !hasPermission(user, 'warehouse.edit') &&
      !hasPermission(user, 'warehouse.receive')
    ) {
      res.status(403).json({ error: 'Нет прав на добавление материалов.' });
      return;
    }

    const { name, category, unit, initialQtyMilli, purchasePriceKopecks, minThresholdMilli } =
      req.body as {
        name?: string;
        category?: string;
        unit?: string;
        initialQtyMilli?: number;
        purchasePriceKopecks?: number;
        minThresholdMilli?: number;
      };

    if (!name || !name.trim()) {
      res.status(400).json({ error: 'Укажите название материала.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const qtyMilli = Math.round(Number(initialQtyMilli || 0));
    const price = Math.max(0, Math.round(Number(purchasePriceKopecks || 0)));
    const thresh = Math.max(0, Math.round(Number(minThresholdMilli || 0)));

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO materials (id, name, category, unit, quantity_milli, purchase_price_kopecks, min_threshold_milli, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(id, name.trim(), (category || 'Прочее').trim(), (unit || 'шт').trim(), price, thresh, now);

      if (qtyMilli > 0) {
        applyMaterialOperationTx(db, {
          materialId: id,
          opType: 'receipt',
          qtyMilli,
          unitCostKopecks: price,
          actorUserId: user.id,
          note: 'Начальный остаток при создании',
        });
      }
      writeAuditLog(db, user.id, 'material', id, 'material_created', { name: name.trim(), unit });
    });

    res.status(201).json({ material: db.prepare('SELECT * FROM materials WHERE id = ?').get(id) });
  });

  // Update material details
  router.patch('/materials/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'warehouse.edit')) {
      res.status(403).json({ error: 'Нет прав на редактирование материалов.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Материал не найден.' });
      return;
    }
    const b = req.body as {
      name?: string;
      category?: string;
      unit?: string;
      purchasePriceKopecks?: number;
      minThresholdMilli?: number;
    };
    db.prepare(
      `UPDATE materials SET name = ?, category = ?, unit = ?, purchase_price_kopecks = ?, min_threshold_milli = ? WHERE id = ?`
    ).run(
      b.name?.trim() || existing.name,
      b.category?.trim() || existing.category,
      b.unit?.trim() || existing.unit,
      b.purchasePriceKopecks !== undefined
        ? Math.max(0, Math.round(Number(b.purchasePriceKopecks)))
        : existing.purchase_price_kopecks,
      b.minThresholdMilli !== undefined
        ? Math.max(0, Math.round(Number(b.minThresholdMilli)))
        : existing.min_threshold_milli,
      id
    );
    writeAuditLog(db, user.id, 'material', id, 'material_updated', {});
    res.json({ material: db.prepare('SELECT * FROM materials WHERE id = ?').get(id) });
  });

  // Delete material
  router.delete('/materials/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'warehouse.edit')) {
      res.status(403).json({ error: 'Нет прав на удаление материалов.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT id, name FROM materials WHERE id = ?').get(id) as
      | { id: string; name: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Материал не найден.' });
      return;
    }
    if (db.prepare('SELECT 1 FROM warehouse_operations WHERE material_id = ? LIMIT 1').get(id) || db.prepare('SELECT 1 FROM order_planned_resources WHERE material_id = ? LIMIT 1').get(id)) {
      res.status(409).json({ error: 'Материал связан с учётной историей и не может быть удалён.' });
      return;
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM materials WHERE id = ?').run(id);
      writeAuditLog(db, user.id, 'material', id, 'material_deleted', { name: existing.name });
    });
    res.json({ ok: true, id });
  });

  // Material receipt / adjust / take / return operation
  router.post('/materials/:id/operations', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const materialId = String(req.params.id);
    const { opType, qtyMilli, unitCostKopecks, orderId, note } = req.body as {
      opType: 'receipt' | 'issue' | 'consume' | 'return' | 'adjust';
      qtyMilli: number;
      unitCostKopecks?: number;
      orderId?: string | null;
      note?: string;
    };

    if (opType === 'receipt' && user.role !== 'admin' && !hasPermission(user, 'warehouse.receive')) {
      res.status(403).json({ error: 'Нет прав на приёмку поступлений на склад.' });
      return;
    }
    if (opType === 'adjust' && user.role !== 'admin' && !hasPermission(user, 'warehouse.edit')) {
      res.status(403).json({ error: 'Нет прав на корректировку остатков.' });
      return;
    }
    if (
      (opType === 'issue' || opType === 'consume' || opType === 'return') &&
      user.role !== 'admin' &&
      !hasPermission(user, 'warehouse.take')
    ) {
      res.status(403).json({ error: 'Нет прав на выдачу/списание материалов.' });
      return;
    }

    try {
      const result = withTransaction(db, () =>
        applyMaterialOperationTx(db, {
          materialId,
          opType,
          qtyMilli: Number(qtyMilli),
          unitCostKopecks,
          orderId: orderId || null,
          employeeUserId: user.id,
          actorUserId: user.id,
          note,
        })
      );
      const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
      res.status(201).json({ ...result, material });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка складской операции.' });
    }
  });

  // Create new tool (quantity or individual serial tracking)
  router.post('/tools', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (
      user.role !== 'admin' &&
      !hasPermission(user, 'warehouse.edit') &&
      !hasPermission(user, 'warehouse.receive')
    ) {
      res.status(403).json({ error: 'Нет прав на добавление инструментов.' });
      return;
    }

    const { name, color, iconEmoji, trackingMode, totalQty, serialNumbers, notes } = req.body as {
      name?: string;
      color?: string;
      iconEmoji?: string;
      trackingMode?: 'quantity' | 'individual';
      totalQty?: number;
      serialNumbers?: string[];
      notes?: string;
    };

    if (!name || !name.trim()) {
      res.status(400).json({ error: 'Укажите название инструмента.' });
      return;
    }

    const mode = trackingMode === 'individual' ? 'individual' : 'quantity';
    const cleanSerials =
      mode === 'individual'
        ? (Array.isArray(serialNumbers) ? serialNumbers.map((s) => s.trim()).filter(Boolean) : [])
        : [];

    const qty =
      mode === 'individual'
        ? Math.max(cleanSerials.length, Math.max(1, Math.round(Number(totalQty || 1))))
        : Math.max(1, Math.round(Number(totalQty || 1)));

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tools (id, name, color, icon_emoji, tracking_mode, total_qty, available_qty, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        name.trim(),
        (color || '#0071E3').trim(),
        (iconEmoji || '🔧').trim(),
        mode,
        qty,
        qty,
        (notes || '').trim(),
        now
      );

      if (mode === 'individual') {
        const insInst = db.prepare(
          `INSERT INTO tool_instances (id, tool_id, serial_number, status) VALUES (?, ?, ?, 'available')`
        );
        for (let i = 0; i < qty; i++) {
          const sn = cleanSerials[i] || `ИНВ-${String(i + 1).padStart(3, '0')}`;
          insInst.run(crypto.randomUUID(), id, sn);
        }
      }

      writeAuditLog(db, user.id, 'tool', id, 'tool_created', { name: name.trim(), mode, qty });
    });

    res.status(201).json({ tool: db.prepare('SELECT * FROM tools WHERE id = ?').get(id) });
  });

  // Update tool details and stock/serials
  router.patch('/tools/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'warehouse.edit')) {
      res.status(403).json({ error: 'Нет прав на редактирование инструментов.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM tools WHERE id = ?').get(id) as
      | {
          id: string;
          name: string;
          color: string;
          icon_emoji: string;
          tracking_mode: 'quantity' | 'individual';
          total_qty: number;
          available_qty: number;
          notes: string;
        }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Инструмент не найден.' });
      return;
    }

    const b = req.body as {
      name?: string;
      color?: string;
      iconEmoji?: string;
      notes?: string;
      totalQty?: number;
      addSerials?: string[];
    };

    try {
      withTransaction(db, () => {
        let nextTotal = existing.total_qty;
        let nextAvailable = existing.available_qty;

        if (existing.tracking_mode === 'quantity' && b.totalQty !== undefined) {
          if (!Number.isSafeInteger(b.totalQty) || Number(b.totalQty) < 0) throw new Error('Количество должно быть целым неотрицательным числом.');
          const requestedTotal = Number(b.totalQty);
          const issuedCount = existing.total_qty - existing.available_qty;
          if (requestedTotal < issuedCount) {
            throw new Error(`Нельзя задать количество меньше выданного на руки (${issuedCount} шт).`);
          }
          nextTotal = requestedTotal;
          nextAvailable = requestedTotal - issuedCount;
        }

        if (existing.tracking_mode === 'individual' && Array.isArray(b.addSerials)) {
          const toAdd = b.addSerials.map((s) => s.trim()).filter(Boolean);
          const insInst = db.prepare(
            `INSERT INTO tool_instances (id, tool_id, serial_number, status) VALUES (?, ?, ?, 'available')`
          );
          for (const sn of toAdd) {
            insInst.run(crypto.randomUUID(), id, sn);
            nextTotal += 1;
            nextAvailable += 1;
          }
        }

        db.prepare(
          `UPDATE tools SET name = ?, color = ?, icon_emoji = ?, notes = ?, total_qty = ?, available_qty = ? WHERE id = ?`
        ).run(
          b.name?.trim() || existing.name,
          b.color?.trim() || existing.color,
          b.iconEmoji?.trim() || existing.icon_emoji,
          b.notes !== undefined ? b.notes.trim() : existing.notes,
          nextTotal,
          nextAvailable,
          id
        );

        writeAuditLog(db, user.id, 'tool', id, 'tool_updated', { nextTotal });
      });

      res.json({ tool: db.prepare('SELECT * FROM tools WHERE id = ?').get(id) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка обновления инструмента.' });
    }
  });

  // Delete tool (only if all instances are returned to warehouse)
  router.delete('/tools/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'warehouse.edit')) {
      res.status(403).json({ error: 'Нет прав на удаление инструментов.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM tools WHERE id = ?').get(id) as
      | { id: string; name: string; total_qty: number; available_qty: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Инструмент не найден.' });
      return;
    }

    const issuedInstance = db
      .prepare("SELECT id FROM tool_instances WHERE tool_id = ? AND status = 'issued' LIMIT 1")
      .get(id);
    if (issuedInstance || existing.available_qty < existing.total_qty) {
      res.status(400).json({
        error: 'Нельзя удалить инструмент, пока часть экземпляров находится на руках у сотрудников.',
      });
      return;
    }

    if (db.prepare('SELECT 1 FROM warehouse_operations WHERE tool_id = ? LIMIT 1').get(id) || db.prepare('SELECT 1 FROM order_planned_resources WHERE tool_id = ? LIMIT 1').get(id)) {
      res.status(409).json({ error: 'Инструмент связан с учётной историей и не может быть удалён.' });
      return;
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM tools WHERE id = ?').run(id);
      writeAuditLog(db, user.id, 'tool', id, 'tool_deleted', { name: existing.name });
    });

    res.json({ ok: true, id });
  });

  // Issue or return tool
  router.post('/tools/:id/operations', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'warehouse.take')) {
      res.status(403).json({ error: 'Нет прав на выдачу/возврат инструментов.' });
      return;
    }

    const toolId = String(req.params.id);
    const { opType, toolInstanceId, qty, orderId, employeeUserId, note } = req.body as {
      opType: 'issue' | 'return';
      toolInstanceId?: string;
      qty?: number;
      orderId?: string | null;
      employeeUserId?: string;
      note?: string;
    };

    const holderId = user.role === 'admin' && employeeUserId ? employeeUserId : user.id;

    try {
      const opId = withTransaction(db, () => {
        if (opType === 'issue') {
          return issueToolTx(db, {
            toolId,
            toolInstanceId,
            qty: Number(qty || 1),
            orderId: orderId || null,
            holderUserId: holderId,
            actorUserId: user.id,
            note,
          });
        }
        if (opType === 'return') {
          return returnToolTx(db, {
            toolId,
            toolInstanceId,
            qty: Number(qty || 1),
            orderId: orderId || null,
            holderUserId: holderId,
            actorUserId: user.id,
            note,
            force: user.role === 'admin',
          });
        }
        throw new Error('Поддерживаются операции issue и return.');
      });

      res.status(201).json({ ok: true, operationId: opId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка операции с инструментом.' });
    }
  });

  return router;
}
