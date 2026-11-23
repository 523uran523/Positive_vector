import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAdmin, requireAuth, type AuthedRequest } from '../middleware.ts';
import { hasPermission, notifyAdmins, notifyUser, writeAuditLog } from '../security.ts';
import { applyMaterialOperationTx } from '../services/warehouseService.ts';

export type ShiftTargetType = 'workshop' | 'visit' | 'quick_task';

export function clampTzOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-840, Math.min(840, Math.round(n)));
}

export function todayForOffset(tzOffsetMinutes = 0): string {
  const offset = clampTzOffset(tzOffsetMinutes);
  return new Date(Date.now() - offset * 60_000).toISOString().slice(0, 10);
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validHm(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function formatIsoToHm(iso: string | null | undefined, tzOffsetMinutes = 0): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const offset = clampTzOffset(tzOffsetMinutes);
  return new Date(ts - offset * 60_000).toISOString().slice(11, 16);
}

export function hmToIso(dateStr: string, hm: string, tzOffsetMinutes = 0): string {
  const offset = clampTzOffset(tzOffsetMinutes);
  const baseMs = Date.parse(`${dateStr}T${hm}:00.000Z`);
  return new Date(baseMs + offset * 60_000).toISOString();
}

export function syncVisitWorkTimeFromShifts(
  db: DatabaseSync,
  visitId: string,
  userId: string,
  workDate: string,
  tzOffsetMinutes = 0
): void {
  const rows = db
    .prepare(
      `SELECT started_at, ended_at
       FROM workshop_shifts
       WHERE visit_id = ? AND user_id = ? AND work_date = ? AND status = 'completed' AND ended_at IS NOT NULL
       ORDER BY started_at ASC`
    )
    .all(visitId, userId, workDate) as Array<{ started_at: string; ended_at: string }>;

  if (rows.length === 0) return;

  let minStart = rows[0].started_at;
  let maxEnd = rows[0].ended_at;
  for (const r of rows) {
    if (Date.parse(r.started_at) < Date.parse(minStart)) minStart = r.started_at;
    if (Date.parse(r.ended_at) > Date.parse(maxEnd)) maxEnd = r.ended_at;
  }

  const startTime = formatIsoToHm(minStart, tzOffsetMinutes);
  const endTime = formatIsoToHm(maxEnd, tzOffsetMinutes);
  if (!startTime || !endTime) return;

  db.prepare(
    `INSERT INTO visit_work_times(visit_id, user_id, work_date, start_time, end_time, updated_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(visit_id, user_id, work_date)
     DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, updated_at = excluded.updated_at`
  ).run(visitId, userId, workDate, startTime, endTime, new Date().toISOString());
}

function getShiftSelectSql(whereClause: string, orderClause = 'ORDER BY ws.started_at DESC'): string {
  return `
    SELECT ws.*,
           u.full_name as employee_name,
           o.order_number,
           o.title as order_title,
           o.address as order_address,
           o.status as order_status,
           ov.title as visit_title,
           ov.scheduled_at as visit_scheduled_at,
           qt.title as quick_task_title,
           qt.due_date as quick_task_due_date,
           sa.amount_kopecks as wage_kopecks,
           sa.created_at as wage_assigned_at
    FROM workshop_shifts ws
    JOIN users u ON u.id = ws.user_id
    LEFT JOIN orders o ON o.id = ws.order_id
    LEFT JOIN order_visits ov ON ov.id = ws.visit_id
    LEFT JOIN quick_tasks qt ON qt.id = ws.quick_task_id
    LEFT JOIN salary_accruals sa ON sa.source_type = 'shift' AND sa.source_id = ws.id AND sa.user_id = ws.user_id
    ${whereClause}
    ${orderClause}
  `;
}

function sanitizeShiftRow(row: Record<string, unknown> | undefined, viewerUserId: string, isAdmin: boolean) {
  if (!row) return null;
  const startedMs = Date.parse(String(row.started_at || ''));
  const endedMs = row.ended_at ? Date.parse(String(row.ended_at)) : NaN;
  const durationMinutes =
    Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, Math.round((endedMs - startedMs) / 60_000))
      : null;

  const base: Record<string, unknown> = {
    ...row,
    work_date: row.work_date || String(row.started_at || '').slice(0, 10),
    shift_type: row.shift_type || 'workshop',
    is_manual_entry: Number(row.is_manual_entry || 0),
    wage_kopecks: row.wage_kopecks !== null && row.wage_kopecks !== undefined ? Number(row.wage_kopecks) : null,
    duration_minutes: durationMinutes,
  };

  if (!isAdmin && row.user_id !== viewerUserId) {
    delete base.rate_snapshot_kopecks;
    delete base.wage_kopecks;
    delete base.wage_assigned_at;
  }
  return base;
}

