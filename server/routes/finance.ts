import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAdmin, type AuthedRequest } from '../middleware.ts';
import { writeAuditLog } from '../security.ts';

import { validDate } from './shifts.ts';

export function createFinanceRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  const getOrderNetPaid = (orderId: string, excludePaymentId?: string): number => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_kopecks), 0) AS total
         FROM client_payments
         WHERE order_id = ?${excludePaymentId ? ' AND id != ?' : ''}`
      )
      .get(...(excludePaymentId ? [orderId, excludePaymentId] : [orderId])) as { total: number };
    return Number(row.total || 0);
  };

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
      .prepare('SELECT id, order_number, title, status, price_kopecks, cost_override_kopecks, scheduled_at, created_at, updated_at FROM orders')
      .all() as Array<{
      id: string;
      order_number: string;
      title: string;
      status: string;
      price_kopecks: number;
      cost_override_kopecks: number | null;
      scheduled_at: string | null;
      created_at: string;
      updated_at: string;
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

    const orderSalaryRows = db
      .prepare(
        `SELECT o_id, COALESCE(SUM(amount_kopecks), 0) AS salary_cost
         FROM (
           SELECT ov.order_id AS o_id, sa.amount_kopecks
           FROM salary_accruals sa
           JOIN order_visits ov ON sa.source_type = 'visit' AND ov.id = sa.source_id
           UNION ALL
           SELECT ws.order_id AS o_id, sa.amount_kopecks
           FROM salary_accruals sa
           JOIN workshop_shifts ws ON sa.source_type = 'shift' AND ws.id = sa.source_id
           WHERE ws.order_id IS NOT NULL
         )
         GROUP BY o_id`
      )
      .all() as Array<{ o_id: string; salary_cost: number }>;
    const salaryByOrder = new Map<string, number>();
    for (const r of orderSalaryRows) {
      salaryByOrder.set(r.o_id, Number(r.salary_cost || 0));
    }

    const payouts = db
      .prepare('SELECT amount_kopecks, paid_at FROM salary_payouts')
      .all() as Array<{ amount_kopecks: number; paid_at: string }>;

    const consumeOps = db
      .prepare(
        `SELECT wo.order_id, wo.qty_milli, wo.unit_cost_kopecks, wo.created_at,
          CAST(ROUND(wo.qty_milli * wo.unit_cost_kopecks / 1000.0) AS INTEGER) AS cost_kopecks
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
    const totalRefundedCashKopecks = filteredPayments
      .filter((p) => Number(p.amount_kopecks || 0) < 0)
      .reduce((s, p) => s + Math.abs(Number(p.amount_kopecks || 0)), 0);

    // Client debt across active orders (calculated strictly per order; overpayment never cancels another order's debt)
    const paidByOrder = new Map<string, number>();
    for (const p of payments) {
      if (p.order_id) {
        paidByOrder.set(
          String(p.order_id),
          (paidByOrder.get(String(p.order_id)) || 0) + Number(p.amount_kopecks || 0)
        );
      }
    }

    const orderAutoCost = new Map<string, number>();
    const orderLatestConsumeDate = new Map<string, string>();
    for (const op of consumeOps) {
      if (!op.order_id) continue;
      orderAutoCost.set(op.order_id, (orderAutoCost.get(op.order_id) || 0) + op.cost_kopecks);
      const prevDate = orderLatestConsumeDate.get(op.order_id);
      if (!prevDate || op.created_at > prevDate) {
        orderLatestConsumeDate.set(op.order_id, op.created_at);
      }
    }

    const overrideDeltas = orders
      .filter((o) => o.status !== 'cancelled' && o.cost_override_kopecks !== null && o.cost_override_kopecks !== undefined)
      .map((o) => ({
        orderId: o.id,
        deltaKopecks: Number(o.cost_override_kopecks) - (orderAutoCost.get(o.id) || 0),
        dateIso: orderLatestConsumeDate.get(o.id) || o.updated_at || o.created_at,
      }));

    const orderBreakdown = activeOrders.map((o) => {
      const paid = paidByOrder.get(o.id) || 0;
      const autoMatCost = orderAutoCost.get(o.id) || 0;
      const effectiveMatCost =
        o.cost_override_kopecks !== null ? o.cost_override_kopecks : autoMatCost;
      const salaryCost = salaryByOrder.get(o.id) || 0;
      return {
        id: o.id,
        order_number: o.order_number,
        title: o.title,
        status: o.status,
        price_kopecks: o.price_kopecks,
        paid_kopecks: paid,
        debt_kopecks: Math.max(0, o.price_kopecks - paid),
        overpaid_kopecks: Math.max(0, paid - o.price_kopecks),
        auto_material_cost_kopecks: autoMatCost,
        cost_override_kopecks: o.cost_override_kopecks,
        effective_material_cost_kopecks: effectiveMatCost,
        salary_cost_kopecks: salaryCost,
        profit_kopecks: o.price_kopecks - effectiveMatCost - salaryCost,
      };
    });

    // Debt and overpayment totals across all non-cancelled orders (running total)
    const nonCancelledOrders = orders.filter((o) => o.status !== 'cancelled');
    const totalClientDebtKopecks = nonCancelledOrders.reduce(
      (s, o) => s + Math.max(0, Number(o.price_kopecks || 0) - (paidByOrder.get(o.id) || 0)),
      0
    );
    const totalClientOverpaidKopecks = nonCancelledOrders.reduce(
      (s, o) => s + Math.max(0, (paidByOrder.get(o.id) || 0) - Number(o.price_kopecks || 0)),
      0
    );
    const periodClientDebtKopecks = orderBreakdown.reduce((s, o) => s + o.debt_kopecks, 0);
    const periodClientOverpaidKopecks = orderBreakdown.reduce((s, o) => s + o.overpaid_kopecks, 0);

    // Separate accrued salary obligations vs actual cash salary payouts
    const accruedSalariesKopecks = filteredAccruals.reduce((s, a) => s + a.amount_kopecks, 0);
    const paidSalariesKopecks = filteredPayouts.reduce((s, p) => s + p.amount_kopecks, 0);

    // Material COGS by actual write-off date + manual override deltas anchored to latest consume/update date
    const autoMaterialCostKopecks = filteredConsumes.reduce((s, op) => s + op.cost_kopecks, 0);
    const periodOverrideDeltaKopecks = overrideDeltas
      .filter((d) => inPeriod(d.dateIso))
      .reduce((s, d) => s + d.deltaKopecks, 0);
    const effectiveMaterialCostKopecks = autoMaterialCostKopecks + periodOverrideDeltaKopecks;

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

    const cancelledOrderIds = new Set(
      orders.filter((o) => o.status === 'cancelled').map((o) => o.id)
    );
    const cancelledOrderMaterialCostKopecks = filteredConsumes
      .filter((op) => op.order_id && cancelledOrderIds.has(op.order_id))
      .reduce((s, op) => s + op.cost_kopecks, 0);

    // Period profit by actual payment & write-off dates
    const totalCostOfGoodsAndOps =
      effectiveMaterialCostKopecks +
      accruedSalariesKopecks +
      operatingExpensesExcludingSalariesAndStock;

    const accrualProfitKopecks = totalReceivedCashKopecks - totalCostOfGoodsAndOps;

    // Cash Flow = Real Cash In (net of refunds) - Real Cash Out
    const cashOutKopecks =
      paidSalariesKopecks +
      materialPurchasesCashKopecks +
      operatingExpensesExcludingSalariesAndStock +
      manualSalaryExpensesKopecks;
    const netCashFlowKopecks = totalReceivedCashKopecks - cashOutKopecks;

    // Monthly Profit & Cash Flow Breakdown (newest month first)
    const monthSet = new Set<string>();
    const addMonth = (dateIso: string | null | undefined) => {
      if (!dateIso) return;
      const m = String(dateIso).slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m)) monthSet.add(m);
    };
    for (const o of orders) {
      if (o.status !== 'cancelled') addMonth(o.scheduled_at || o.created_at);
    }
    for (const p of payments) addMonth(String(p.paid_at || ''));
    for (const e of expenses) addMonth(String(e.expense_date || ''));
    for (const a of accruals) addMonth(a.created_at);
    for (const sp of payouts) addMonth(sp.paid_at);
    for (const op of consumeOps) addMonth(op.created_at);
    for (const d of overrideDeltas) addMonth(d.dateIso);

    const monthlySummary = [...monthSet]
      .sort((a, b) => b.localeCompare(a))
      .map((month) => {
        const mOrdersPrice = orders
          .filter((o) => o.status !== 'cancelled' && String(o.scheduled_at || o.created_at).slice(0, 7) === month)
          .reduce((s, o) => s + o.price_kopecks, 0);
        const mPayments = payments.filter((p) => String(p.paid_at || '').slice(0, 7) === month);
        const mReceivedCash = mPayments.reduce((s, p) => s + Number(p.amount_kopecks || 0), 0);
        const mRefundedCash = mPayments
          .filter((p) => Number(p.amount_kopecks || 0) < 0)
          .reduce((s, p) => s + Math.abs(Number(p.amount_kopecks || 0)), 0);
        const mAutoMat = consumeOps
          .filter((op) => String(op.created_at).slice(0, 7) === month)
          .reduce((s, op) => s + op.cost_kopecks, 0);
        const mOverride = overrideDeltas
          .filter((d) => String(d.dateIso).slice(0, 7) === month)
          .reduce((s, d) => s + d.deltaKopecks, 0);
        const mMaterialCost = mAutoMat + mOverride;
        const mAccruedSalaries = accruals
          .filter((a) => String(a.created_at).slice(0, 7) === month)
          .reduce((s, a) => s + a.amount_kopecks, 0);
        const mPaidSalaries = payouts
          .filter((p) => String(p.paid_at).slice(0, 7) === month)
          .reduce((s, p) => s + p.amount_kopecks, 0);
        const mExpenses = expenses.filter((e) => String(e.expense_date || '').slice(0, 7) === month);
        const mOpEx = mExpenses
          .filter((e) => e.category !== 'salaries' && e.category !== 'materials')
          .reduce((s, e) => s + Number(e.amount_kopecks || 0), 0);
        const mMatPurchases = mExpenses
          .filter((e) => e.category === 'materials')
          .reduce((s, e) => s + Number(e.amount_kopecks || 0), 0);
        const mManualSalaries = mExpenses
          .filter((e) => e.category === 'salaries')
          .reduce((s, e) => s + Number(e.amount_kopecks || 0), 0);
        const mProfit = mReceivedCash - mMaterialCost - mAccruedSalaries - mOpEx;
        const mCashFlow = mReceivedCash - (mPaidSalaries + mMatPurchases + mOpEx + mManualSalaries);
        return {
          month,
          ordersPriceKopecks: mOrdersPrice,
          receivedCashKopecks: mReceivedCash,
          refundedCashKopecks: mRefundedCash,
          materialCostKopecks: mMaterialCost,
          accruedSalariesKopecks: mAccruedSalaries,
          operatingExpensesKopecks: mOpEx,
          profitKopecks: mProfit,
          paidSalariesKopecks: mPaidSalaries,
          cashFlowKopecks: mCashFlow,
        };
      });

    res.json({
      period: { from, to },
      metrics: {
        totalOrderPriceKopecks,
        totalReceivedCashKopecks,
        totalRefundedCashKopecks,
        totalClientDebtKopecks,
        totalClientOverpaidKopecks,
        periodClientDebtKopecks,
        periodClientOverpaidKopecks,
        autoMaterialCostKopecks,
        effectiveMaterialCostKopecks,
        cancelledOrderMaterialCostKopecks,
        materialPurchasesCashKopecks,
        accruedSalariesKopecks,
        paidSalariesKopecks,
        manualSalaryExpensesKopecks,
        operatingExpensesKopecks: operatingExpensesExcludingSalariesAndStock,
        totalExpensesRecordedKopecks,
        accrualProfitKopecks,
        cashOutKopecks,
        netCashFlowKopecks,
      },
      orderBreakdown,
      monthlySummary,
      payments: filteredPayments,
      expenses: filteredExpenses,
    });
  });

  // Record client payment (advance / partial / full / refund)
  router.post('/payments', requireAdmin, (req: AuthedRequest, res) => {
    const { orderId, companyId, contactId, amountKopecks, paymentType, paidAt, comment } =
      req.body as {
        orderId?: string | null;
        companyId?: string | null;
        contactId?: string | null;
        amountKopecks?: number;
        paymentType?: 'advance' | 'partial' | 'full' | 'refund';
        paidAt?: string;
        comment?: string;
      };

    if (amountKopecks === undefined || !Number.isSafeInteger(Number(amountKopecks)) || Number(amountKopecks) <= 0) {
      res.status(400).json({ error: 'Укажите целую положительную сумму операции в копейках.' });
      return;
    }
    if (paidAt !== undefined && !validDate(paidAt)) {
      res.status(400).json({ error: 'Укажите корректную дату операции (ГГГГ-ММ-ДД).' });
      return;
    }
    if (paymentType !== undefined && !['advance', 'partial', 'full', 'refund'].includes(paymentType)) {
      res.status(400).json({ error: 'Некорректный тип операции.' });
      return;
    }

    const id = crypto.randomUUID();
    const absAmount = Number(amountKopecks);
    const pType =
      paymentType === 'advance' || paymentType === 'full' || paymentType === 'refund'
        ? paymentType
        : 'partial';
    const storedAmount = pType === 'refund' ? -absAmount : absAmount;
    const dateStr = paidAt || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    let resolvedCompanyId = companyId || null;
    let resolvedContactId = contactId || null;
    if (orderId) {
      const ord = db.prepare('SELECT company_id, client_contact_id FROM orders WHERE id = ?').get(orderId) as
        | { company_id: string | null; client_contact_id: string | null }
        | undefined;
      if (!ord) {
        res.status(404).json({ error: 'Заказ не найден.' });
        return;
      }
      if (storedAmount < 0 && getOrderNetPaid(orderId) + storedAmount < 0) {
        res.status(400).json({ error: 'Сумма возврата не может превышать оплаченную по заказу сумму.' });
        return;
      }
      resolvedCompanyId = resolvedCompanyId || ord.company_id;
      resolvedContactId = resolvedContactId || ord.client_contact_id;
    }
    if (resolvedCompanyId && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(resolvedCompanyId)) {
      res.status(404).json({ error: 'Компания не найдена.' });
      return;
    }
    if (resolvedContactId && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(resolvedContactId)) {
      res.status(404).json({ error: 'Контакт не найден.' });
      return;
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
        storedAmount,
        pType,
        dateStr,
        (comment || '').trim(),
        req.authUser!.id,
        now
      );
      writeAuditLog(db, req.authUser!.id, 'client_payment', id, pType === 'refund' ? 'payment_refund_created' : 'payment_created', {
        orderId: orderId || null,
        amountKopecks: storedAmount,
        paymentType: pType,
      });
    });

    res.status(201).json({ ok: true, id, amountKopecks: storedAmount, paymentType: pType });
  });

  // Update client payment / refund
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
      paymentType?: 'advance' | 'partial' | 'full' | 'refund';
      paidAt?: string;
      comment?: string;
    };

    if (b.amountKopecks !== undefined && (!Number.isSafeInteger(Number(b.amountKopecks)) || Number(b.amountKopecks) <= 0)) {
      res.status(400).json({ error: 'Сумма операции должна быть целым положительным числом в копейках.' });
      return;
    }
    if (b.paidAt !== undefined && !validDate(b.paidAt)) {
      res.status(400).json({ error: 'Укажите корректную дату операции (ГГГГ-ММ-ДД).' });
      return;
    }
    if (b.paymentType !== undefined && !['advance', 'partial', 'full', 'refund'].includes(b.paymentType)) {
      res.status(400).json({ error: 'Некорректный тип операции.' });
      return;
    }

    const nextType = (b.paymentType || existing.payment_type) as 'advance' | 'partial' | 'full' | 'refund';
    const nextAbsAmount =
      b.amountKopecks !== undefined ? Math.round(Number(b.amountKopecks)) : Math.abs(Number(existing.amount_kopecks));
    const nextStoredAmount = nextType === 'refund' ? -nextAbsAmount : nextAbsAmount;

    const oldOrderId = existing.order_id as string | null;
    const nextOrderId = b.orderId !== undefined ? b.orderId || null : oldOrderId;
    let resolvedCompanyId = existing.company_id as string | null;
    let resolvedContactId = existing.contact_id as string | null;
    if (b.orderId !== undefined) {
      if (nextOrderId) {
        const ord = db.prepare('SELECT company_id, client_contact_id FROM orders WHERE id = ?').get(nextOrderId) as
          | { company_id: string | null; client_contact_id: string | null }
          | undefined;
        if (!ord) {
          res.status(404).json({ error: 'Заказ не найден.' });
          return;
        }
        resolvedCompanyId = ord.company_id || null;
        resolvedContactId = ord.client_contact_id || null;
      } else {
        resolvedCompanyId = null;
        resolvedContactId = null;
      }
    }

    if (oldOrderId && oldOrderId !== nextOrderId && getOrderNetPaid(oldOrderId, id) < 0) {
      res.status(400).json({ error: 'Нельзя отвязать платёж: по прежнему заказу проведён возврат.' });
      return;
    }
    if (nextOrderId && getOrderNetPaid(nextOrderId, id) + nextStoredAmount < 0) {
      res.status(400).json({ error: 'Итоговая оплата по заказу с учётом возвратов не может быть отрицательной.' });
      return;
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
        nextStoredAmount,
        nextType,
        b.paidAt || existing.paid_at,
        b.comment !== undefined ? b.comment.trim() : existing.comment,
        id
      );
      writeAuditLog(db, req.authUser!.id, 'client_payment', id, 'payment_updated', {before:existing,after:db.prepare('SELECT * FROM client_payments WHERE id=?').get(id)});
    });

    res.json({ ok: true, id, amountKopecks: nextStoredAmount, paymentType: nextType });
  });

  // Delete client payment / refund
  router.delete('/payments/:id', requireAdmin, (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM client_payments WHERE id = ?').get(id) as
      | { id: string; order_id: string | null; amount_kopecks: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Платёж не найден.' });
      return;
    }
    if (existing.order_id && Number(existing.amount_kopecks) > 0 && getOrderNetPaid(existing.order_id, id) < 0) {
      res.status(400).json({ error: 'Нельзя удалить платёж, пока по заказу проведён возврат.' });
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

    if (!category || !category.trim() || amountKopecks === undefined || !Number.isSafeInteger(Number(amountKopecks)) || Number(amountKopecks) <= 0) {
      res.status(400).json({ error: 'Укажите категорию и целую положительную сумму расхода в копейках.' });
      return;
    }
    if (expenseDate !== undefined && !validDate(expenseDate)) {
      res.status(400).json({ error: 'Укажите корректную дату расхода (ГГГГ-ММ-ДД).' });
      return;
    }
    if (orderId && !db.prepare('SELECT 1 FROM orders WHERE id = ?').get(orderId)) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }

    const id = crypto.randomUUID();
    const amount = Number(amountKopecks);
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

    if (b.category !== undefined && !b.category.trim()) {
      res.status(400).json({ error: 'Категория расхода не может быть пустой.' });
      return;
    }
    if (b.amountKopecks !== undefined && (!Number.isSafeInteger(Number(b.amountKopecks)) || Number(b.amountKopecks) <= 0)) {
      res.status(400).json({ error: 'Сумма расхода должна быть больше нуля.' });
      return;
    }
    if (b.expenseDate !== undefined && !validDate(b.expenseDate)) {
      res.status(400).json({ error: 'Укажите корректную дату расхода (ГГГГ-ММ-ДД).' });
      return;
    }
    if (b.orderId && !db.prepare('SELECT 1 FROM orders WHERE id = ?').get(b.orderId)) {
      res.status(404).json({ error: 'Заказ не найден.' });
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

    if (
      costOverrideKopecks !== null &&
      costOverrideKopecks !== undefined &&
      (!Number.isSafeInteger(Number(costOverrideKopecks)) || Number(costOverrideKopecks) < 0)
    ) {
      res.status(400).json({ error: 'Себестоимость должна быть целым неотрицательным числом копеек.' });
      return;
    }

    const nextCost =
      costOverrideKopecks === null || costOverrideKopecks === undefined
        ? null
        : Number(costOverrideKopecks);

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
