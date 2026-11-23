import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAuth, requireAdmin, type AuthedRequest } from '../middleware.ts';
import { hasPermission, writeAuditLog } from '../security.ts';
import { applyMaterialOperationTx, issueToolTx, returnToolTx } from '../services/warehouseService.ts';
import { reservationsFor } from '../services/reservations.ts';

export function createWarehouseRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/materials/:id/batches', requireAdmin, (req,res) => {
    const id=String(req.params.id);
    const material=db.prepare('SELECT id,quantity_milli,purchase_price_kopecks FROM materials WHERE id=?').get(id) as {id:string;quantity_milli:number;purchase_price_kopecks:number}|undefined;
    if(!material) {res.status(404).json({error:'Материал не найден.'});return;}
    const batches=db.prepare('SELECT id,received_qty_milli,remaining_qty_milli,unit_cost_kopecks,estimated,created_at FROM material_batches WHERE material_id=? ORDER BY seq').all(id) as Array<{remaining_qty_milli:number;unit_cost_kopecks:number}>;
    const receipts=db.prepare("SELECT id,qty_milli,unit_cost_kopecks,created_at FROM warehouse_operations WHERE item_type='material' AND material_id=? AND op_type='receipt' ORDER BY created_at DESC, rowid DESC").all(id) as Array<{qty_milli:number;unit_cost_kopecks:number}>;
    const avgCost = Number(material.purchase_price_kopecks || 0);
    const stockValue = Math.round((Math.max(0, Number(material.quantity_milli || 0)) * avgCost) / 1000);
    const purchasedValue=receipts.reduce((sum,r)=>sum+r.qty_milli*r.unit_cost_kopecks,0);
    res.json({batches,receipts,stockQtyMilli:material.quantity_milli,averageCostKopecks:avgCost,stockValueKopecks:stockValue,purchaseTotalKopecks:Math.round(purchasedValue/1000),costMethod:'weighted_average'});
  });

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

    const qtyHolderOrderRows = db
      .prepare(
        `SELECT wo.tool_id, wo.user_id, wo.order_id, o.order_number,
                SUM(CASE WHEN wo.op_type = 'issue' THEN wo.qty_milli ELSE 0 END) -
                SUM(CASE WHEN wo.op_type = 'return' THEN wo.qty_milli ELSE 0 END) as held_milli,
                MIN(wo.created_at) as first_issued_at
         FROM warehouse_operations wo
         JOIN tools t ON t.id = wo.tool_id
         LEFT JOIN orders o ON o.id = wo.order_id
         WHERE wo.item_type = 'tool' AND t.tracking_mode = 'quantity'
         GROUP BY wo.tool_id, wo.user_id, wo.order_id
         HAVING held_milli > 0
         ORDER BY first_issued_at ASC`
      )
      .all() as Array<{ tool_id: string; user_id: string; order_id: string | null; order_number: string | null; held_milli: number }>;

    const enrichedTools = tools.map((t) => ({
      ...t,
      instances: instances.filter((i) => i.tool_id === t.id),
      activeHolders: qtyHolderRows
        .filter((h) => h.tool_id === t.id)
        .map((h) => ({
          userId: h.user_id,
          holderName: h.holder_name || 'Сотрудник',
          qty: Math.round(h.held_milli / 1000),
          orderBreakdown: qtyHolderOrderRows
            .filter((r) => r.tool_id === t.id && r.user_id === h.user_id)
            .map((r) => ({
              orderId: r.order_id,
              orderNumber: r.order_number,
              qty: Math.round(r.held_milli / 1000),
            })),
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

    const materialsWithReservations=materials.map(m=>({...m,reserved_milli:reservationsFor(db,'material',String(m.id)).totalMilli}));
    const toolsWithReservations=enrichedTools.map((t,i)=>({...t,reserved_milli:reservationsFor(db,'tool',String(tools[i].id)).totalMilli}));
    res.json({ materials:materialsWithReservations, tools: toolsWithReservations, operations });
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

    if (initialQtyMilli !== undefined && (!Number.isSafeInteger(Number(initialQtyMilli)) || Number(initialQtyMilli) < 0)) {
      res.status(400).json({ error: 'Начальный остаток должен быть целым неотрицательным числом.' });
      return;
    }
    if (purchasePriceKopecks !== undefined && (!Number.isSafeInteger(Number(purchasePriceKopecks)) || Number(purchasePriceKopecks) < 0)) {
      res.status(400).json({ error: 'Цена закупки должна быть целым неотрицательным числом копеек.' });
      return;
    }
    if (minThresholdMilli !== undefined && (!Number.isSafeInteger(Number(minThresholdMilli)) || Number(minThresholdMilli) < 0)) {
      res.status(400).json({ error: 'Минимальный порог должен быть целым неотрицательным числом.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const qtyMilli = initialQtyMilli !== undefined ? Number(initialQtyMilli) : 0;
    const price = purchasePriceKopecks !== undefined ? Number(purchasePriceKopecks) : 0;
    const thresh = minThresholdMilli !== undefined ? Number(minThresholdMilli) : 0;

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
    if (b.purchasePriceKopecks !== undefined && (!Number.isSafeInteger(Number(b.purchasePriceKopecks)) || Number(b.purchasePriceKopecks) < 0)) {
      res.status(400).json({ error: 'Цена закупки должна быть целым неотрицательным числом копеек.' });
      return;
    }
    if (b.minThresholdMilli !== undefined && (!Number.isSafeInteger(Number(b.minThresholdMilli)) || Number(b.minThresholdMilli) < 0)) {
      res.status(400).json({ error: 'Минимальный порог должен быть целым неотрицательным числом.' });
      return;
    }
    db.prepare(
      `UPDATE materials SET name = ?, category = ?, unit = ?, purchase_price_kopecks = ?, min_threshold_milli = ? WHERE id = ?`
    ).run(
      b.name?.trim() || existing.name,
      b.category?.trim() || existing.category,
      b.unit?.trim() || existing.unit,
      b.purchasePriceKopecks !== undefined
        ? Number(b.purchasePriceKopecks)
        : existing.purchase_price_kopecks,
      b.minThresholdMilli !== undefined
        ? Number(b.minThresholdMilli)
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
    if (db.prepare('SELECT 1 FROM warehouse_operations WHERE material_id = ? LIMIT 1').get(id) || db.prepare('SELECT 1 FROM order_planned_resources WHERE material_id = ? LIMIT 1').get(id) || db.prepare('SELECT 1 FROM material_batches WHERE material_id = ? LIMIT 1').get(id)) {
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
    const { opType, qtyMilli, unitCostKopecks, orderId, note, confirmReserved } = req.body as {
      opType: 'receipt' | 'issue' | 'consume' | 'return' | 'adjust';
      qtyMilli: number;
      unitCostKopecks?: number;
      orderId?: string | null;
      note?: string;
      confirmReserved?: boolean;
    };
    if((opType==='issue' || opType==='return') && !orderId){res.status(400).json({error:'Для выдачи или возврата материала выберите заказ.'});return;}
    if(orderId) {
      const ord=db.prepare('SELECT id, status FROM orders WHERE id=?').get(orderId) as {id:string;status:string}|undefined;
      if(!ord){res.status(404).json({error:'Заказ не найден.'});return;}
      if(user.role!=='admin' && (ord.status==='completed' || ord.status==='cancelled')){res.status(403).json({error:'Заказ закрыт. Операции со складом по закрытому заказу доступны только администратору.'});return;}
      const assigned=db.prepare('SELECT 1 FROM order_assignees WHERE order_id=? AND user_id=? UNION SELECT 1 FROM visit_assignees a JOIN order_visits v ON v.id=a.visit_id WHERE v.order_id=? AND a.user_id=? LIMIT 1').get(orderId,user.id,orderId,user.id);
      if(user.role!=='admin' && !assigned){res.status(403).json({error:'Нет доступа к операциям этого заказа.'});return;}
    }

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
          confirmReserved:confirmReserved===true,
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

    if (totalQty !== undefined && (!Number.isSafeInteger(Number(totalQty)) || Number(totalQty) < 1)) {
      res.status(400).json({ error: 'Количество должно быть целым положительным числом.' });
      return;
    }

    const mode = trackingMode === 'individual' ? 'individual' : 'quantity';
    const cleanSerials =
      mode === 'individual'
        ? (Array.isArray(serialNumbers) ? serialNumbers.map((s) => String(s).trim()).filter(Boolean) : [])
        : [];

    const requestedQty = totalQty !== undefined ? Number(totalQty) : 1;
    const qty =
      mode === 'individual'
        ? Math.max(cleanSerials.length, requestedQty)
        : requestedQty;

    const finalSerials: string[] = [];
    if (mode === 'individual') {
      for (let i = 0; i < qty; i++) {
        finalSerials.push(cleanSerials[i] || `ИНВ-${String(i + 1).padStart(3, '0')}`);
      }
      if (new Set(finalSerials).size !== finalSerials.length) {
        res.status(400).json({ error: 'Инвентарные номера экземпляров не должны повторяться.' });
        return;
      }
    }

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
        for (const sn of finalSerials) {
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
          const toAdd = b.addSerials.map((s) => String(s).trim()).filter(Boolean);
          if (new Set(toAdd).size !== toAdd.length) {
            throw new Error('Инвентарные номера не должны повторяться.');
          }
          const chkInst = db.prepare('SELECT 1 FROM tool_instances WHERE tool_id = ? AND serial_number = ?');
          const insInst = db.prepare(
            `INSERT INTO tool_instances (id, tool_id, serial_number, status) VALUES (?, ?, ?, 'available')`
          );
          for (const sn of toAdd) {
            if (chkInst.get(id, sn)) {
              throw new Error(`Экземпляр с номером «${sn}» уже существует.`);
            }
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
    const { opType, toolInstanceId, qty, orderId, employeeUserId, note, confirmReserved } = req.body as {
      opType: 'issue' | 'return';
      toolInstanceId?: string;
      qty?: number;
      orderId?: string | null;
      employeeUserId?: string;
      note?: string;
      confirmReserved?: boolean;
    };

    if (opType !== 'issue' && opType !== 'return') {
      res.status(400).json({ error: 'Поддерживаются операции issue и return.' });
      return;
    }
    if (qty !== undefined && (!Number.isSafeInteger(Number(qty)) || Number(qty) < 1)) {
      res.status(400).json({ error: 'Укажите целое положительное количество инструмента.' });
      return;
    }

    if (orderId) {
      const ord = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId) as
        | { id: string; status: string }
        | undefined;
      if (!ord) {
        res.status(404).json({ error: 'Заказ не найден.' });
        return;
      }
      if (user.role !== 'admin' && (ord.status === 'completed' || ord.status === 'cancelled')) {
        res.status(403).json({ error: 'Заказ закрыт. Операции со складом по закрытому заказу доступны только администратору.' });
        return;
      }
      const assigned = db
        .prepare(
          'SELECT 1 FROM order_assignees WHERE order_id=? AND user_id=? UNION SELECT 1 FROM visit_assignees a JOIN order_visits v ON v.id=a.visit_id WHERE v.order_id=? AND a.user_id=? LIMIT 1'
        )
        .get(orderId, user.id, orderId, user.id);
      if (user.role !== 'admin' && !assigned) {
        res.status(403).json({ error: 'Нет доступа к операциям этого заказа.' });
        return;
      }
    }

    if (user.role === 'admin' && employeeUserId) {
      const empExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(employeeUserId);
      if (!empExists) {
        res.status(404).json({ error: 'Сотрудник не найден.' });
        return;
      }
    }

    const holderId = user.role === 'admin' && employeeUserId ? employeeUserId : user.id;
    const resolvedQty = qty !== undefined ? Number(qty) : 1;

    try {
      const opId = withTransaction(db, () => {
        if (opType === 'issue') {
          return issueToolTx(db, {
            toolId,
            toolInstanceId,
            qty: resolvedQty,
            orderId: orderId || null,
            holderUserId: holderId,
            actorUserId: user.id,
            note,
            confirmReserved: confirmReserved === true,
          });
        }
        return returnToolTx(db, {
          toolId,
          toolInstanceId,
          qty: resolvedQty,
          orderId: orderId || null,
          holderUserId: holderId,
          actorUserId: user.id,
          note,
          force: user.role === 'admin',
        });
      });

      res.status(201).json({ ok: true, operationId: opId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка операции с инструментом.' });
    }
  });

  return router;
}