export function computeTodayOptions(db: DatabaseSync, userId: string, dateStr: string) {
  const visitRows = db
    .prepare(
      `SELECT DISTINCT ov.id as visit_id, ov.order_id, ov.title as visit_title, ov.scheduled_at, ov.status as visit_status,
              o.order_number, o.title as order_title, o.address as order_address, o.status as order_status
       FROM order_visits ov
       JOIN orders o ON o.id = ov.order_id
       WHERE substr(ov.scheduled_at, 1, 10) = ?
         AND ov.status IN ('planned', 'in_progress')
         AND o.status NOT IN ('completed', 'cancelled')
         AND (
           EXISTS (SELECT 1 FROM visit_assignees va WHERE va.visit_id = ov.id AND va.user_id = ?)
           OR (
             NOT EXISTS (SELECT 1 FROM visit_assignees va2 WHERE va2.visit_id = ov.id)
             AND EXISTS (SELECT 1 FROM order_assignees oa WHERE oa.order_id = o.id AND oa.user_id = ?)
           )
         )
       ORDER BY ov.scheduled_at ASC`
    )
    .all(dateStr, userId, userId) as Array<{
    visit_id: string;
    order_id: string;
    visit_title: string;
    scheduled_at: string;
    visit_status: string;
    order_number: string;
    order_title: string;
    order_address: string;
    order_status: string;
  }>;

  const visits = visitRows.map((v) => {
    const hasLoggedShift = Boolean(
      db
        .prepare('SELECT 1 FROM workshop_shifts WHERE user_id = ? AND work_date = ? AND visit_id = ? LIMIT 1')
        .get(userId, dateStr, v.visit_id)
    );
    return {
      targetType: 'visit' as const,
      orderId: v.order_id,
      visitId: v.visit_id,
      quickTaskId: null,
      orderNumber: v.order_number,
      orderTitle: v.order_title,
      visitTitle: v.visit_title,
      address: v.order_address,
      scheduledAt: v.scheduled_at,
      status: v.visit_status,
      hasLoggedShift,
    };
  });

  const orderRows = db
    .prepare(
      `SELECT DISTINCT o.id as order_id, o.order_number, o.title as order_title, o.scheduled_at, o.address as order_address, o.status as order_status
       FROM orders o
       JOIN order_assignees oa ON oa.order_id = o.id AND oa.user_id = ?
       WHERE substr(COALESCE(o.scheduled_at, ''), 1, 10) = ?
         AND o.status NOT IN ('completed', 'cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM order_visits ov
           WHERE ov.order_id = o.id
             AND substr(ov.scheduled_at, 1, 10) = ?
             AND ov.status != 'cancelled'
         )
       ORDER BY o.scheduled_at ASC`
    )
    .all(userId, dateStr, dateStr) as Array<{
    order_id: string;
    order_number: string;
    order_title: string;
    scheduled_at: string;
    order_address: string;
    order_status: string;
  }>;

  const orders = orderRows.map((o) => {
    const hasLoggedShift = Boolean(
      db
        .prepare('SELECT 1 FROM workshop_shifts WHERE user_id = ? AND work_date = ? AND order_id = ? LIMIT 1')
        .get(userId, dateStr, o.order_id)
    );
    return {
      targetType: 'visit' as const,
      orderId: o.order_id,
      visitId: null,
      quickTaskId: null,
      orderNumber: o.order_number,
      orderTitle: o.order_title,
      visitTitle: null,
      address: o.order_address,
      scheduledAt: o.scheduled_at,
      status: o.order_status,
      hasLoggedShift,
    };
  });

  const taskRows = db
    .prepare(
      `SELECT qt.id as quick_task_id, qt.title, qt.description, qt.due_date, qt.order_id,
              o.order_number, o.title as order_title
       FROM quick_tasks qt
       JOIN quick_task_assignees qta ON qta.task_id = qt.id AND qta.user_id = ?
       LEFT JOIN orders o ON o.id = qt.order_id
       WHERE (qt.due_date = ? OR qt.due_date = '')
         AND qt.status = 'open'
         AND qt.cancelled_at IS NULL
       ORDER BY CASE WHEN qt.due_date = '' THEN 1 ELSE 0 END, qt.created_at ASC`
    )
    .all(userId, dateStr) as Array<{
    quick_task_id: string;
    title: string;
    description: string;
    due_date: string;
    order_id: string | null;
    order_number: string | null;
    order_title: string | null;
  }>;

  const quickTasks = taskRows.map((t) => {
    const hasLoggedShift = Boolean(
      db
        .prepare('SELECT 1 FROM workshop_shifts WHERE user_id = ? AND work_date = ? AND quick_task_id = ? LIMIT 1')
        .get(userId, dateStr, t.quick_task_id)
    );
    return {
      targetType: 'quick_task' as const,
      orderId: t.order_id,
      visitId: null,
      quickTaskId: t.quick_task_id,
      title: t.title,
      description: t.description,
      dueDate: t.due_date,
      orderNumber: t.order_number,
      orderTitle: t.order_title,
      hasLoggedShift,
    };
  });

  const totalTargets = visits.length + orders.length + quickTasks.length;
  const uncoveredCount =
    visits.filter((v) => !v.hasLoggedShift).length +
    orders.filter((o) => !o.hasLoggedShift).length +
    quickTasks.filter((t) => !t.hasLoggedShift && Boolean(t.dueDate)).length;

  return {
    date: dateStr,
    visits,
    orders,
    quickTasks,
    totalTargets,
    uncoveredCount,
  };
}

