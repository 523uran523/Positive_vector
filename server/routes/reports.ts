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
    const search = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
    const scopeUserId = canViewOthers ? requestedUserId : user.id;

    const visitReportsAll = db
      .prepare(
        `SELECT vr.id, vr.visit_id, vr.order_id, vr.user_id, vr.is_primary,
                vr.start_time, vr.end_time, vr.work_done, vr.notes, vr.created_at,
                u.full_name as author_name, u.position as author_position,
                o.order_number, o.title as order_title, o.address as order_address,
                ov.title as visit_title, ov.scheduled_at as visit_scheduled_at
         FROM visit_reports vr
         JOIN users u ON u.id = vr.user_id
         JOIN orders o ON o.id = vr.order_id
         JOIN order_visits ov ON ov.id = vr.visit_id
         WHERE (? = '' OR vr.user_id = ?)
         ORDER BY vr.created_at DESC
         LIMIT 300`
      )
      .all(scopeUserId, scopeUserId) as Array<Record<string, unknown>>;

    const shiftReportsAll = db
      .prepare(
        `SELECT ws.id, ws.user_id, ws.started_at, ws.ended_at, ws.work_done, ws.status,
                ws.rate_snapshot_kopecks, ws.created_at,
                u.full_name as employee_name, u.position as employee_position
         FROM workshop_shifts ws
         JOIN users u ON u.id = ws.user_id
         WHERE ws.status = 'completed' AND (? = '' OR ws.user_id = ?)
         ORDER BY COALESCE(ws.ended_at, ws.started_at) DESC
         LIMIT 300`
      )
      .all(scopeUserId, scopeUserId) as Array<Record<string, unknown>>;

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
          String(s.employee_name || '').toLowerCase().includes(search)
        );
      })
      .map((s) => {
        // Hide other employees' rates from non-admins
        if (!isAdmin && s.user_id !== user.id) {
          const { rate_snapshot_kopecks: _rate, ...rest } = s;
          return rest;
        }
        return s;
      });

    res.json({
      canViewOthers,
      visitReports,
      shiftReports,
    });
  });

  return router;
}
