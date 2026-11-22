import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAdmin, requireAuth, type AuthedRequest } from '../middleware.ts';
import { notifyUser, writeAuditLog } from '../security.ts';

export function createSalariesRouter(db: DatabaseSync): express.Router {
  const router = express.Router();
  const activityFor = (userId: string) => db.prepare(`
    SELECT month, SUM(visits) AS visits, SUM(shifts) AS shifts FROM (
      SELECT substr(r.created_at, 1, 7) AS month, COUNT(DISTINCT r.visit_id) AS visits, 0 AS shifts
      FROM visit_reports r JOIN order_visits v ON v.id=r.visit_id
      WHERE r.user_id=? AND v.status='completed' GROUP BY substr(r.created_at, 1, 7)
      UNION ALL
      SELECT substr(started_at, 1, 7), 0, COUNT(*) FROM workshop_shifts
      WHERE user_id=? AND status='completed' GROUP BY substr(started_at, 1, 7)
    ) GROUP BY month ORDER BY month DESC`).all(userId, userId);

  // Employee personal salary summary (only their own accruals, payouts, pending visits, shifts)
  router.get('/my', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.authUser!.id;
    const monthPrefix = req.query.month ? String(req.query.month) : new Date().toISOString().slice(0, 7);

    const accruals = db
      .prepare('SELECT * FROM salary_accruals WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Array<{
      id: string;
      source_type: string;
      source_id: string | null;
      amount_kopecks: number;
      description: string;
      created_at: string;
    }>;

    const payouts = db
      .prepare('SELECT * FROM salary_payouts WHERE user_id = ? ORDER BY paid_at DESC, created_at DESC')
      .all(userId) as Array<{
      id: string;
      amount_kopecks: number;
      paid_at: string;
      comment: string;
      created_at: string;
    }>;

    const pendingVisits = db
      .prepare(
        `SELECT va.id as assignee_id, va.visit_id, ov.title as visit_title, ov.scheduled_at, ov.status as visit_status, o.id as order_id, o.order_number, o.title as order_title
         FROM visit_assignees va
         JOIN order_visits ov ON ov.id = va.visit_id
         JOIN orders o ON o.id = ov.order_id
         WHERE va.user_id = ? AND va.wage_kopecks IS NULL AND ov.status != 'cancelled'
         ORDER BY ov.scheduled_at DESC`
      )
      .all(userId);

    const monthAccrued = accruals
      .filter((a) => a.created_at.startsWith(monthPrefix))
      .reduce((acc, a) => acc + a.amount_kopecks, 0);

    const totalAccrued = accruals.reduce((acc, a) => acc + a.amount_kopecks, 0);
    const totalPaid = payouts.reduce((acc, p) => acc + p.amount_kopecks, 0);

    res.json({
      month: monthPrefix,
      monthAccruedKopecks: monthAccrued,
      totalAccruedKopecks: totalAccrued,
      totalPaidKopecks: totalPaid,
      remainingKopecks: totalAccrued - totalPaid,
      accruals,
      payouts,
      pendingVisits,
      activity: activityFor(userId),
    });
  });

  // Admin summary across all employees
  router.get('/summary', requireAdmin, (_req, res) => {
    const users = db
      .prepare("SELECT id, full_name, login, role, position, shift_rate_kopecks, is_active FROM users ORDER BY full_name ASC")
      .all() as Array<{
      id: string;
      full_name: string;
      login: string;
      role: string;
      position: string;
      shift_rate_kopecks: number;
      is_active: number;
    }>;

    const accruals = db
      .prepare(
        `SELECT
           a.id,
           a.user_id,
           a.source_type,
           a.source_id,
           a.amount_kopecks,
           a.description,
           a.created_at,
           o.id AS order_id,
           o.order_number,
           ov.title AS visit_title
          FROM salary_accruals a
          LEFT JOIN order_visits ov ON a.source_type = 'visit' AND ov.id = a.source_id
          LEFT JOIN orders o ON o.id = ov.order_id
          ORDER BY a.created_at DESC, a.id DESC`
      )
      .all() as Array<{
      id: string;
      user_id: string;
      source_type: 'visit' | 'shift' | 'manual';
      source_id: string | null;
      amount_kopecks: number;
      description: string;
      created_at: string;
      order_id: string | null;
      order_number: string | null;
      visit_title: string | null;
    }>;

    const payouts = db
      .prepare(
        `SELECT
           id,
           user_id,
           amount_kopecks,
           paid_at,
           comment,
           created_at
          FROM salary_payouts
          ORDER BY paid_at DESC, created_at DESC, id DESC`
      )
      .all() as Array<{
      id: string;
      user_id: string;
      amount_kopecks: number;
      paid_at: string;
      comment: string;
      created_at: string;
    }>;

    const unassignedVisits = db
      .prepare(
        `SELECT va.id as assignee_id, va.visit_id, va.user_id, va.wage_kopecks, u.full_name as employee_name,
                ov.title as visit_title, ov.scheduled_at, ov.status as visit_status,
                o.id as order_id, o.order_number, o.title as order_title
         FROM visit_assignees va
         JOIN users u ON u.id = va.user_id
         JOIN order_visits ov ON ov.id = va.visit_id
         JOIN orders o ON o.id = ov.order_id
         WHERE ov.status != 'cancelled'
         ORDER BY ov.scheduled_at DESC`
      )
      .all();

    const employeesSummary = users.map((u) => {
      const uAccruals = accruals.filter((a) => a.user_id === u.id);
      const uPayouts = payouts.filter((p) => p.user_id === u.id);

      const sumBySource = (type: 'visit' | 'shift' | 'manual') =>
        uAccruals
          .filter((a) => a.source_type === type)
          .reduce((sum, a) => sum + a.amount_kopecks, 0);

      const visitAccruedKopecks = sumBySource('visit');
      const shiftAccruedKopecks = sumBySource('shift');
      const manualAccruedKopecks = sumBySource('manual');
      const totalAccruedKopecks = visitAccruedKopecks + shiftAccruedKopecks + manualAccruedKopecks;
      const totalPaidKopecks = uPayouts.reduce((sum, p) => sum + p.amount_kopecks, 0);
      const remainingKopecks = totalAccruedKopecks - totalPaidKopecks;
      const lastOperationAt = [...uAccruals.map((a) => a.created_at), ...uPayouts.map((p) => p.paid_at)]
        .sort()
        .at(-1) || null;

      return {
        ...u,
        visitAccruedKopecks,
        shiftAccruedKopecks,
        manualAccruedKopecks,
        totalAccruedKopecks,
        totalPaidKopecks,
        remainingKopecks,
        overpaidKopecks: Math.max(0, -remainingKopecks),
        accruals: uAccruals,
        payouts: uPayouts,
        activity: activityFor(u.id),
        lastOperationAt,
      };
    });

    res.json({
      employees: employeesSummary,
      visitAssignments: unassignedVisits,
      payouts,
    });
  });

  // Per-employee normalized ledger of salary operations (accruals + payouts),
  // ordered newest first, filterable by date range and paged.
  router.get('/ledger', requireAdmin, (req, res) => {
    const userId = String(req.query.userId || '');
    if (!userId) {
      res.status(400).json({ error: 'Укажите сотрудника.' });
      return;
    }

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const from = req.query.from ? String(req.query.from) : '';
    const to = req.query.to ? String(req.query.to) : '';

    const periodSql =
      from || to
        ? `AND (${from ? 'date(occurred_at) >= date(?)' : '1 = 1'})
           AND (${to ? 'date(occurred_at) <= date(?)' : '1 = 1'})`
        : '';
    const periodParams: string[] = [];
    if (from) periodParams.push(from);
    if (to) periodParams.push(to);

    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT
             a.id,
             'accrual' AS kind,
             a.source_type AS source,
             a.amount_kopecks,
             a.description,
             a.created_at AS occurred_at,
             o.id AS order_id,
             o.order_number,
             ov.title AS visit_title
           FROM salary_accruals a
           LEFT JOIN order_visits ov ON a.source_type = 'visit' AND ov.id = a.source_id
           LEFT JOIN orders o ON o.id = ov.order_id
           WHERE a.user_id = ?

           UNION ALL

           SELECT
             p.id,
             'payout' AS kind,
             'payout' AS source,
             p.amount_kopecks,
             p.comment AS description,
             p.paid_at AS occurred_at,
             NULL AS order_id,
             NULL AS order_number,
             NULL AS visit_title
           FROM salary_payouts p
           WHERE p.user_id = ?
         )
         WHERE 1 = 1
           ${periodSql}
         ORDER BY occurred_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, userId, ...periodParams, limit, offset);

    res.json({ entries: rows, limit, offset });
  });

  // Cross-employee monthly breakdown: accrued, paid, and delta per month.
  router.get('/monthly', requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT
           substr(created_at, 1, 7) AS month,
           user_id,
           'accrual' AS kind,
           source_type AS source,
           amount_kopecks
          FROM salary_accruals
          UNION ALL
          SELECT
           substr(paid_at, 1, 7) AS month,
           user_id,
           'payout' AS kind,
           'payout' AS source,
           amount_kopecks
          FROM salary_payouts
          ORDER BY month DESC`
      )
      .all() as Array<{
      month: string;
      user_id: string;
      kind: 'accrual' | 'payout';
      source: string;
      amount_kopecks: number;
    }>;

    const names = new Map(
      (
        db.prepare('SELECT id, full_name FROM users').all() as Array<{
          id: string;
          full_name: string;
        }>
      ).map((u) => [u.id, u.full_name])
    );

    const months = new Map<
      string,
      {
        month: string;
        accruedKopecks: number;
        paidKopecks: number;
        employees: Map<
          string,
          {
            userId: string;
            fullName: string;
            visitKopecks: number;
            shiftKopecks: number;
            manualKopecks: number;
            paidKopecks: number;
          }
        >;
      }
    >();

    for (const row of rows) {
      let month = months.get(row.month);
      if (!month) {
        month = { month: row.month, accruedKopecks: 0, paidKopecks: 0, employees: new Map() };
        months.set(row.month, month);
      }

      let employee = month.employees.get(row.user_id);
      if (!employee) {
        employee = {
          userId: row.user_id,
          fullName: names.get(row.user_id) || 'Сотрудник',
          visitKopecks: 0,
          shiftKopecks: 0,
          manualKopecks: 0,
          paidKopecks: 0,
        };
        month.employees.set(row.user_id, employee);
      }

      if (row.kind === 'payout') {
        employee.paidKopecks += row.amount_kopecks;
        month.paidKopecks += row.amount_kopecks;
      } else {
        if (row.source === 'visit') employee.visitKopecks += row.amount_kopecks;
        if (row.source === 'shift') employee.shiftKopecks += row.amount_kopecks;
        if (row.source === 'manual') employee.manualKopecks += row.amount_kopecks;
        month.accruedKopecks += row.amount_kopecks;
      }
    }

    res.json({
      months: [...months.values()]
        .sort((a, b) => b.month.localeCompare(a.month))
        .map((month) => ({
          month: month.month,
          accruedKopecks: month.accruedKopecks,
          paidKopecks: month.paidKopecks,
          deltaKopecks: month.accruedKopecks - month.paidKopecks,
          employees: [...month.employees.values()].sort((a, b) =>
            a.fullName.localeCompare(b.fullName, 'ru')
          ),
        })),
    });
  });

  // Admin assigns individual wage for a visit assignee
  router.post('/visit-wage', requireAdmin, (req: AuthedRequest, res) => {
    const { visitId, userId, amountKopecks } = req.body as {
      visitId?: string;
      userId?: string;
      amountKopecks?: number;
    };

    if (!visitId || !userId || amountKopecks === undefined || Number(amountKopecks) < 0) {
      res.status(400).json({ error: 'Укажите выезд, сотрудника и корректную сумму в копейках.' });
      return;
    }

    const amount = Math.round(Number(amountKopecks));
    const now = new Date().toISOString();

    try {
      withTransaction(db, () => {
        const va = db
          .prepare('SELECT id FROM visit_assignees WHERE visit_id = ? AND user_id = ?')
          .get(visitId, userId);
        if (!va) {
          throw new Error('Назначение сотрудника на этот выезд не найдено.');
        }

        const visitInfo = db
          .prepare(
            `SELECT ov.title as visit_title, o.order_number, o.id as order_id
             FROM order_visits ov JOIN orders o ON o.id = ov.order_id WHERE ov.id = ?`
          )
          .get(visitId) as { visit_title: string; order_number: string; order_id: string };

        db.prepare(
          `UPDATE visit_assignees SET wage_kopecks = ?, wage_assigned_at = ?, wage_assigned_by = ?
           WHERE visit_id = ? AND user_id = ?`
        ).run(amount, now, req.authUser!.id, visitId, userId);

        db.prepare(
          `INSERT INTO salary_accruals (id, user_id, source_type, source_id, amount_kopecks, description, created_by, created_at)
           VALUES (?, ?, 'visit', ?, ?, ?, ?, ?)
           ON CONFLICT(source_type, source_id, user_id) WHERE source_id IS NOT NULL
           DO UPDATE SET amount_kopecks = excluded.amount_kopecks, description = excluded.description`
        ).run(
          crypto.randomUUID(),
          userId,
          visitId,
          amount,
          `Монтаж ${visitInfo.order_number} · ${visitInfo.visit_title}`,
          req.authUser!.id,
          now
        );

        notifyUser(
          db,
          userId,
          'salary_accrued',
          `Начислена оплата за монтаж ${visitInfo.order_number}`,
          `${visitInfo.visit_title}: ${(amount / 100).toLocaleString('ru-RU')} ₽`,
          'order',
          visitInfo.order_id
        );

        writeAuditLog(db, req.authUser!.id, 'visit_wage', visitId, 'wage_assigned', {
          userId,
          amountKopecks: amount,
        });
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Не удалось назначить оплату.' });
    }
  });

  // Manual bonus / penalty adjustment
  router.post('/adjustments', requireAdmin, (req: AuthedRequest, res) => {
    const { userId, amountKopecks, description } = req.body as {
      userId?: string;
      amountKopecks?: number;
      description?: string;
    };

    if (!userId || amountKopecks === undefined || Number(amountKopecks) === 0 || !description?.trim()) {
      res.status(400).json({ error: 'Укажите сотрудника, сумму корректировки и комментарий.' });
      return;
    }

    const amount = Math.round(Number(amountKopecks));
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO salary_accruals (id, user_id, source_type, source_id, amount_kopecks, description, created_by, created_at)
         VALUES (?, ?, 'manual', NULL, ?, ?, ?, ?)`
      ).run(id, userId, amount, description.trim(), req.authUser!.id, now);

      notifyUser(
        db,
        userId,
        'salary_accrued',
        'Корректировка зарплаты',
        `${description.trim()}: ${(amount / 100).toLocaleString('ru-RU')} ₽`,
        'salary',
        id
      );

      writeAuditLog(db, req.authUser!.id, 'salary_accrual', id, 'manual_adjustment', {
        userId,
        amountKopecks: amount,
      });
    });

    res.status(201).json({ ok: true, id });
  });

  // General lump-sum / partial salary payout
  router.post('/payouts', requireAdmin, (req: AuthedRequest, res) => {
    const { userId, amountKopecks, paidAt, comment } = req.body as {
      userId?: string;
      amountKopecks?: number;
      paidAt?: string;
      comment?: string;
    };

    if (!userId || !amountKopecks || Number(amountKopecks) <= 0) {
      res.status(400).json({ error: 'Укажите сотрудника и положительную сумму выплаты.' });
      return;
    }

    const amount = Math.round(Number(amountKopecks));
    const dateStr = paidAt || new Date().toISOString().slice(0, 10);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO salary_payouts (id, user_id, amount_kopecks, paid_at, comment, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, userId, amount, dateStr, (comment || '').trim(), req.authUser!.id, now);

      notifyUser(
        db,
        userId,
        'salary_paid',
        'Выплачена зарплата',
        `Сумма: ${(amount / 100).toLocaleString('ru-RU')} ₽ (${dateStr})${comment ? ` · ${comment.trim()}` : ''}`,
        'salary',
        id
      );

      writeAuditLog(db, req.authUser!.id, 'salary_payout', id, 'payout_created', {
        userId,
        amountKopecks: amount,
      });
    });

    res.status(201).json({ ok: true, id });
  });

  return router;
}