function validateAndResolveShiftTarget(
  db: DatabaseSync,
  user: NonNullable<AuthedRequest['authUser']>,
  input: {
    targetType?: unknown;
    orderId?: unknown;
    visitId?: unknown;
    quickTaskId?: unknown;
  },
  options: { allowClosedForAdmin?: boolean; allowCompleted?: boolean; activatePlanned?: boolean } = {}
): {
  shiftType: ShiftTargetType;
  orderId: string | null;
  visitId: string | null;
  quickTaskId: string | null;
} {
  const targetType = input.targetType;
  if (targetType !== 'workshop' && targetType !== 'visit' && targetType !== 'quick_task') {
    throw new Error('Укажите корректный тип смены (цех, монтаж или быстрая задача).');
  }

  const isAdmin = user.role === 'admin';
  const now = new Date().toISOString();

  if (targetType === 'workshop') {
    return { shiftType: 'workshop', orderId: null, visitId: null, quickTaskId: null };
  }

  if (targetType === 'visit') {
    const visitId = typeof input.visitId === 'string' && input.visitId.trim() ? input.visitId.trim() : null;
    const rawOrderId = typeof input.orderId === 'string' && input.orderId.trim() ? input.orderId.trim() : null;

    if (visitId) {
      const visit = db
        .prepare(
          `SELECT ov.id, ov.order_id, ov.status as visit_status, o.status as order_status
           FROM order_visits ov
           JOIN orders o ON o.id = ov.order_id
           WHERE ov.id = ?`
        )
        .get(visitId) as
        | { id: string; order_id: string; visit_status: string; order_status: string }
        | undefined;
      if (!visit) throw new Error('Выезд не найден.');
      if (rawOrderId && rawOrderId !== visit.order_id) throw new Error('Выезд не относится к указанному заказу.');
      if (visit.visit_status === 'cancelled') throw new Error('Нельзя отметить смену по отменённому выезду.');
      const blockedOrder =
        visit.order_status === 'cancelled'
          ? !(isAdmin && options.allowClosedForAdmin)
          : visit.order_status === 'completed'
            ? !(options.allowCompleted || (isAdmin && options.allowClosedForAdmin))
            : false;
      if (blockedOrder) {
        throw new Error('Заказ закрыт. Нельзя запускать или отмечать смену по закрытому заказу.');
      }

      if (!isAdmin) {
        const assigned =
          db.prepare('SELECT 1 FROM visit_assignees WHERE visit_id = ? AND user_id = ?').get(visit.id, user.id) ||
          db.prepare('SELECT 1 FROM order_assignees WHERE order_id = ? AND user_id = ?').get(visit.order_id, user.id);
        if (!assigned && !hasPermission(user, 'orders.view_all')) {
          throw new Error('Вы не назначены на этот выезд.');
        }
      }

      if (options.activatePlanned) {
        if (visit.visit_status === 'planned') {
          db.prepare("UPDATE order_visits SET status = 'in_progress' WHERE id = ?").run(visit.id);
        }
        if (visit.order_status === 'new') {
          db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, visit.order_id);
        }
      }

      return { shiftType: 'visit', orderId: visit.order_id, visitId: visit.id, quickTaskId: null };
    }

    if (rawOrderId) {
      const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(rawOrderId) as
        | { id: string; status: string }
        | undefined;
      if (!order) throw new Error('Заказ не найден.');
      const blockedOrder =
        order.status === 'cancelled'
          ? !(isAdmin && options.allowClosedForAdmin)
          : order.status === 'completed'
            ? !(options.allowCompleted || (isAdmin && options.allowClosedForAdmin))
            : false;
      if (blockedOrder) {
        throw new Error('Заказ закрыт. Нельзя запускать или отмечать смену по закрытому заказу.');
      }
      if (!isAdmin) {
        const assigned = db
          .prepare('SELECT 1 FROM order_assignees WHERE order_id = ? AND user_id = ?')
          .get(order.id, user.id);
        if (!assigned && !hasPermission(user, 'orders.view_all')) {
          throw new Error('Вы не назначены на этот заказ.');
        }
      }
      if (options.activatePlanned && order.status === 'new') {
        db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, order.id);
      }
      return { shiftType: 'visit', orderId: order.id, visitId: null, quickTaskId: null };
    }

    throw new Error('Укажите выезд или заказ для привязки смены.');
  }

  // quick_task
  const quickTaskId =
    typeof input.quickTaskId === 'string' && input.quickTaskId.trim() ? input.quickTaskId.trim() : null;
  if (!quickTaskId) {
    throw new Error('Укажите быструю задачу.');
  }
  const qt = db
    .prepare('SELECT id, order_id, status, cancelled_at FROM quick_tasks WHERE id = ?')
    .get(quickTaskId) as
    | { id: string; order_id: string | null; status: string; cancelled_at: string | null }
    | undefined;
  if (!qt) throw new Error('Быстрая задача не найдена.');
  const blockedQuickTask = qt.cancelled_at
    ? !(isAdmin && options.allowClosedForAdmin)
    : qt.status !== 'open'
      ? !(options.allowCompleted || (isAdmin && options.allowClosedForAdmin))
      : false;
  if (blockedQuickTask) {
    throw new Error('Быстрая задача уже завершена или отменена.');
  }
  if (!isAdmin) {
    const assigned = db
      .prepare('SELECT 1 FROM quick_task_assignees WHERE task_id = ? AND user_id = ?')
      .get(qt.id, user.id);
    if (!assigned) throw new Error('Вы не назначены на эту быструю задачу.');
  }
  return {
    shiftType: 'quick_task',
    orderId: qt.order_id || null,
    visitId: null,
    quickTaskId: qt.id,
  };
}

