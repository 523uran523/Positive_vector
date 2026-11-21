import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAdmin, type AuthedRequest } from '../middleware.ts';
import { writeAuditLog } from '../security.ts';

export function createFinanceRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/overview', requireAdmin, (req, res) => {
    const from = req.query.from ? String(req.query.from) : '';
    const to = req.query.to ? String(req.query.to) : '';

    const inPeriod = (dateIso: string | null | undefined): boolean => {
      if (!dateIso) return !from && !to;
      const d = dateIso.slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    };

    const orders = db
      .prepare('SELECT id, order_number, title, status, price_kopecks, cost_override_kopecks, scheduled_at, created_at FROM orders')
      .all() as Array<{
      id: string;
      order_number: string;
      title: string;
      status: string;
      price_kopecks: number;
      cost_override_kopecks: number | null;
      scheduled_at: string | null;
      created_at: string;
    }>;

    const payments = db
      .prepare(
        `SELECT cp.*, o.order_number, o.title as order_title, comp.name as company_name, c.full_name as contact_name
         FROM client_payments cp
         LEFT JOIN orders o ON o.id = cp.order_id
         LEFT JOIN companies comp ON comp.id = cp.company_id
         LEFT JOIN contacts c ON c.id = cp.contact_id
         ORDER BY cp.paid_at DESC, cp.created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    const expenses = db
      .prepare(
        `SELECT e.*, o.order_number
         FROM expenses e
         LEFT JOIN orders o ON o.id = e.order_id
         ORDER BY e.expense_date DESC, e.created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    const accruals = db
      .prepare('SELECT amount_kopecks, created_at FROM salary_accruals')
      .all() as Array<{ amount_kopecks: number; created_at: string }>;

    const payouts = db
      .prepare('SELECT amount_kopecks, paid_at FROM salary_payouts')
      .all() as Array<{ amount_kopecks: number; paid_at: string }>;

    const consumeOps = db
      .prepare(
        `SELECT wo.order_id, wo.qty_milli, wo.unit_cost_kopecks, wo.created_at,
          COALESCE((SELECT CAST(ROUND(SUM(a.qty_milli*b.unit_cost_kopecks)/1000.0) AS INTEGER) FROM material_batch_allocations a JOIN material_batches b ON b.id=a.batch_id WHERE a.operation_id=wo.id), CAST(ROUND(wo.qty_milli*wo.unit_cost_kopecks/1000.0) AS INTEGER)) AS cost_kopecks
         FROM warehouse_operations wo
         WHERE wo.item_type = 'material' AND wo.op_type = 'consume'`
      )
      .all() as Array<{
      order_id: string | null;
      qty_milli: number;
      unit_cost_kopecks: number;
      cost_kopecks: number;
      created_at: string;
    }>;

    // Filter active non-cancelled orders in period
    const activeOrders = orders.filter(
      (o) => o.status !== 'cancelled' && inPeriod(o.scheduled_at || o.created_at)
    );
    const filteredPayments = payments.filter((p) => inPeriod(String(p.paid_at)));
    const filteredExpenses = expenses.filter((e) => inPeriod(String(e.expense_date)));
    const filteredAccruals = accruals.filter((a) => inPeriod(a.created_at));
    const filteredPayouts = payouts.filter((p) => inPeriod(p.paid_at));
    const filteredConsumes = consumeOps.filter((op) => inPeriod(op.created_at));

    const totalOrderPriceKopecks = activeOrders.reduce((s, o) => s + o.price_kopecks, 0);
    const totalReceivedCashKopecks = filteredPayments.reduce(
      (s, p) => s + Number(p.amount_kopecks || 0),
      0
    );

    // Client debt across active orders (calculated accurately per order across all payments)
    const paidByOrder = new Map<string, number>();
    for (const p of payments) {
      if (p.order_id) {
        paidByOrder.set(
          String(p.order_id),
          (paidByOrder.get(String(p.order_id)) || 0) + Number(p.amount_kopecks || 0)
        );
      }
    }

    const orderBreakdown = activeOrders.map((o) => {
      const paid = paidByOrder.get(o.id) || 0;
      const autoMatCost = consumeOps
        .filter((op) => op.order_id === o.id)
        .reduce((s, op) => s + op.cost_kopecks, 0);
      const effectiveMatCost =
        o.cost_override_kopecks !== null ? o.cost_override_kopecks : autoMatCost;
      return {
        id: o.id,
        order_number: o.order_number,
        title: o.title,
        status: o.status,
        price_kopecks: o.price_kopecks,
        paid_kopecks: paid,
        debt_kopecks: Math.max(0, o.price_kopecks - paid),
        auto_material_cost_kopecks: autoMatCost,
        cost_override_kopecks: o.cost_override_kopecks,
        effective_material_cost_kopecks: effectiveMatCost,
      };
    });

    // Debt is a running total across all active orders: a month filter must not hide old debt.
    const totalClientDebtKopecks = orders
      .filter((o) => o.status !== 'cancelled')
      .reduce(
        (s, o) =>
          s + Math.max(0, Number(o.price_kopecks || 0) - (paidByOrder.get(o.id) || 0)),
        0
      );
    const periodClientDebtKopecks = orderBreakdown.reduce((s, o) => s + o.debt_kopecks, 0);

    // Separate accrued salary obligations vs actual cash salary payouts (no double counting!)
    const accruedSalariesKopecks = filteredAccruals.reduce((s, a) => s + a.amount_kopecks, 0);
    const paidSalariesKopecks = filteredPayouts.reduce((s, p) => s + p.amount_kopecks, 0);

    // Separate material COGS (used in jobs/workshop) vs operating expenses (excluding duplicate salary/material stock purchases if flagged)
    const autoMaterialCostKopecks = filteredConsumes.reduce(
      (s, op) => s + op.cost_kopecks,
      0
    );

    const operatingExpensesExcludingSalariesAndStock = filteredExpenses
      .filter((e) => e.category !== 'salaries' && e.category !== 'materials')
      .reduce((s, e) => s + Number(e.amount_kopecks || 0), 0);

    const materialPurchasesCashKopecks = filteredExpenses
      .filter((e) => e.category === 'materials')
      .reduce((s, e) => s + Number(e.amount_kopecks || 0), 0);

    const manualSalaryExpensesKopecks = filteredExpenses
      .filter((e) => e.category === 'salaries')
      .reduce((s, e) => s + Number(e.amount_kopecks || 0), 0);

    const totalExpensesRecordedKopecks = filteredExpenses.reduce(
      (s, e) => s + Number(e.amount_kopecks || 0),
      0
    );

    // Accrual Profit = Order Revenue - Effective Material Cost - Accrued Salaries - Operating Expenses (fuel, rent, other)
    const effectiveTotalMaterialCost = orderBreakdown.reduce(
      (s, o) => s + o.effective_material_cost_kopecks,
      0
    );
    const workshopMaterialCost = filteredConsumes
      .filter((op) => !op.order_id)
      .reduce((s, op) => s + op.cost_kopecks, 0);

    // Materials consumed on cancelled orders are real costs even though their revenue is gone.
    const cancelledOrderIds = new Set(
      orders.filter((o) => o.status === 'cancelled').map((o) => o.id)
    );
    const cancelledOrderMaterialCostKopecks = filteredConsumes
      .filter((op) => op.order_id && cancelledOrderIds.has(op.order_id))
      .reduce((s, op) => s + op.cost_kopecks, 0);

    const totalCostOfGoodsAndOps =
      effectiveTotalMaterialCost +
      workshopMaterialCost +
      cancelledOrderMaterialCostKopecks +
      accruedSalariesKopecks +
      operatingExpensesExcludingSalariesAndStock;

    const accrualProfitKopecks = totalOrderPriceKopecks - totalCostOfGoodsAndOps;

    // Cash Flow = Real Cash In - Real Cash Out (Salary Payouts + Material Purchases + Operating Expenses + manual salary expense if any)
    const cashOutKopecks =
      paidSalariesKopecks +
      materialPurchasesCashKopecks +
      operatingExpensesExcludingSalariesAndStock +
      manualSalaryExpensesKopecks;
    const netCashFlowKopecks = totalReceivedCashKopecks - cashOutKopecks;

    res.json({
      period: { from, to },
      metrics: {
        totalOrderPriceKopecks,
        totalReceivedCashKopecks,
        totalClientDebtKopecks,
        periodClientDebtKopecks,
        autoMaterialCostKopecks,
        effectiveMaterialCostKopecks: effectiveTotalMaterialCost + workshopMaterialCost + cancelledOrderMaterialCostKopecks,
        cancelledOrderMaterialCostKopecks,
        materialPurchasesCashKopecks,
        accruedSalariesKopecks,
        paidSalariesKopecks,
        operatingExpensesKopecks: operatingExpensesExcludingSalariesAndStock,
        totalExpensesRecordedKopecks,
        accrualProfitKopecks,
        cashOutKopecks,
        netCashFlowKopecks,
      },
      orderBreakdown,
      payments: filteredPayments,
      expenses: filteredExpenses,
    });
  });

  // Record client payment (advance / partial / full)
  router.post('/payments', requireAdmin, (req: AuthedRequest, res) => {
    const { orderId, companyId, contactId, amountKopecks, paymentType, paidAt, comment } =
      req.body as {
        orderId?: string | null;
        companyId?: string | null;
        contactId?: string | null;
        amountKopecks?: number;
        paymentType?: 'advance' | 'partial' | 'full';
        paidAt?: string;
        comment?: string;
      };

    if (!amountKopecks || Number(amountKopecks) <= 0) {
      res.status(400).json({ error: 'Укажите положительную сумму платежа.' });
      return;
    }

    const id = crypto.randomUUID();
    const amount = Math.round(Number(amountKopecks));
    const pType = paymentType === 'advance' || paymentType === 'full' ? paymentType : 'partial';
    const dateStr = paidAt || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    let resolvedCompanyId = companyId || null;
    let resolvedContactId = contactId || null;
    if (orderId) {
      const ord = db.prepare('SELECT company_id, client_contact_id FROM orders WHERE id = ?').get(orderId) as
        | { company_id: string | null; client_contact_id: string | null }
        | undefined;
      if (ord) {
        resolvedCompanyId = resolvedCompanyId || ord.company_id;
        resolvedContactId = resolvedContactId || ord.client_contact_id;
      }
    }

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO client_payments (id, order_id, company_id, contact_id, amount_kopecks, payment_type, paid_at, comment, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        orderId || null,
        resolvedCompanyId,
        resolvedContactId,
        amount,
        pType,
        dateStr,
        (comment || '').trim(),
        req.authUser!.id,
        now
      );
      writeAuditLog(db, req.authUser!.id, 'client_payment', id, 'payment_created', {
        orderId: orderId || null,
        amountKopecks: amount,
        paymentType: pType,
      });
    });

    res.status(201).json({ ok: true, id });
  });

  // Update client payment
  router.patch('/payments/:id', requireAdmin, (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM client_payments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Платёж не найден.' });
      return;
    }
    const b = req.body as {
      orderId?: string | null;
      amountKopecks?: number;
      paymentType?: 'advance' | 'partial' | 'full';
      paidAt?: string;
      comment?: string;
    };

    if (b.amountKopecks !== undefined && (!Number.isSafeInteger(b.amountKopecks) || Number(b.amountKopecks) <= 0)) {
      res.status(400).json({ error: 'Сумма платежа должна быть больше нуля.' });
      return;
    }

    const nextOrderId = b.orderId !== undefined ? b.orderId || null : (existing.order_id as string | null);
    let resolvedCompanyId = existing.company_id as string | null;
    let resolvedContactId = existing.contact_id as string | null;
    if (b.orderId !== undefined) {
      if (nextOrderId) {
        const ord = db.prepare('SELECT company_id, client_contact_id FROM orders WHERE id = ?').get(nextOrderId) as
          | { company_id: string | null; client_contact_id: string | null }
          | undefined;
        resolvedCompanyId = ord?.company_id || null;
        resolvedContactId = ord?.client_contact_id || null;
      } else {
        resolvedCompanyId = null;
        resolvedContactId = null;
      }
    }

    withTransaction(db, () => {
      db.prepare(
        `UPDATE client_payments
         SET order_id = ?, company_id = ?, contact_id = ?, amount_kopecks = ?, payment_type = ?, paid_at = ?, comment = ?
         WHERE id = ?`
      ).run(
        nextOrderId,
        resolvedCompanyId,
        resolvedContactId,
        b.amountKopecks !== undefined ? Math.round(Number(b.amountKopecks)) : existing.amount_kopecks,
        b.paymentType || existing.payment_type,
        b.paidAt || existing.paid_at,
        b.comment !== undefined ? b.comment.trim() : existing.comment,
        id
      );
      writeAuditLog(db, req.authUser!.id, 'client_payment', id, 'payment_updated', {before:existing,after:db.prepare('SELECT * FROM client_payments WHERE id=?').get(id)});
    });

    res.json({ ok: true, id });
  });

  // Delete client payment
  router.delete('/payments/:id', requireAdmin, (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM client_payments WHERE id = ?').get(id) as
      | { id: string; amount_kopecks: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Платёж не найден.' });
      return;
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM client_payments WHERE id = ?').run(id);
      writeAuditLog(db, req.authUser!.id, 'client_payment', id, 'payment_deleted', {
        snapshot: existing,
        amountKopecks: existing.amount_kopecks,
      });
    });
    res.json({ ok: true, id });
  });

  // Record company expense
  router.post('/expenses', requireAdmin, (req: AuthedRequest, res) => {
    const { category, amountKopecks, expenseDate, description, orderId } = req.body as {
      category?: string;
      amountKopecks?: number;
      expenseDate?: string;
      description?: string;
      orderId?: string | null;
    };

    if (!category || !amountKopecks || Number(amountKopecks) <= 0) {
      res.status(400).json({ error: 'Укажите категорию и сумму расхода.' });
      return;
    }

    const id = crypto.randomUUID();
    const amount = Math.round(Number(amountKopecks));
    const dateStr = expenseDate || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO expenses (id, category, amount_kopecks, expense_date, description, order_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        category.trim(),
        amount,
        dateStr,
        (description || '').trim(),
        orderId || null,
        req.authUser!.id,
        now
      );
      writeAuditLog(db, req.authUser!.id, 'expense', id, 'expense_created', {
        category,
        amountKopecks: amount,
      });
    });

    res.status(201).json({ ok: true, id });
  });

  // Update company expense
  router.patch('/expenses/:id', requireAdmin, (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Расход не найден.' });
      return;
    }
    const b = req.body as {
      category?: string;
      amountKopecks?: number;
      expenseDate?: string;
      description?: string;
      orderId?: string | null;
    };

    if (b.amountKopecks !== undefined && (!Number.isSafeInteger(b.amountKopecks) || Number(b.amountKopecks) <= 0)) {
      res.status(400).json({ error: 'Сумма расхода должна быть больше нуля.' });
      return;
    }

    withTransaction(db, () => {
      db.prepare(
        `UPDATE expenses
         SET category = ?, amount_kopecks = ?, expense_date = ?, description = ?, order_id = ?
         WHERE id = ?`
      ).run(
        b.category?.trim() || existing.category,
        b.amountKopecks !== undefined ? Math.round(Number(b.amountKopecks)) : existing.amount_kopecks,
        b.expenseDate || existing.expense_date,
        b.description !== undefined ? b.description.trim() : existing.description,
        b.orderId !== undefined ? b.orderId || null : existing.order_id,
        id
      );
      writeAuditLog(db, req.authUser!.id, 'expense', id, 'expense_updated', {before:existing,after:db.prepare('SELECT * FROM expenses WHERE id=?').get(id)});
    });

    res.json({ ok: true, id });
  });

  // Delete company expense
  router.delete('/expenses/:id', requireAdmin, (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as
      | { id: string; category: string; amount_kopecks: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Расход не найден.' });
      return;
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      writeAuditLog(db, req.authUser!.id, 'expense', id, 'expense_deleted', {
        snapshot: existing,
        category: existing.category,
        amountKopecks: existing.amount_kopecks,
      });
    });
    res.json({ ok: true, id });
  });

  // Admin cost override for order material cost with audit history
  router.post('/orders/:orderId/cost-override', requireAdmin, (req: AuthedRequest, res) => {
    const orderId = String(req.params.orderId);
    const { costOverrideKopecks, reason } = req.body as {
      costOverrideKopecks: number | null;
      reason?: string;
    };

    const existing = db.prepare('SELECT cost_override_kopecks FROM orders WHERE id = ?').get(orderId) as
      | { cost_override_kopecks: number | null }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }

    const nextCost =
      costOverrideKopecks === null || costOverrideKopecks === undefined
        ? null
        : Math.max(0, Math.round(Number(costOverrideKopecks)));

    withTransaction(db, () => {
      db.prepare('UPDATE orders SET cost_override_kopecks = ?, updated_at = ? WHERE id = ?').run(
        nextCost,
        new Date().toISOString(),
        orderId
      );
      writeAuditLog(db, req.authUser!.id, 'order', orderId, 'cost_override_updated', {
        previous: existing.cost_override_kopecks,
        next: nextCost,
        reason: reason || '',
      });
    });

    res.json({ ok: true, costOverrideKopecks: nextCost });
  });

  return router;
}
