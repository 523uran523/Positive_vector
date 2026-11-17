import React, { useEffect, useState } from 'react';
import { Download, Pencil, Plus, Receipt, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { apiRequest, formatDateRu, formatRub, PAYMENT_METHOD_LABELS } from '../lib/api';
import type { Order } from '../types/crm';

interface FinanceOverview {
  period: { from: string; to: string };
  metrics: {
    totalOrderPriceKopecks: number;
    totalReceivedCashKopecks: number;
    totalClientDebtKopecks: number;
    autoMaterialCostKopecks: number;
    effectiveMaterialCostKopecks: number;
    materialPurchasesCashKopecks: number;
    accruedSalariesKopecks: number;
    paidSalariesKopecks: number;
    operatingExpensesKopecks: number;
    totalExpensesRecordedKopecks: number;
    accrualProfitKopecks: number;
    cashOutKopecks: number;
    netCashFlowKopecks: number;
  };
  orderBreakdown: Array<{
    id: string;
    order_number: string;
    title: string;
    status: string;
    price_kopecks: number;
    paid_kopecks: number;
    debt_kopecks: number;
    auto_material_cost_kopecks: number;
    cost_override_kopecks: number | null;
    effective_material_cost_kopecks: number;
  }>;
  payments: Array<{
    id: string;
    order_id?: string | null;
    order_number?: string;
    company_name?: string;
    contact_name?: string;
    amount_kopecks: number;
    payment_type: string;
    payment_method: string;
    paid_at: string;
    comment: string;
  }>;
  expenses: Array<{
    id: string;
    category: string;
    amount_kopecks: number;
    payment_method: string;
    expense_date: string;
    description: string;
    order_id?: string | null;
    order_number?: string;
  }>;
}

interface FinanceViewProps {
  orders: Order[];
  expenseCategories: Array<{ key: string; label: string }>;
  onOpenOrderById: (orderId: string) => void;
}

export function FinanceView({ orders, expenseCategories, onOpenOrderById }: FinanceViewProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [modal, setModal] = useState<'payment' | 'expense' | 'override' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  // Payment form
  const [payOrderId, setPayOrderId] = useState('');
  const [payAmountRub, setPayAmountRub] = useState('');
  const [payType, setPayType] = useState<'advance' | 'partial' | 'full'>('partial');
  const [payMethod, setPayMethod] = useState<'cash' | 'bank' | 'card'>('bank');
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payComment, setPayComment] = useState('');

  // Expense form
  const [expCategory, setExpCategory] = useState(expenseCategories[0]?.key || 'fuel');
  const [expAmountRub, setExpAmountRub] = useState('');
  const [expMethod, setExpMethod] = useState<'cash' | 'bank' | 'card'>('card');
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));
  const [expOrderId, setExpOrderId] = useState('');
  const [expDesc, setExpDesc] = useState('');

  // Cost override
  const [ovrOrderId, setOvrOrderId] = useState('');
  const [ovrRub, setOvrRub] = useState('');
  const [ovrReason, setOvrReason] = useState('');

  const loadOverview = async () => {
    try {
      setError('');
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const res = await apiRequest<FinanceOverview>(`/api/finance/overview?${qs.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки финансов');
    }
  };

  useEffect(() => {
    void loadOverview();
  }, [from, to]);

  const openNewPayment = () => {
    setEditingPaymentId(null);
    setPayOrderId('');
    setPayAmountRub('');
    setPayType('partial');
    setPayMethod('bank');
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayComment('');
    setModal('payment');
  };

  const openEditPayment = (p: FinanceOverview['payments'][number]) => {
    setEditingPaymentId(p.id);
    setPayOrderId(p.order_id || '');
    setPayAmountRub(String(Math.round(p.amount_kopecks / 100)));
    setPayType((p.payment_type as 'advance' | 'partial' | 'full') || 'partial');
    setPayMethod((p.payment_method as 'cash' | 'bank' | 'card') || 'bank');
    setPayDate((p.paid_at || '').slice(0, 10));
    setPayComment(p.comment || '');
    setModal('payment');
  };

  const openNewExpense = () => {
    setEditingExpenseId(null);
    setExpCategory(expenseCategories[0]?.key || 'fuel');
    setExpAmountRub('');
    setExpMethod('card');
    setExpDate(new Date().toISOString().slice(0, 10));
    setExpOrderId('');
    setExpDesc('');
    setModal('expense');
  };

  const openEditExpense = (ex: FinanceOverview['expenses'][number]) => {
    setEditingExpenseId(ex.id);
    setExpCategory(ex.category);
    setExpAmountRub(String(Math.round(ex.amount_kopecks / 100)));
    setExpMethod((ex.payment_method as 'cash' | 'bank' | 'card') || 'card');
    setExpDate((ex.expense_date || '').slice(0, 10));
    setExpOrderId(ex.order_id || '');
    setExpDesc(ex.description || '');
    setModal('expense');
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        orderId: payOrderId || null,
        amountKopecks: Math.round(Number(payAmountRub) * 100),
        paymentType: payType,
        paymentMethod: payMethod,
        paidAt: payDate,
        comment: payComment,
      };
      const res = editingPaymentId
        ? await apiRequest<{ offlineQueued?: boolean }>(`/api/finance/payments/${editingPaymentId}`, {
            method: 'PATCH',
            body: payload,
            offlineLabel: 'Обновление платежа клиента',
          })
        : await apiRequest<{ offlineQueued?: boolean }>('/api/finance/payments', {
            method: 'POST',
            body: payload,
            offlineLabel: 'Запись платежа клиента',
          });
      setModal(null);
      setEditingPaymentId(null);
      setPayAmountRub('');
      setPayComment('');
      if (res.offlineQueued) {
        setNotice('Платёж сохранён в офлайн-очередь.');
      } else {
        await loadOverview();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения оплаты');
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePayment = async (id: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/finance/payments/${id}`, {
        method: 'DELETE',
        offlineLabel: 'Удаление платежа клиента',
      });
      setConfirmDeleteKey(null);
      if (res.offlineQueued) {
        setNotice('Удаление платежа поставлено в офлайн-очередь.');
      } else {
        await loadOverview();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления платежа');
    } finally {
      setBusy(false);
    }
  };

  const handleExpenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        category: expCategory,
        amountKopecks: Math.round(Number(expAmountRub) * 100),
        paymentMethod: expMethod,
        expenseDate: expDate,
        orderId: expOrderId || null,
        description: expDesc,
      };
      const res = editingExpenseId
        ? await apiRequest<{ offlineQueued?: boolean }>(`/api/finance/expenses/${editingExpenseId}`, {
            method: 'PATCH',
            body: payload,
            offlineLabel: 'Обновление расхода',
          })
        : await apiRequest<{ offlineQueued?: boolean }>('/api/finance/expenses', {
            method: 'POST',
            body: payload,
            offlineLabel: 'Запись расхода',
          });
      setModal(null);
      setEditingExpenseId(null);
      setExpAmountRub('');
      setExpDesc('');
      if (res.offlineQueued) {
        setNotice('Расход сохранён в офлайн-очередь.');
      } else {
        await loadOverview();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения расхода');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteExpense = async (id: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/finance/expenses/${id}`, {
        method: 'DELETE',
        offlineLabel: 'Удаление расхода',
      });
      setConfirmDeleteKey(null);
      if (res.offlineQueued) {
        setNotice('Удаление расхода поставлено в офлайн-очередь.');
      } else {
        await loadOverview();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления расхода');
    } finally {
      setBusy(false);
    }
  };

  const handleOverrideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ovrOrderId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/finance/orders/${ovrOrderId}/cost-override`, {
        method: 'POST',
        body: {
          costOverrideKopecks: ovrRub.trim() === '' ? null : Math.round(Number(ovrRub) * 100),
          reason: ovrReason,
        },
        offlineLabel: 'Корректировка себестоимости',
      });
      setModal(null);
      if (res.offlineQueued) {
        setNotice('Корректировка себестоимости поставлена в офлайн-очередь.');
      } else {
        await loadOverview();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления себестоимости');
    } finally {
      setBusy(false);
    }
  };

  const exportUrl = `/api/export/finance.xlsx${from || to ? `?from=${from}&to=${to}` : ''}`;
  const m = data?.metrics;

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          {notice}
        </div>
      )}
      {/* Filter & Actions */}
      <div className="flex flex-col justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] lg:flex-row lg:items-center dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
          />
          <span className="text-xs text-zinc-400">—</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
          />
          {(from || to) && (
            <button
              type="button"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
              className="text-xs font-medium text-[#0071E3] hover:underline"
            >
              Сбросить
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openNewPayment}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Оплата клиента</span>
          </button>
          <button
            type="button"
            onClick={openNewExpense}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
          >
            <Receipt className="h-3.5 w-3.5" />
            <span>Расход</span>
          </button>
          <a
            href={exportUrl}
            className="inline-flex items-center gap-1.5 rounded-xl border border-black/[0.08] px-3.5 py-2 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]"
          >
            <Download className="h-3.5 w-3.5" />
            <span>XLSX</span>
          </a>
        </div>
      </div>

      {/* KPI Metrics Grid — cleanly separated accrual vs cash flows */}
      {m && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
            <div className="text-xs text-zinc-500">Объём заказов</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{formatRub(m.totalOrderPriceKopecks)}</div>
            <div className="mt-1 text-[11px] text-emerald-600 tabular-nums dark:text-emerald-400">
              Получено деньгами: {formatRub(m.totalReceivedCashKopecks)}
            </div>
          </div>

          <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
            <div className="text-xs text-zinc-500">Долг клиентов</div>
            <div className="mt-1 text-xl font-bold text-amber-600 tabular-nums dark:text-amber-400">
              {formatRub(m.totalClientDebtKopecks)}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">По активным заказам</div>
          </div>

          <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
            <div className="text-xs text-zinc-500">Зарплаты и материалы</div>
            <div className="mt-1 text-base font-bold tabular-nums">
              Начислено ЗП: {formatRub(m.accruedSalariesKopecks)}
            </div>
            <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
              Выплачено: {formatRub(m.paidSalariesKopecks)} · Себест. мат.:{' '}
              {formatRub(m.effectiveMaterialCostKopecks)}
            </div>
          </div>

          <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>Чистая прибыль / Касса</span>
              {m.accrualProfitKopecks >= 0 ? (
                <TrendingUp className="h-4 w-4 text-emerald-500" />
              ) : (
                <TrendingDown className="h-4 w-4 text-red-500" />
              )}
            </div>
            <div className="mt-1 text-xl font-bold tabular-nums">{formatRub(m.accrualProfitKopecks)}</div>
            <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
              Денежный поток: {formatRub(m.netCashFlowKopecks)}
            </div>
          </div>
        </div>
      )}

      {/* Order Financial Breakdown */}
      {data && (
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 sm:p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
          <h3 className="mb-3 font-display text-base font-bold">Экономика заказов</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-black/[0.06] text-zinc-400 dark:border-white/[0.08]">
                  <th className="py-2 pr-3 font-semibold">Заказ</th>
                  <th className="py-2 px-3 font-semibold">Цена</th>
                  <th className="py-2 px-3 font-semibold">Оплачено</th>
                  <th className="py-2 px-3 font-semibold">Долг</th>
                  <th className="py-2 px-3 font-semibold">Материалы</th>
                  <th className="py-2 pl-3 text-right font-semibold">Действие</th>
                </tr>
              </thead>
              <tbody>
                {data.orderBreakdown.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]"
                  >
                    <td className="py-2.5 pr-3">
                      <button
                        type="button"
                        onClick={() => onOpenOrderById(o.id)}
                        className="text-left hover:text-[#0071E3]"
                      >
                        <span className="font-mono font-semibold text-zinc-500">{o.order_number}</span>{' '}
                        <span className="font-semibold">{o.title}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 font-semibold tabular-nums">{formatRub(o.price_kopecks)}</td>
                    <td className="px-3 py-2.5 text-emerald-600 tabular-nums dark:text-emerald-400">
                      {formatRub(o.paid_kopecks)}
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-amber-600 tabular-nums dark:text-amber-400">
                      {formatRub(o.debt_kopecks)}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {formatRub(o.effective_material_cost_kopecks)}
                      {o.cost_override_kopecks !== null && (
                        <span className="ml-1 text-[10px] text-[#0071E3]">(ручн.)</span>
                      )}
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setOvrOrderId(o.id);
                          setOvrRub(
                            o.cost_override_kopecks !== null
                              ? String(Math.round(o.cost_override_kopecks / 100))
                              : ''
                          );
                          setOvrReason('');
                          setModal('override');
                        }}
                        className="text-xs font-medium text-[#0071E3] hover:underline dark:text-[#2997FF]"
                      >
                        Изм. себест.
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payments & Expenses Feed */}
      {data && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-black/[0.06] bg-white p-4 sm:p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
            <h3 className="mb-3 font-display text-base font-bold">Поступления от клиентов</h3>
            <div className="space-y-2">
              {data.payments.length === 0 ? (
                <div className="text-xs text-zinc-400">Платежей за период нет</div>
              ) : (
                data.payments.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-semibold">
                        {p.order_number ? `${p.order_number} · ` : ''}
                        {p.company_name || p.contact_name || 'Платёж клиента'}
                      </div>
                      <div className="text-zinc-400">
                        {formatDateRu(p.paid_at)} · {PAYMENT_METHOD_LABELS[p.payment_method] || p.payment_method}
                        {p.comment ? ` · ${p.comment}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                        +{formatRub(p.amount_kopecks)}
                      </div>
                      <button
                        type="button"
                        onClick={() => openEditPayment(p)}
                        title="Редактировать платёж"
                        className="text-zinc-400 hover:text-[#0071E3]"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {confirmDeleteKey !== `pay:${p.id}` ? (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteKey(`pay:${p.id}`)}
                          title="Удалить платёж"
                          className="text-zinc-400 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px]">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDeletePayment(p.id)}
                            className="font-semibold text-red-600"
                          >
                            Удал.
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteKey(null)}
                            className="text-zinc-500"
                          >
                            Отм.
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-black/[0.06] bg-white p-4 sm:p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
            <h3 className="mb-3 font-display text-base font-bold">Расходы компании</h3>
            <div className="space-y-2">
              {data.expenses.length === 0 ? (
                <div className="text-xs text-zinc-400">Расходов за период нет</div>
              ) : (
                data.expenses.map((ex) => {
                  const catLabel =
                    expenseCategories.find((c) => c.key === ex.category)?.label || ex.category;
                  return (
                    <div
                      key={ex.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold">
                          {catLabel} {ex.order_number ? `· ${ex.order_number}` : ''}
                        </div>
                        <div className="text-zinc-400">
                          {formatDateRu(ex.expense_date)} · {ex.description || PAYMENT_METHOD_LABELS[ex.payment_method]}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <div className="font-bold text-red-600 tabular-nums dark:text-red-400">
                          −{formatRub(ex.amount_kopecks)}
                        </div>
                        <button
                          type="button"
                          onClick={() => openEditExpense(ex)}
                          title="Редактировать расход"
                          className="text-zinc-400 hover:text-[#0071E3]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {confirmDeleteKey !== `exp:${ex.id}` ? (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteKey(`exp:${ex.id}`)}
                            title="Удалить расход"
                            className="text-zinc-400 hover:text-red-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px]">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleDeleteExpense(ex.id)}
                              className="font-semibold text-red-600"
                            >
                              Удал.
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteKey(null)}
                              className="text-zinc-500"
                            >
                              Отм.
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {modal === 'payment' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handlePaymentSubmit}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {editingPaymentId ? 'Редактировать оплату клиента' : 'Принять оплату клиента'}
              </h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <select
                value={payOrderId}
                onChange={(e) => setPayOrderId(e.target.value)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              >
                <option value="">Без привязки к заказу</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.order_number} · {o.title}
                  </option>
                ))}
              </select>
              <input
                type="number"
                required
                min="1"
                value={payAmountRub}
                onChange={(e) => setPayAmountRub(e.target.value)}
                placeholder="Сумма, ₽ *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={payType}
                  onChange={(e) => setPayType(e.target.value as any)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="advance">Аванс</option>
                  <option value="partial">Частичная оплата</option>
                  <option value="full">Полный расчёт</option>
                </select>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as any)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="bank">Безнал (р/с)</option>
                  <option value="card">Карта</option>
                  <option value="cash">Наличные</option>
                </select>
              </div>
              <input
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <input
                type="text"
                value={payComment}
                onChange={(e) => setPayComment(e.target.value)}
                placeholder="Комментарий"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white"
            >
              Записать оплату
            </button>
          </form>
        </div>
      )}

      {/* Expense Modal */}
      {modal === 'expense' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleExpenseSubmit}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {editingExpenseId ? 'Редактировать расход' : 'Новый расход'}
              </h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <select
                value={expCategory}
                onChange={(e) => setExpCategory(e.target.value)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              >
                {expenseCategories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                required
                min="1"
                value={expAmountRub}
                onChange={(e) => setExpAmountRub(e.target.value)}
                placeholder="Сумма, ₽ *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={expMethod}
                  onChange={(e) => setExpMethod(e.target.value as any)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="card">Карта</option>
                  <option value="cash">Наличные</option>
                  <option value="bank">Безнал (р/с)</option>
                </select>
                <input
                  type="date"
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
              <select
                value={expOrderId}
                onChange={(e) => setExpOrderId(e.target.value)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              >
                <option value="">Общий расход компании</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.order_number} · {o.title}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={expDesc}
                onChange={(e) => setExpDesc(e.target.value)}
                placeholder="Описание расхода"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Сохранить расход
            </button>
          </form>
        </div>
      )}

      {/* Override Order Material Cost Modal */}
      {modal === 'override' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleOverrideSubmit}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Ручная себестоимость материалов</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-3 text-xs text-zinc-500">
              Оставьте поле суммы пустым, чтобы вернуться к автоматическому расчёту по списаниям со склада.
            </p>
            <div className="space-y-3">
              <input
                type="number"
                value={ovrRub}
                onChange={(e) => setOvrRub(e.target.value)}
                placeholder="Сумма себестоимости, ₽"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <input
                type="text"
                value={ovrReason}
                onChange={(e) => setOvrReason(e.target.value)}
                placeholder="Причина корректировки (запишется в аудит)"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Применить
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