export function createShiftsRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/active', requireAuth, (req: AuthedRequest, res) => {
    const row = db
      .prepare(getShiftSelectSql("WHERE ws.user_id = ? AND ws.status = 'active'", 'LIMIT 1'))
      .get(req.authUser!.id) as Record<string, unknown> | undefined;
    res.json({ activeShift: sanitizeShiftRow(row, req.authUser!.id, req.authUser!.role === 'admin') });
  });

  router.get('/today-options', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const tzOffset = clampTzOffset(req.query.tzOffsetMinutes);
    const requestedDate = req.query.date ? String(req.query.date) : '';
    const dateStr = validDate(requestedDate) ? requestedDate : todayForOffset(tzOffset);
    const options = computeTodayOptions(db, user.id, dateStr);
    res.json(options);
  });

  router.get('/edit-requests', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const isAdmin = user.role === 'admin';
    const statusFilter = req.query.status ? String(req.query.status).trim() : '';

    const whereParts: string[] = [];
    const params: Array<string> = [];
    if (!isAdmin) {
      whereParts.push('r.user_id = ?');
      params.push(user.id);
    } else if (req.query.userId) {
      whereParts.push('r.user_id = ?');
      params.push(String(req.query.userId));
    }
    if (statusFilter && ['pending', 'approved', 'rejected'].includes(statusFilter)) {
      whereParts.push('r.status = ?');
      params.push(statusFilter);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT r.*,
                u.full_name as employee_name,
                rev.full_name as reviewer_name,
                ws.started_at as original_started_at,
                ws.ended_at as original_ended_at,
                ws.work_done as original_work_done,
                o.order_number,
                o.title as order_title,
                ov.title as visit_title,
                qt.title as quick_task_title
         FROM shift_edit_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users rev ON rev.id = r.reviewed_by
         LEFT JOIN workshop_shifts ws ON ws.id = r.shift_id
         LEFT JOIN orders o ON o.id = r.order_id
         LEFT JOIN order_visits ov ON ov.id = r.visit_id
         LEFT JOIN quick_tasks qt ON qt.id = r.quick_task_id
         ${whereSql}
         ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC
         LIMIT 200`
      )
      .all(...params);

    res.json({ requests: rows });
  });

  router.post('/edit-requests', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const body = (req.body || {}) as {
      shiftId?: string | null;
      targetType?: ShiftTargetType;
      orderId?: string | null;
      visitId?: string | null;
      quickTaskId?: string | null;
      workDate?: string;
      requestedStartTime?: string;
      requestedEndTime?: string;
      requestedStartedAt?: string;
      requestedEndedAt?: string;
      workDone?: string;
      reason?: string;
      tzOffsetMinutes?: number;
    };

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 1000) {
      res.status(400).json({ error: 'Укажите причину запроса (до 1000 символов).' });
      return;
    }

    const tzOffset = clampTzOffset(body.tzOffsetMinutes);
    const shiftId = typeof body.shiftId === 'string' && body.shiftId.trim() ? body.shiftId.trim() : null;

    let origShift:
      | {
          id: string;
          user_id: string;
          shift_type: ShiftTargetType;
          order_id: string | null;
          visit_id: string | null;
          quick_task_id: string | null;
          work_date: string;
          work_done: string;
        }
      | undefined;

    if (shiftId) {
      origShift = db.prepare('SELECT * FROM workshop_shifts WHERE id = ?').get(shiftId) as typeof origShift;
      if (!origShift) {
        res.status(404).json({ error: 'Смена не найдена.' });
        return;
      }
      if (user.role !== 'admin' && origShift.user_id !== user.id) {
        res.status(403).json({ error: 'Можно запрашивать правку только своей смены.' });
        return;
      }
    }

    const workDate =
      (validDate(body.workDate) ? body.workDate : null) ||
      origShift?.work_date ||
      (body.requestedStartedAt ? String(body.requestedStartedAt).slice(0, 10) : null);
    if (!workDate || !validDate(workDate)) {
      res.status(400).json({ error: 'Укажите корректную дату смены.' });
      return;
    }

    let requestedStartedAt = '';
    let requestedEndedAt = '';
    if (body.requestedStartedAt && body.requestedEndedAt) {
      if (!Number.isFinite(Date.parse(body.requestedStartedAt)) || !Number.isFinite(Date.parse(body.requestedEndedAt))) {
        res.status(400).json({ error: 'Укажите корректное время начала и окончания.' });
        return;
      }
      requestedStartedAt = new Date(body.requestedStartedAt).toISOString();
      requestedEndedAt = new Date(body.requestedEndedAt).toISOString();
    } else if (validHm(body.requestedStartTime) && validHm(body.requestedEndTime)) {
      requestedStartedAt = hmToIso(workDate, body.requestedStartTime, tzOffset);
      requestedEndedAt = hmToIso(workDate, body.requestedEndTime, tzOffset);
    } else {
      res.status(400).json({ error: 'Укажите время начала и окончания (ЧЧ:ММ).' });
      return;
    }

    if (Date.parse(requestedEndedAt) <= Date.parse(requestedStartedAt)) {
      res.status(400).json({ error: 'Время окончания должно быть позже времени начала.' });
      return;
    }

    let resolvedTarget: {
      shiftType: ShiftTargetType;
      orderId: string | null;
      visitId: string | null;
      quickTaskId: string | null;
    };
    try {
      resolvedTarget = validateAndResolveShiftTarget(
        db,
        user,
        {
          targetType: body.targetType || origShift?.shift_type || 'workshop',
          orderId: body.orderId !== undefined ? body.orderId : origShift?.order_id,
          visitId: body.visitId !== undefined ? body.visitId : origShift?.visit_id,
          quickTaskId: body.quickTaskId !== undefined ? body.quickTaskId : origShift?.quick_task_id,
        },
        { allowClosedForAdmin: true, allowCompleted: true, activatePlanned: false }
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Некорректная цель смены.' });
      return;
    }

    const workDone =
      typeof body.workDone === 'string' && body.workDone.trim()
        ? body.workDone.trim()
        : origShift?.work_done || '';

    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO shift_edit_requests
         (id, shift_id, user_id, target_type, order_id, visit_id, quick_task_id, work_date,
          requested_started_at, requested_ended_at, work_done, reason, status, admin_comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?)`
      ).run(
        requestId,
        shiftId,
        origShift ? origShift.user_id : user.id,
        resolvedTarget.shiftType,
        resolvedTarget.orderId,
        resolvedTarget.visitId,
        resolvedTarget.quickTaskId,
        workDate,
        requestedStartedAt,
        requestedEndedAt,
        workDone,
        reason,
        now
      );

      notifyAdmins(
        db,
        'shift_edit_requested',
        'Запрос на корректировку смены',
        `${user.fullName} · ${workDate} (${formatIsoToHm(requestedStartedAt, tzOffset)}–${formatIsoToHm(requestedEndedAt, tzOffset)}): ${reason}`,
        'shift_edit_request',
        requestId,
        user.id
      );

      writeAuditLog(db, user.id, 'shift_edit_request', requestId, 'shift_edit_requested', {
        shiftId,
        workDate,
        reason,
      });
    });

    const created = db
      .prepare(
        `SELECT r.*, u.full_name as employee_name, o.order_number, o.title as order_title,
                ov.title as visit_title, qt.title as quick_task_title
         FROM shift_edit_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN orders o ON o.id = r.order_id
         LEFT JOIN order_visits ov ON ov.id = r.visit_id
         LEFT JOIN quick_tasks qt ON qt.id = r.quick_task_id
         WHERE r.id = ?`
      )
      .get(requestId);
    res.status(201).json({ request: created });
  });

  router.post('/edit-requests/:id/review', requireAdmin, (req: AuthedRequest, res) => {
    const admin = req.authUser!;
    const id = String(req.params.id);
    const { decision, adminComment, tzOffsetMinutes } = (req.body || {}) as {
      decision?: 'approve' | 'reject';
      adminComment?: string;
      tzOffsetMinutes?: number;
    };

    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: 'Укажите решение: approve или reject.' });
      return;
    }

    const reqRow = db.prepare('SELECT * FROM shift_edit_requests WHERE id = ?').get(id) as
      | {
          id: string;
          shift_id: string | null;
          user_id: string;
          target_type: ShiftTargetType;
          order_id: string | null;
          visit_id: string | null;
          quick_task_id: string | null;
          work_date: string;
          requested_started_at: string;
          requested_ended_at: string;
          work_done: string;
          reason: string;
          status: string;
        }
      | undefined;

    if (!reqRow) {
      res.status(404).json({ error: 'Запрос не найден.' });
      return;
    }
    if (reqRow.status !== 'pending') {
      res.status(409).json({ error: 'Запрос уже рассмотрен.' });
      return;
    }

    const now = new Date().toISOString();
    const comment = typeof adminComment === 'string' ? adminComment.trim() : '';
    const tzOffset = clampTzOffset(tzOffsetMinutes);

    let resultingShiftId = reqRow.shift_id;
    withTransaction(db, () => {
      if (decision === 'approve') {
        if (reqRow.shift_id && db.prepare('SELECT 1 FROM workshop_shifts WHERE id = ?').get(reqRow.shift_id)) {
          db.prepare(
            `UPDATE workshop_shifts
             SET started_at = ?, ended_at = ?, work_date = ?, shift_type = ?,
                 order_id = ?, visit_id = ?, quick_task_id = ?, status = 'completed',
                 work_done = CASE WHEN ? != '' THEN ? ELSE work_done END
             WHERE id = ?`
          ).run(
            reqRow.requested_started_at,
            reqRow.requested_ended_at,
            reqRow.work_date,
            reqRow.target_type,
            reqRow.order_id,
            reqRow.visit_id,
            reqRow.quick_task_id,
            reqRow.work_done,
            reqRow.work_done,
            reqRow.shift_id
          );
          resultingShiftId = reqRow.shift_id;
        } else {
          resultingShiftId = crypto.randomUUID();
          const emp = db
            .prepare('SELECT shift_rate_kopecks FROM users WHERE id = ?')
            .get(reqRow.user_id) as { shift_rate_kopecks: number } | undefined;
          db.prepare(
            `INSERT INTO workshop_shifts
             (id, user_id, started_at, ended_at, work_done, status, rate_snapshot_kopecks, created_at,
              shift_type, order_id, visit_id, quick_task_id, work_date, is_manual_entry)
             VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, 1)`
          ).run(
            resultingShiftId,
            reqRow.user_id,
            reqRow.requested_started_at,
            reqRow.requested_ended_at,
            reqRow.work_done || reqRow.reason,
            emp?.shift_rate_kopecks ?? 0,
            now,
            reqRow.target_type,
            reqRow.order_id,
            reqRow.visit_id,
            reqRow.quick_task_id,
            reqRow.work_date
          );
        }

        if (reqRow.visit_id) {
          syncVisitWorkTimeFromShifts(db, reqRow.visit_id, reqRow.user_id, reqRow.work_date, tzOffset);
          const startHm = formatIsoToHm(reqRow.requested_started_at, tzOffset);
          const endHm = formatIsoToHm(reqRow.requested_ended_at, tzOffset);
          if (startHm && endHm) {
            db.prepare('UPDATE visit_reports SET start_time = ?, end_time = ? WHERE visit_id = ? AND user_id = ?').run(
              startHm,
              endHm,
              reqRow.visit_id,
              reqRow.user_id
            );
          }
        }
      }

      db.prepare(
        `UPDATE shift_edit_requests
         SET status = ?, admin_comment = ?, reviewed_by = ?, reviewed_at = ?, shift_id = COALESCE(shift_id, ?)
         WHERE id = ?`
      ).run(
        decision === 'approve' ? 'approved' : 'rejected',
        comment,
        admin.id,
        now,
        decision === 'approve' ? resultingShiftId : null,
        id
      );

      notifyUser(
        db,
        reqRow.user_id,
        'shift_edit_reviewed',
        decision === 'approve' ? 'Запрос на правку смены принят' : 'Запрос на правку смены отклонён',
        `${reqRow.work_date}${comment ? ` · ${comment}` : ''}`,
        decision === 'approve' ? 'shift' : 'shift_edit_request',
        decision === 'approve' && resultingShiftId ? resultingShiftId : id
      );

      writeAuditLog(db, admin.id, 'shift_edit_request', id, `shift_edit_${decision}`, {
        shiftId: resultingShiftId,
        adminComment: comment,
      });
    });

    const updatedReq = db
      .prepare(
        `SELECT r.*, u.full_name as employee_name, rev.full_name as reviewer_name,
                o.order_number, o.title as order_title, ov.title as visit_title, qt.title as quick_task_title
         FROM shift_edit_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users rev ON rev.id = r.reviewed_by
         LEFT JOIN orders o ON o.id = r.order_id
         LEFT JOIN order_visits ov ON ov.id = r.visit_id
         LEFT JOIN quick_tasks qt ON qt.id = r.quick_task_id
         WHERE r.id = ?`
      )
      .get(id);
    const updatedShift = resultingShiftId
      ? sanitizeShiftRow(
          db.prepare(getShiftSelectSql('WHERE ws.id = ?', '')).get(resultingShiftId) as Record<string, unknown> | undefined,
          admin.id,
          true
        )
      : null;

    res.json({ request: updatedReq, shift: updatedShift });
  });

  router.get('/', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const isAdmin = user.role === 'admin';
    const whereParts: string[] = [];
    const params: Array<string> = [];

    if (!isAdmin) {
      whereParts.push('ws.user_id = ?');
      params.push(user.id);
    } else if (req.query.userId) {
      whereParts.push('ws.user_id = ?');
      params.push(String(req.query.userId));
    }

    if (req.query.orderId) {
      whereParts.push('ws.order_id = ?');
      params.push(String(req.query.orderId));
    }
    if (req.query.date && validDate(String(req.query.date))) {
      whereParts.push("COALESCE(NULLIF(ws.work_date, ''), substr(ws.started_at, 1, 10)) = ?");
      params.push(String(req.query.date));
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const rows = db
      .prepare(getShiftSelectSql(whereClause))
      .all(...params) as Array<Record<string, unknown>>;

    res.json({
      shifts: rows.map((r) => sanitizeShiftRow(r, user.id, isAdmin)),
    });
  });

  router.post('/start', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const body = (req.body || {}) as {
      targetType?: ShiftTargetType;
      orderId?: string | null;
      visitId?: string | null;
      quickTaskId?: string | null;
      tzOffsetMinutes?: number;
    };

    const tzOffset = clampTzOffset(body.tzOffsetMinutes);
    const todayStr = todayForOffset(tzOffset);
    const shiftId = crypto.randomUUID();
    const now = new Date().toISOString();

    const existing = db
      .prepare("SELECT id FROM workshop_shifts WHERE user_id = ? AND status = 'active'")
      .get(user.id);
    if (existing) {
      res.status(409).json({ error: 'У вас уже запущена активная смена.' });
      return;
    }

    let resolvedTarget: {
      shiftType: ShiftTargetType;
      orderId: string | null;
      visitId: string | null;
      quickTaskId: string | null;
    };

    if (!body.targetType) {
      const options = computeTodayOptions(db, user.id, todayStr);
      if (options.totalTargets === 0) {
        resolvedTarget = { shiftType: 'workshop', orderId: null, visitId: null, quickTaskId: null };
      } else if (options.totalTargets === 1) {
        if (options.visits.length === 1) {
          const v = options.visits[0];
          resolvedTarget = { shiftType: 'visit', orderId: v.orderId, visitId: v.visitId, quickTaskId: null };
        } else if (options.orders.length === 1) {
          const o = options.orders[0];
          resolvedTarget = { shiftType: 'visit', orderId: o.orderId, visitId: null, quickTaskId: null };
        } else {
          const t = options.quickTasks[0];
          resolvedTarget = {
            shiftType: 'quick_task',
            orderId: t.orderId || null,
            visitId: null,
            quickTaskId: t.quickTaskId,
          };
        }
      } else {
        res.status(409).json({
          error: 'На сегодня назначено несколько задач. Выберите задачу или смену в цеху.',
          code: 'CHOICE_REQUIRED',
          options,
        });
        return;
      }
    } else {
      try {
        resolvedTarget = validateAndResolveShiftTarget(db, user, body, {
          allowClosedForAdmin: false,
          activatePlanned: false,
        });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Не удалось определить цель смены.' });
        return;
      }
    }

    try {
      const shift = withTransaction(db, () => {
        const doubleCheck = db
          .prepare("SELECT id FROM workshop_shifts WHERE user_id = ? AND status = 'active'")
          .get(user.id);
        if (doubleCheck) {
          throw new Error('У вас уже запущена активная смена.');
        }

        // Re-validate and activate planned visit/order inside transaction
        const finalTarget = validateAndResolveShiftTarget(
          db,
          user,
          {
            targetType: resolvedTarget.shiftType,
            orderId: resolvedTarget.orderId,
            visitId: resolvedTarget.visitId,
            quickTaskId: resolvedTarget.quickTaskId,
          },
          { allowClosedForAdmin: false, activatePlanned: true }
        );

        const userRow = db
          .prepare('SELECT shift_rate_kopecks FROM users WHERE id = ?')
          .get(user.id) as { shift_rate_kopecks: number };

        db.prepare(
          `INSERT INTO workshop_shifts
           (id, user_id, started_at, ended_at, work_done, status, rate_snapshot_kopecks, created_at,
            shift_type, order_id, visit_id, quick_task_id, work_date, is_manual_entry)
           VALUES (?, ?, ?, NULL, '', 'active', ?, ?, ?, ?, ?, ?, ?, 0)`
        ).run(
          shiftId,
          user.id,
          now,
          userRow.shift_rate_kopecks,
          now,
          finalTarget.shiftType,
          finalTarget.orderId,
          finalTarget.visitId,
          finalTarget.quickTaskId,
          todayStr
        );

        writeAuditLog(db, user.id, 'shift', shiftId, 'shift_started', {
          startedAt: now,
          shiftType: finalTarget.shiftType,
          orderId: finalTarget.orderId,
          visitId: finalTarget.visitId,
          quickTaskId: finalTarget.quickTaskId,
        });

        return sanitizeShiftRow(
          db.prepare(getShiftSelectSql('WHERE ws.id = ?', '')).get(shiftId) as Record<string, unknown> | undefined,
          user.id,
          user.role === 'admin'
        );
      });

      res.status(201).json({ shift });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Не удалось начать смену.' });
    }
  });

  router.post('/finish', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const { workDone, materials, shiftId, completeTarget, tzOffsetMinutes } = (req.body || {}) as {
      workDone?: string;
      shiftId?: string;
      completeTarget?: boolean;
      tzOffsetMinutes?: number;
      materials?: Array<{ materialId: string; qtyMilli: number; note?: string }>;
    };

    if (!workDone || !workDone.trim()) {
      res.status(400).json({ error: 'Опишите работу, выполненную за смену.' });
      return;
    }

    const tzOffset = clampTzOffset(tzOffsetMinutes);
    const todayStr = todayForOffset(tzOffset);
    const now = new Date().toISOString();

    try {
      const result = withTransaction(db, () => {
        const active = db
          .prepare("SELECT * FROM workshop_shifts WHERE user_id = ? AND status = 'active'")
          .get(user.id) as
          | {
              id: string;
              user_id: string;
              started_at: string;
              rate_snapshot_kopecks: number;
              shift_type: ShiftTargetType;
              order_id: string | null;
              visit_id: string | null;
              quick_task_id: string | null;
              work_date: string;
            }
          | undefined;

        if (!active) {
          throw new Error('Активная смена не найдена.');
        }
        if (shiftId && shiftId !== active.id) {
          throw new Error('Активная смена изменилась. Обновите данные.');
        }

        const userRow = db
          .prepare('SELECT shift_rate_kopecks FROM users WHERE id = ?')
          .get(user.id) as { shift_rate_kopecks: number };
        const effectiveRate = userRow.shift_rate_kopecks;
        const workDate = active.work_date || active.started_at.slice(0, 10);

        db.prepare(
          `UPDATE workshop_shifts
           SET ended_at = ?, work_done = ?, status = 'completed', rate_snapshot_kopecks = ?, work_date = ?
           WHERE id = ?`
        ).run(now, workDone.trim(), effectiveRate, workDate, active.id);

        if (active.visit_id) {
          syncVisitWorkTimeFromShifts(db, active.visit_id, user.id, workDate, tzOffset);
        }

        if (completeTarget && active.quick_task_id) {
          const qt = db
            .prepare("SELECT id, title, created_by FROM quick_tasks WHERE id = ? AND status = 'open' AND cancelled_at IS NULL")
            .get(active.quick_task_id) as { id: string; title: string; created_by: string } | undefined;
          const isAssignee = db
            .prepare('SELECT 1 FROM quick_task_assignees WHERE task_id = ? AND user_id = ?')
            .get(active.quick_task_id, user.id);
          if (qt && isAssignee) {
            db.prepare(
              `UPDATE quick_tasks
               SET status = 'completed', completed_by = ?, completed_at = ?, completion_comment = ?, updated_at = ?
               WHERE id = ? AND status = 'open'`
            ).run(user.id, now, workDone.trim(), now, qt.id);
            if (qt.created_by !== user.id) {
              notifyUser(db, qt.created_by, 'quick_task_completed', 'Быстрая задача выполнена', qt.title, 'quick_task', qt.id);
            }
            writeAuditLog(db, user.id, 'quick_task', qt.id, 'quick_task_completed', { shiftId: active.id });
          }
        }

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
              orderId: active.order_id,
              visitId: active.visit_id,
              employeeUserId: user.id,
              actorUserId: user.id,
              note: m.note || 'Списание при завершении смены',
            });
            if (opRes.negativeStockWarning) negativeWarning = true;
          }
        }

        const uncoveredToday = computeTodayOptions(db, user.id, workDate);
        if (workDate === todayStr && uncoveredToday.uncoveredCount > 0) {
          const alreadyNotified = db
            .prepare(
              `SELECT 1 FROM notifications
               WHERE user_id = ? AND type = 'shift_uncovered_tasks' AND substr(created_at, 1, 10) = ?
               LIMIT 1`
            )
            .get(user.id, now.slice(0, 10));
          if (!alreadyNotified) {
            notifyUser(
              db,
              user.id,
              'shift_uncovered_tasks',
              'Остались незакрытые задачи на сегодня',
              `За ${workDate} есть задачи без отмеченного времени (${uncoveredToday.uncoveredCount}). Вы можете запустить новую смену или проставить время сегодня.`,
              'shift',
              active.id
            );
          }
        }

        writeAuditLog(db, user.id, 'shift', active.id, 'shift_completed', {
          shiftType: active.shift_type,
          orderId: active.order_id,
          visitId: active.visit_id,
          quickTaskId: active.quick_task_id,
        });

        const completedShift = sanitizeShiftRow(
          db.prepare(getShiftSelectSql('WHERE ws.id = ?', '')).get(active.id) as Record<string, unknown> | undefined,
          user.id,
          user.role === 'admin'
        );

        return {
          shift: completedShift,
          accruedKopecks: 0,
          negativeWarning,
          uncoveredToday,
        };
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Не удалось завершить смену.' });
    }
  });

  router.post('/same-day-log', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const body = (req.body || {}) as {
      workDate?: string;
      startTime?: string;
      endTime?: string;
      targetType?: ShiftTargetType;
      orderId?: string | null;
      visitId?: string | null;
      quickTaskId?: string | null;
      workDone?: string;
      tzOffsetMinutes?: number;
    };

    const tzOffset = clampTzOffset(body.tzOffsetMinutes);
    const todayStr = todayForOffset(tzOffset);
    const workDate = body.workDate || todayStr;

    if (!validDate(workDate)) {
      res.status(400).json({ error: 'Укажите корректную дату.' });
      return;
    }
    if (user.role !== 'admin' && workDate !== todayStr) {
      res.status(403).json({
        error: 'Самостоятельно проставить время можно только за сегодняшний день. Для прошлых дней отправьте запрос администратору.',
      });
      return;
    }
    if (!validHm(body.startTime) || !validHm(body.endTime)) {
      res.status(400).json({ error: 'Укажите время начала и окончания в формате ЧЧ:ММ.' });
      return;
    }
    if (body.startTime >= body.endTime) {
      res.status(400).json({ error: 'Время окончания должно быть позже времени начала.' });
      return;
    }

    const startedAt = hmToIso(workDate, body.startTime, tzOffset);
    const endedAt = hmToIso(workDate, body.endTime, tzOffset);
    const workDone = typeof body.workDone === 'string' && body.workDone.trim()
      ? body.workDone.trim()
      : 'Отметка времени за текущий день';

    let resolvedTarget: {
      shiftType: ShiftTargetType;
      orderId: string | null;
      visitId: string | null;
      quickTaskId: string | null;
    };
    try {
      resolvedTarget = validateAndResolveShiftTarget(
        db,
        user,
        {
          targetType: body.targetType || 'workshop',
          orderId: body.orderId,
          visitId: body.visitId,
          quickTaskId: body.quickTaskId,
        },
        { allowClosedForAdmin: user.role === 'admin', activatePlanned: false }
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Некорректная задача.' });
      return;
    }

    const shiftId = crypto.randomUUID();
    const now = new Date().toISOString();

    const shift = withTransaction(db, () => {
      const userRow = db
        .prepare('SELECT shift_rate_kopecks FROM users WHERE id = ?')
        .get(user.id) as { shift_rate_kopecks: number };

      db.prepare(
        `INSERT INTO workshop_shifts
         (id, user_id, started_at, ended_at, work_done, status, rate_snapshot_kopecks, created_at,
          shift_type, order_id, visit_id, quick_task_id, work_date, is_manual_entry)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        shiftId,
        user.id,
        startedAt,
        endedAt,
        workDone,
        userRow.shift_rate_kopecks,
        now,
        resolvedTarget.shiftType,
        resolvedTarget.orderId,
        resolvedTarget.visitId,
        resolvedTarget.quickTaskId,
        workDate
      );

      if (resolvedTarget.visitId) {
        syncVisitWorkTimeFromShifts(db, resolvedTarget.visitId, user.id, workDate, tzOffset);
      }

      writeAuditLog(db, user.id, 'shift', shiftId, 'shift_same_day_logged', {
        workDate,
        startTime: body.startTime,
        endTime: body.endTime,
        shiftType: resolvedTarget.shiftType,
        orderId: resolvedTarget.orderId,
        visitId: resolvedTarget.visitId,
        quickTaskId: resolvedTarget.quickTaskId,
      });

      return sanitizeShiftRow(
        db.prepare(getShiftSelectSql('WHERE ws.id = ?', '')).get(shiftId) as Record<string, unknown> | undefined,
        user.id,
        user.role === 'admin'
      );
    });

    res.status(201).json({ shift });
  });

  router.patch('/:id', requireAdmin, (req: AuthedRequest, res) => {
    const admin = req.authUser!;
    const shiftId = String(req.params.id);
    const existing = db.prepare('SELECT * FROM workshop_shifts WHERE id = ?').get(shiftId) as
      | {
          id: string;
          user_id: string;
          started_at: string;
          ended_at: string | null;
          work_done: string;
          status: string;
          shift_type: ShiftTargetType;
          order_id: string | null;
          visit_id: string | null;
          quick_task_id: string | null;
          work_date: string;
        }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Смена не найдена.' });
      return;
    }

    const body = (req.body || {}) as {
      startedAt?: string;
      endedAt?: string;
      startTime?: string;
      endTime?: string;
      workDate?: string;
      workDone?: string;
      targetType?: ShiftTargetType;
      orderId?: string | null;
      visitId?: string | null;
      quickTaskId?: string | null;
      tzOffsetMinutes?: number;
    };

    const tzOffset = clampTzOffset(body.tzOffsetMinutes);
    const workDate =
      (validDate(body.workDate) ? body.workDate : null) ||
      existing.work_date ||
      existing.started_at.slice(0, 10);

    let nextStartedAt = existing.started_at;
    let nextEndedAt = existing.ended_at;

    if (body.startedAt) {
      if (!Number.isFinite(Date.parse(body.startedAt))) {
        res.status(400).json({ error: 'Некорректное время начала.' });
        return;
      }
      nextStartedAt = new Date(body.startedAt).toISOString();
    } else if (validHm(body.startTime)) {
      nextStartedAt = hmToIso(workDate, body.startTime, tzOffset);
    }

    if (body.endedAt) {
      if (!Number.isFinite(Date.parse(body.endedAt))) {
        res.status(400).json({ error: 'Некорректное время окончания.' });
        return;
      }
      nextEndedAt = new Date(body.endedAt).toISOString();
    } else if (validHm(body.endTime)) {
      nextEndedAt = hmToIso(workDate, body.endTime, tzOffset);
    }

    if (nextEndedAt && Date.parse(nextEndedAt) <= Date.parse(nextStartedAt)) {
      res.status(400).json({ error: 'Время окончания должно быть позже времени начала.' });
      return;
    }

    let resolvedTarget: {
      shiftType: ShiftTargetType;
      orderId: string | null;
      visitId: string | null;
      quickTaskId: string | null;
    };
    try {
      resolvedTarget = validateAndResolveShiftTarget(
        db,
        admin,
        {
          targetType: body.targetType || existing.shift_type || 'workshop',
          orderId: body.orderId !== undefined ? body.orderId : existing.order_id,
          visitId: body.visitId !== undefined ? body.visitId : existing.visit_id,
          quickTaskId: body.quickTaskId !== undefined ? body.quickTaskId : existing.quick_task_id,
        },
        { allowClosedForAdmin: true, activatePlanned: false }
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Некорректная цель смены.' });
      return;
    }

    const nextWorkDone =
      typeof body.workDone === 'string' ? body.workDone.trim() : existing.work_done;
    const nextStatus = nextEndedAt ? 'completed' : existing.status;

    const updated = withTransaction(db, () => {
      db.prepare(
        `UPDATE workshop_shifts
         SET started_at = ?, ended_at = ?, work_done = ?, status = ?,
             shift_type = ?, order_id = ?, visit_id = ?, quick_task_id = ?, work_date = ?
         WHERE id = ?`
      ).run(
        nextStartedAt,
        nextEndedAt,
        nextWorkDone,
        nextStatus,
        resolvedTarget.shiftType,
        resolvedTarget.orderId,
        resolvedTarget.visitId,
        resolvedTarget.quickTaskId,
        workDate,
        shiftId
      );

      if (resolvedTarget.visitId && nextEndedAt) {
        syncVisitWorkTimeFromShifts(db, resolvedTarget.visitId, existing.user_id, workDate, tzOffset);
        const startHm = formatIsoToHm(nextStartedAt, tzOffset);
        const endHm = formatIsoToHm(nextEndedAt, tzOffset);
        if (startHm && endHm) {
          db.prepare('UPDATE visit_reports SET start_time = ?, end_time = ? WHERE visit_id = ? AND user_id = ?').run(
            startHm,
            endHm,
            resolvedTarget.visitId,
            existing.user_id
          );
        }
      }

      writeAuditLog(db, admin.id, 'shift', shiftId, 'shift_updated_by_admin', {
        startedAt: nextStartedAt,
        endedAt: nextEndedAt,
        shiftType: resolvedTarget.shiftType,
        orderId: resolvedTarget.orderId,
        visitId: resolvedTarget.visitId,
        quickTaskId: resolvedTarget.quickTaskId,
      });

      return sanitizeShiftRow(
        db.prepare(getShiftSelectSql('WHERE ws.id = ?', '')).get(shiftId) as Record<string, unknown> | undefined,
        admin.id,
        true
      );
    });

    res.json({ shift: updated });
  });

  return router;
}
