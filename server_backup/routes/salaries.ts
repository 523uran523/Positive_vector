import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAdmin, requireAuth, type AuthedRequest } from '../middleware.ts';
import { notifyUser, writeAuditLog } from '../security.ts';

export function createSalariesRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

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
      payment_method: string;
      paid_at: string;
      comment: string;
      created_at: string;
    }>;

    const pendingVisits = db
      .prepare(
        `SELECT va.id as assignee_id, va.visit_id, ov.title as visit_title, ov.scheduled_at, ov.status as visit_status, o.order_number, o.title as order_title
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
      .prepare('SELECT * FROM salary_accruals ORDER BY created_at DESC')
      .all() as Array<{
      id: string;
      user_id: string;
      source_type: string;
      source_id: string | null;
      amount_kopecks: number;
      description: string;
      created_at: string;
    }>;

    const payouts = db
      .prepare('SELECT * FROM salary_payouts ORDER BY paid_at DESC, created_at DESC')
      .all() as Array<{
      id: string;
      user_id: string;
      amount_kopecks: number;
      payment_method: string;
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
      const totalAccrued = uAccruals.reduce((s, a) => s + a.amount_kopecks, 0);
      const totalPaid = uPayouts.reduce((s, p) => s + p.amount_kopecks, 0);
      return {
        ...u,
        totalAccruedKopecks: totalAccrued,
        totalPaidKopecks: totalPaid,
        remainingKopecks: totalAccrued - totalPaid,
        accruals: uAccruals,
        payouts: uPayouts,
      };
    });

    res.json({
      employees: employeesSummary,
      visitAssignments: unassignedVisits,
      payouts,
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
    const { userId, amountKopecks, paymentMethod, paidAt, comment } = req.body as {
      userId?: string;
      amountKopecks?: number;
      paymentMethod?: 'cash' | 'bank' | 'card';
      paidAt?: string;
      comment?: string;
    };

    if (!userId || !amountKopecks || Number(amountKopecks) <= 0) {
      res.status(400).json({ error: 'Укажите сотрудника и положительную сумму выплаты.' });
      return;
    }

    const amount = Math.round(Number(amountKopecks));
    const method = paymentMethod === 'bank' || paymentMethod === 'card' ? paymentMethod : 'cash';
    const dateStr = paidAt || new Date().toISOString().slice(0, 10);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO salary_payouts (id, user_id, amount_kopecks, payment_method, paid_at, comment, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, userId, amount, method, dateStr, (comment || '').trim(), req.authUser!.id, now);

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
        paymentMethod: method,
      });
    });

    res.status(201).json({ ok: true, id });
  });

  return router;
}
