import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { hasPermission, notifyUser, writeAuditLog } from '../security.ts';
import { applyMaterialOperationTx } from '../services/warehouseService.ts';

export function createShiftsRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/active', requireAuth, (req: AuthedRequest, res) => {
    const row = db
      .prepare("SELECT * FROM workshop_shifts WHERE user_id = ? AND status = 'active' LIMIT 1")
      .get(req.authUser!.id);
    res.json({ activeShift: row || null });
  });

  router.get('/', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'admin') {
      const targetUserId = req.query.userId ? String(req.query.userId) : null;
      const rows = targetUserId
        ? db
            .prepare(
              `SELECT ws.*, u.full_name as employee_name
               FROM workshop_shifts ws
               JOIN users u ON u.id = ws.user_id
               WHERE ws.user_id = ?
               ORDER BY ws.started_at DESC`
            )
            .all(targetUserId)
        : db
            .prepare(
              `SELECT ws.*, u.full_name as employee_name
               FROM workshop_shifts ws
               JOIN users u ON u.id = ws.user_id
               ORDER BY ws.started_at DESC`
            )
            .all();
      res.json({ shifts: rows });
      return;
    }

    const rows = db
      .prepare('SELECT * FROM workshop_shifts WHERE user_id = ? ORDER BY started_at DESC')
      .all(user.id);
    res.json({ shifts: rows });
  });

  router.post('/start', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const shiftId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      const shift = withTransaction(db, () => {
        const existing = db
          .prepare("SELECT id FROM workshop_shifts WHERE user_id = ? AND status = 'active'")
          .get(user.id);
        if (existing) {
          throw new Error('У вас уже запущена активная смена в цеху.');
        }

        const userRow = db
          .prepare('SELECT shift_rate_kopecks FROM users WHERE id = ?')
          .get(user.id) as { shift_rate_kopecks: number };

        db.prepare(
          `INSERT INTO workshop_shifts (id, user_id, started_at, ended_at, work_done, status, rate_snapshot_kopecks, created_at)
           VALUES (?, ?, ?, NULL, '', 'active', ?, ?)`
        ).run(shiftId, user.id, now, userRow.shift_rate_kopecks, now);

        writeAuditLog(db, user.id, 'shift', shiftId, 'shift_started', { startedAt: now });
        return db.prepare('SELECT * FROM workshop_shifts WHERE id = ?').get(shiftId);
      });

      res.status(201).json({ shift });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Не удалось начать смену.' });
    }
  });

  router.post('/finish', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const { workDone, materials, shiftId } = req.body as {
      workDone?: string;
      shiftId?: string;
      materials?: Array<{ materialId: string; qtyMilli: number; note?: string }>;
    };

    if (!workDone || !workDone.trim()) {
      res.status(400).json({ error: 'Опишите работу, выполненную за смену.' });
      return;
    }

    const now = new Date().toISOString();

    try {
      const result = withTransaction(db, () => {
        const active = db
          .prepare("SELECT * FROM workshop_shifts WHERE user_id = ? AND status = 'active'")
          .get(user.id) as
          | { id: string; user_id: string; started_at: string; rate_snapshot_kopecks: number }
          | undefined;

        if (!active) {
          throw new Error('Активная смена не найдена.');
        }
        if(shiftId && shiftId!==active.id) throw new Error('Активная смена изменилась. Обновите данные.');

        // Snapshot current employee shift rate at completion time
        const userRow = db
          .prepare('SELECT shift_rate_kopecks FROM users WHERE id = ?')
          .get(user.id) as { shift_rate_kopecks: number };
        const effectiveRate = userRow.shift_rate_kopecks;

        db.prepare(
          `UPDATE workshop_shifts
           SET ended_at = ?, work_done = ?, status = 'completed', rate_snapshot_kopecks = ?
           WHERE id = ?`
        ).run(now, workDone.trim(), effectiveRate, active.id);

        // Automatic salary accrual based on frozen rate_snapshot_kopecks
        db.prepare(
          `INSERT INTO salary_accruals (id, user_id, source_type, source_id, amount_kopecks, description, created_by, created_at)
           VALUES (?, ?, 'shift', ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          user.id,
          active.id,
          effectiveRate,
          `Смена в цеху (${active.started_at.slice(0, 10)})`,
          user.id,
          now
        );

        let negativeWarning = false;
        if (Array.isArray(materials) && materials.length > 0) {
          if (user.role !== 'admin' && !hasPermission(user, 'warehouse.take')) {
            throw new Error('Нет прав на списание материалов со склада.');
          }
          for (const m of materials) {
            if (!m.materialId || Number(m.qtyMilli) <= 0) continue;
            const opRes = applyMaterialOperationTx(db, {
              materialId: m.materialId,
              opType: 'consume',
              qtyMilli: Number(m.qtyMilli),
              shiftId: active.id,
              employeeUserId: user.id,
              actorUserId: user.id,
              note: m.note || 'Списание при завершении смены в цеху',
            });
            if (opRes.negativeStockWarning) negativeWarning = true;
          }
        }

        notifyUser(
          db,
          user.id,
          'salary_accrued',
          'Начислена оплата за смену',
          `Смена завершена. Начислено ${(effectiveRate / 100).toLocaleString('ru-RU')} ₽.`,
          'salary',
          active.id
        );

        writeAuditLog(db, user.id, 'shift', active.id, 'shift_completed', {
          rateSnapshotKopecks: effectiveRate,
        });

        const completedShift = db.prepare('SELECT * FROM workshop_shifts WHERE id = ?').get(active.id);
        return { shift: completedShift, accruedKopecks: effectiveRate, negativeWarning };
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Не удалось завершить смену.' });
    }
  });

  return router;
}
