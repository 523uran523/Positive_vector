import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { hasPermission } from '../security.ts';

export function createReportsRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  // Unified employee reports feed: visit reports + completed workshop shifts
  // Enforces reports.view_others on server
  router.get('/', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const isAdmin = user.role === 'admin';
    const canViewOthers = isAdmin || hasPermission(user, 'reports.view_others');

    const requestedUserId = req.query.userId ? String(req.query.userId).trim() : '';
    const requestedOrderId = req.query.orderId ? String(req.query.orderId).trim() : '';
    const fromDate = req.query.from ? String(req.query.from).trim().slice(0, 10) : '';
    const toDate = req.query.to ? String(req.query.to).trim().slice(0, 10) : '';
    const search = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
    const scopeUserId = canViewOthers ? requestedUserId : user.id;

    const visitReportsAll = db
      .prepare(
        `SELECT vr.id, vr.visit_id, vr.order_id, vr.user_id, vr.is_primary,
                vr.start_time, vr.end_time, vr.work_done, vr.notes, vr.created_at,
                u.full_name as author_name, u.position as author_position,
                o.order_number, o.title as order_title, o.address as order_address, o.status as order_status,
                ov.title as visit_title, ov.scheduled_at as visit_scheduled_at
         FROM visit_reports vr
         JOIN users u ON u.id = vr.user_id
         JOIN orders o ON o.id = vr.order_id
         JOIN order_visits ov ON ov.id = vr.visit_id
         WHERE (? = '' OR vr.user_id = ?)
           AND (? = '' OR vr.order_id = ?)
           AND (? = '' OR date(COALESCE(ov.scheduled_at, vr.created_at)) >= date(?))
           AND (? = '' OR date(COALESCE(ov.scheduled_at, vr.created_at)) <= date(?))
         ORDER BY vr.created_at DESC
         LIMIT 300`
      )
      .all(
        scopeUserId,
        scopeUserId,
        requestedOrderId,
        requestedOrderId,
        fromDate,
        fromDate,
        toDate,
        toDate
      ) as Array<Record<string, unknown>>;

    const shiftReportsAll = db
      .prepare(
        `SELECT ws.id, ws.user_id, ws.started_at, ws.ended_at, ws.work_done, ws.status,
                ws.shift_type, ws.order_id, ws.visit_id, ws.quick_task_id, ws.work_date,
                ws.rate_snapshot_kopecks, ws.created_at,
                u.full_name as employee_name, u.position as employee_position,
                o.order_number, o.title as order_title,
                ov.title as visit_title,
                qt.title as quick_task_title,
                sa.amount_kopecks as wage_kopecks
         FROM workshop_shifts ws
         JOIN users u ON u.id = ws.user_id
         LEFT JOIN orders o ON o.id = ws.order_id
         LEFT JOIN order_visits ov ON ov.id = ws.visit_id
         LEFT JOIN quick_tasks qt ON qt.id = ws.quick_task_id
         LEFT JOIN salary_accruals sa ON sa.source_type = 'shift' AND sa.source_id = ws.id AND sa.user_id = ws.user_id
         WHERE ws.status = 'completed'
           AND (? = '' OR ws.user_id = ?)
           AND (? = '' OR ws.order_id = ?)
           AND (? = '' OR date(ws.started_at) >= date(?))
           AND (? = '' OR date(ws.started_at) <= date(?))
         ORDER BY COALESCE(ws.ended_at, ws.started_at) DESC
         LIMIT 300`
      )
      .all(
        scopeUserId,
        scopeUserId,
        requestedOrderId,
        requestedOrderId,
        fromDate,
        fromDate,
        toDate,
        toDate
      ) as Array<Record<string, unknown>>;

    const visitReports = visitReportsAll
      .filter((r) => {
        if (!canViewOthers && r.user_id !== user.id) return false;
        if (canViewOthers && requestedUserId && r.user_id !== requestedUserId) return false;
        if (!search) return true;
        return (
          String(r.work_done || '').toLowerCase().includes(search) ||
          String(r.notes || '').toLowerCase().includes(search) ||
          String(r.order_number || '').toLowerCase().includes(search) ||
          String(r.order_title || '').toLowerCase().includes(search) ||
          String(r.author_name || '').toLowerCase().includes(search)
        );
      });

    const shiftReports = shiftReportsAll
      .filter((s) => {
        if (!canViewOthers && s.user_id !== user.id) return false;
        if (canViewOthers && requestedUserId && s.user_id !== requestedUserId) return false;
        if (!search) return true;
        return (
          String(s.work_done || '').toLowerCase().includes(search) ||
          String(s.employee_name || '').toLowerCase().includes(search) ||
          String(s.order_number || '').toLowerCase().includes(search) ||
          String(s.order_title || '').toLowerCase().includes(search) ||
          String(s.quick_task_title || '').toLowerCase().includes(search)
        );
      })
      .map((s) => {
        // Hide other employees' rates/wages from non-admins
        if (!isAdmin && s.user_id !== user.id) {
          const { rate_snapshot_kopecks: _rate, wage_kopecks: _wage, ...rest } = s;
          return rest;
        }
        return s;
      });

    const quickTaskRowsAll = db
      .prepare(
        `SELECT qt.id, qt.title, qt.description, qt.due_date, qt.status, qt.cancelled_at,
                qt.order_id, qt.created_by, qt.completed_by, qt.completed_at, qt.completion_comment, qt.created_at,
                o.order_number, o.title AS order_title,
                cu.full_name AS completed_by_name
         FROM quick_tasks qt
         LEFT JOIN orders o ON o.id = qt.order_id
         LEFT JOIN users cu ON cu.id = qt.completed_by
         WHERE (
             ? = 1
             OR qt.created_by = ?
             OR EXISTS (SELECT 1 FROM quick_task_assignees qta WHERE qta.task_id = qt.id AND qta.user_id = ?)
           )
           AND (
             ? = ''
             OR qt.created_by = ?
             OR qt.completed_by = ?
             OR EXISTS (SELECT 1 FROM quick_task_assignees qta WHERE qta.task_id = qt.id AND qta.user_id = ?)
           )
           AND (? = '' OR qt.order_id = ?)
           AND (? = '' OR date(COALESCE(NULLIF(qt.due_date, ''), substr(qt.created_at, 1, 10))) >= date(?))
           AND (? = '' OR date(COALESCE(NULLIF(qt.due_date, ''), substr(qt.created_at, 1, 10))) <= date(?))
         ORDER BY COALESCE(qt.completed_at, qt.created_at) DESC
         LIMIT 300`
      )
      .all(
        canViewOthers ? 1 : 0,
        user.id,
        user.id,
        scopeUserId,
        scopeUserId,
        scopeUserId,
        scopeUserId,
        requestedOrderId,
        requestedOrderId,
        fromDate,
        fromDate,
        toDate,
        toDate
      ) as Array<Record<string, unknown>>;

    const quickTaskReports = quickTaskRowsAll
      .map((qt) => {
        const assignees = db
          .prepare(
            `SELECT u.id, u.full_name
             FROM quick_task_assignees qta
             JOIN users u ON u.id = qta.user_id
             WHERE qta.task_id = ?
             ORDER BY u.full_name`
          )
          .all(String(qt.id)) as Array<{ id: string; full_name: string }>;
        const shifts = db
          .prepare(
            `SELECT started_at, ended_at
             FROM workshop_shifts
             WHERE quick_task_id = ? AND status = 'completed' AND ended_at IS NOT NULL`
          )
          .all(String(qt.id)) as Array<{ started_at: string; ended_at: string }>;
        let workedMinutes = 0;
        for (const s of shifts) {
          const ms = Date.parse(s.ended_at) - Date.parse(s.started_at);
          if (Number.isFinite(ms) && ms > 0) workedMinutes += Math.round(ms / 60_000);
        }
        return {
          ...qt,
          status: qt.cancelled_at ? 'cancelled' : qt.status,
          assignees,
          worked_minutes: workedMinutes,
        };
      })
      .filter((qt) => {
        if (!search) return true;
        const assigneeText = qt.assignees.map((a) => a.full_name).join(' ').toLowerCase();
        return (
          String((qt as Record<string, unknown>).title || '').toLowerCase().includes(search) ||
          String((qt as Record<string, unknown>).description || '').toLowerCase().includes(search) ||
          String((qt as Record<string, unknown>).completion_comment || '').toLowerCase().includes(search) ||
          String((qt as Record<string, unknown>).order_number || '').toLowerCase().includes(search) ||
          String((qt as Record<string, unknown>).order_title || '').toLowerCase().includes(search) ||
          String((qt as Record<string, unknown>).completed_by_name || '').toLowerCase().includes(search) ||
          assigneeText.includes(search)
        );
      });

    const quickTasksSummary = {
      total: quickTaskReports.length,
      open: quickTaskReports.filter((t) => t.status === 'open').length,
      completed: quickTaskReports.filter((t) => t.status === 'completed').length,
      cancelled: quickTaskReports.filter((t) => t.status === 'cancelled').length,
      workedMinutes: quickTaskReports.reduce((sum, t) => sum + Number(t.worked_minutes || 0), 0),
    };

    res.json({
      canViewOthers,
      visitReports,
      shiftReports,
      quickTaskReports,
      quickTasksSummary,
    });
  });

  return router;
}
