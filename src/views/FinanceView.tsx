import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, BarChart3, Briefcase, Download, Pencil, Plus, Receipt, Search, Trash2, TrendingDown, TrendingUp, Users, X } from 'lucide-react';
import { DatePresets } from '../components/DatePresets';
import { SectionHeader } from '../components/SectionHeader';
import { apiRequest, formatDateRu, formatRub, PAYMENT_TYPE_LABELS } from '../lib/api';
import type { Order } from '../types/crm';

interface FinanceOverview {
  period: { from: string; to: string };
  metrics: {
    totalOrderPriceKopecks: number;
    totalReceivedCashKopecks: number;
    totalClientDebtKopecks: number;
    periodClientDebtKopecks: number;
    autoMaterialCostKopecks: number;
    effectiveMaterialCostKopecks: number;
    cancelledOrderMaterialCostKopecks: number;
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
    paid_at: string;
    comment: string;
  }>;
  expenses: Array<{
    id: string;
    category: string;
    amount_kopecks: number;
    expense_date: string;
    description: string;
    order_id?: string | null;
    order_number?: string;
  }>;
}

type FinanceTab = 'overview' | 'cashflow' | 'orders';

interface FinanceViewProps {
  orders: Order[];
  expenseCategories: Array<{ key: string; label: string }>;
  onOpenOrderById: (orderId: string) => void;
  onOpenSalaries?: () => void;
}

export function FinanceView({ orders, expenseCategories, onOpenOrderById, onOpenSalaries }: FinanceViewProps) {
  const [tab, setTab] = useState<FinanceTab>('overview');
  const [cashflowType, setCashflowType] = useState<'all' | 'income' | 'expense'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [expFilterCat, setExpFilterCat] = useState('');
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [modal, setModal] = useState<'payment' | 'expense' | 'override' | 'price' | null>(null);
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
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payComment, setPayComment] = useState('');

  // Expense form
  const [expCategory, setExpCategory] = useState(expenseCategories[0]?.key || 'fuel');
  const [expAmountRub, setExpAmountRub] = useState('');
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));
  const [expOrderId, setExpOrderId] = useState('');
  const [expDesc, setExpDesc] = useState('');

  // Cost override
  const [ovrOrderId, setOvrOrderId] = useState('');
  const [ovrRub, setOvrRub] = useState('');
  const [ovrReason, setOvrReason] = useState('');

  // Order price correction
  const [priceOrderId, setPriceOrderId] = useState('');
  const [priceRub, setPriceRub] = useState('');

  // Inline table editing for Экономика заказов
  const [inlineEdit, setInlineEdit] = useState<{
    orderId: string;
    field: 'price' | 'debt' | 'materials';
    initialRub: string;
  } | null>(null);
  const [inlineValue, setInlineValue] = useState('');

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
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayComment('');
    setModal('payment');
  };

  const openPaymentForOrder = (orderId: string, paidKopecks: number) => {
    setEditingPaymentId(null);
    setPayOrderId(orderId);
    setPayAmountRub('');
    setPayType(Number(paidKopecks) <= 0 ? 'advance' : 'partial');
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayComment('');
    setModal('payment');
  };

  const openEditPayment = (p: FinanceOverview['payments'][number]) => {
    setEditingPaymentId(p.id);
    setPayOrderId(p.order_id || '');
    setPayAmountRub(String(Math.round(p.amount_kopecks / 100)));
    setPayType((p.payment_type as 'advance' | 'partial' | 'full') || 'partial');
    setPayDate((p.paid_at || '').slice(0, 10));
    setPayComment(p.comment || '');
    setModal('payment');
  };

  const openNewExpense = () => {
    setEditingExpenseId(null);
    setExpCategory(expenseCategories[0]?.key || 'fuel');
    setExpAmountRub('');
    setExpDate(new Date().toISOString().slice(0, 10));
    setExpOrderId('');
    setExpDesc('');
    setModal('expense');
  };

  const openEditExpense = (ex: FinanceOverview['expenses'][number]) => {
    setEditingExpenseId(ex.id);
    setExpCategory(ex.category);
    setExpAmountRub(String(Math.round(ex.amount_kopecks / 100)));
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

  const openPriceEditor = (order: FinanceOverview['orderBreakdown'][number]) => {
    setPriceOrderId(order.id);
    setPriceRub(String(Math.round(order.price_kopecks / 100)));
    setModal('price');
  };

  const handlePriceSubmit = async (e: React.FormEvent) => {    e.preventDefault();
    if (!priceOrderId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const rub = priceRub.trim() === '' ? 0 : Number(priceRub);
      if (!Number.isFinite(rub) || rub < 0) {
        setError('Укажите неотрицательную сумму заказа.');
        return;
      }
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/orders/${priceOrderId}`, {
        method: 'PATCH',
        body: { priceKopecks: Math.round(rub * 100) },
        offlineLabel: 'Изменение суммы заказа',
      });
      setModal(null);
      if (res.offlineQueued) {
        setNotice('Изменение суммы заказа поставлено в офлайн-очередь.');
      } else {
        await loadOverview();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка изменения суммы заказа');
    } finally {
      setBusy(false);
    }
  };

  const startInlineEdit = (
    o: FinanceOverview['orderBreakdown'][number],
    field: 'price' | 'debt' | 'materials'
  ) => {
    const rawVal =
      field === 'price'
        ? String(Math.round(o.price_kopecks / 100))
        : field === 'debt'
          ? String(Math.round(o.debt_kopecks / 100))
          : o.cost_override_kopecks !== null
            ? String(Math.round(o.cost_override_kopecks / 100))
            : String(Math.round(o.effective_material_cost_kopecks / 100));
    setInlineEdit({ orderId: o.id, field, initialRub: rawVal });
    setInlineValue(rawVal);
  };

  const commitInlineEdit = async (o: FinanceOverview['orderBreakdown'][number]) => {
    if (!inlineEdit || inlineEdit.orderId !== o.id) return;
    const { field, initialRub } = inlineEdit;
    const trimmed = inlineValue.trim();
    setInlineEdit(null);

    if (field !== 'materials' && trimmed === initialRub) return;
    if (field === 'materials' && trimmed === initialRub && o.cost_override_kopecks !== null) return;
    if (field === 'materials' && trimmed === initialRub && o.cost_override_kopecks === null) return;

    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (field === 'materials') {
        if (trimmed !== '') {
          const rub = Number(trimmed);
          if (!Number.isFinite(rub) || rub < 0) {
            setError('Укажите корректную себестоимость материалов.');
            return;
          }
        }
        const res = await apiRequest<{ offlineQueued?: boolean }>(
          `/api/finance/orders/${o.id}/cost-override`,
          {
            method: 'POST',
            body: {
              costOverrideKopecks: trimmed === '' ? null : Math.round(Number(trimmed) * 100),
              reason: trimmed === '' ? 'Возврат к расчёту по складу' : 'Правка в таблице финансов',
            },
            offlineLabel: `Себестоимость ${o.order_number}`,
          }
        );
        if (res.offlineQueued) setNotice('Корректировка себестоимости поставлена в офлайн-очередь.');
        else await loadOverview();
        return;
      }

      const rub = trimmed === '' ? 0 : Number(trimmed);
      if (!Number.isFinite(rub) || rub < 0) {
        setError('Укажите неотрицательную сумму.');
        return;
      }
      const nextPriceKopecks =
        field === 'price' ? Math.round(rub * 100) : Math.max(0, o.paid_kopecks + Math.round(rub * 100));
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/orders/${o.id}`, {
        method: 'PATCH',
        body: { priceKopecks: nextPriceKopecks },
        offlineLabel: `Сумма заказа ${o.order_number}`,
      });
      if (res.offlineQueued) setNotice('Изменение суммы заказа поставлено в офлайн-очередь.');
      else await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления таблицы');
    } finally {
      setBusy(false);
    }
  };

  const exportUrl = `/api/export/finance.xlsx${from || to ? `?from=${from}&to=${to}` : ''}`;
  const m = data?.metrics;

  const filteredPayments = useMemo(() => {
    const items = data?.payments || [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((p) =>
      `${p.order_number || ''} ${p.company_name || ''} ${p.contact_name || ''} ${p.comment || ''}`
        .toLowerCase()
        .includes(q)
    );
  }, [data?.payments, search]);

  const filteredExpenses = useMemo(() => {
    const items = data?.expenses || [];
    const q = search.trim().toLowerCase();
    return items.filter((ex) => {
      if (expFilterCat && ex.category !== expFilterCat) return false;
      if (!q) return true;
      const catLabel = expenseCategories.find((c) => c.key === ex.category)?.label || ex.category;
      return `${catLabel} ${ex.order_number || ''} ${ex.description || ''}`.toLowerCase().includes(q);
    });
  }, [data?.expenses, search, expFilterCat, expenseCategories]);

  const filteredOrderBreakdown = useMemo(() => {
    const items = data?.orderBreakdown || [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((o) => `${o.order_number} ${o.title}`.toLowerCase().includes(q));
  }, [data?.orderBreakdown, search]);

  const cashflowItems = useMemo(() => {
    const rows: Array<
      | { kind: 'income'; sortDate: string; item: FinanceOverview['payments'][number] }
      | { kind: 'expense'; sortDate: string; item: FinanceOverview['expenses'][number] }
    > = [];
    if (cashflowType === 'all' || cashflowType === 'income') {
      for (const p of filteredPayments) {
        rows.push({ kind: 'income', sortDate: p.paid_at || '', item: p });
      }
    }
    if (cashflowType === 'all' || cashflowType === 'expense') {
      for (const ex of filteredExpenses) {
        rows.push({ kind: 'expense', sortDate: ex.expense_date || '', item: ex });
      }
    }
    rows.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
    return rows;
  }, [cashflowType, filteredPayments, filteredExpenses]);

  return (
    <div className="space-y-5">
      <SectionHeader<FinanceTab>
        title="Финансы"
        description="Поступления, расходы компании, долги клиентов и экономика заказов"
        actions={
          <>
            <button
              type="button"
              onClick={openNewPayment}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"
            >
              <Plus className="h-4 w-4" />
              <span>Оплата клиента</span>
            </button>
            <button
              type="button"
              onClick={openNewExpense}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-[#0077ED] dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              <Receipt className="h-4 w-4" />
              <span>Расход</span>
            </button>
            <a
              href={exportUrl}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-black/[0.08] bg-white px-3.5 py-2 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1] dark:bg-[#0B0C10]"
            >
              <Download className="h-4 w-4" />
              <span>XLSX</span>
            </a>
          </>
        }
        tabs={[
          { id: 'overview', label: 'Обзор', icon: BarChart3 },
          {
            id: 'cashflow',
            label: 'Движение денег',
            count: data ? data.payments.length + data.expenses.length : undefined,
            icon: ArrowLeftRight,
          },
          { id: 'orders', label: 'Экономика заказов', count: data?.orderBreakdown.length, icon: Briefcase },
        ]}
        activeTab={tab}
        onSelectTab={setTab}
        filters={
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  aria-label="Период с"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                />
                <span className="text-xs text-zinc-400">—</span>
                <input
                  type="date"
                  aria-label="Период по"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                />
                {(from || to) && (
                  <button
                    type="button"
                    onClick={() => {
                      setFrom('');
                      setTo('');
                    }}
                    className="text-xs font-medium text-[#0071E3] hover:underline dark:text-[#2997FF]"
                  >
                    Сбросить период
                  </button>
                )}
              </div>
              <DatePresets
                from={from}
                to={to}
                onChange={(f, t) => {
                  setFrom(f);
                  setTo(t);
                }}
              />
            </div>

            {tab !== 'overview' && (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                {tab === 'cashflow' && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[
                      { id: 'all', label: 'Все' },
                      { id: 'income', label: 'Поступления' },
                      { id: 'expense', label: 'Расходы' },
                    ].map((pill) => {
                      const active = cashflowType === pill.id;
                      return (
                        <button
                          key={pill.id}
                          type="button"
                          onClick={() => setCashflowType(pill.id as typeof cashflowType)}
                          className={`min-h-[32px] rounded-xl px-3 py-1 text-xs font-semibold transition ${
                            active
                              ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                              : 'bg-[#F5F5F7] text-zinc-600 hover:bg-black/[0.06] dark:bg-[#0B0C10] dark:text-zinc-300 dark:hover:bg-white/[0.08]'
                          }`}
                        >
                          {pill.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="relative min-w-[200px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={
                      tab === 'cashflow'
                        ? 'Поиск по клиенту, заказу, категории или комментарию...'
                        : 'Поиск по номеру или названию заказа...'
                    }
                    className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-2 pl-8 pr-3 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10] dark:focus:bg-[#0B0C10]"
                  />
                </div>

                {tab === 'cashflow' && cashflowType !== 'income' && (
                  <select
                    aria-label="Категория расхода"
                    value={expFilterCat}
                    onChange={(e) => setExpFilterCat(e.target.value)}
                    className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                  >
                    <option value="">Все категории</option>
                    {expenseCategories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        }
      />

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

      {/* Tab 1: Overview */}
      {tab === 'overview' && m && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              <div className="mt-1 text-[11px] text-zinc-400">
                По всем активным заказам
                {(from || to) && <> · за период: {formatRub(m.periodClientDebtKopecks)}</>}
              </div>
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

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
              <div className="text-xs text-zinc-500">Операционные расходы</div>
              <div className="mt-1 text-lg font-bold tabular-nums">{formatRub(m.operatingExpensesKopecks)}</div>
              <div className="mt-1 text-[11px] text-zinc-400">
                Закупки материалов: {formatRub(m.materialPurchasesCashKopecks)}
              </div>
            </div>
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
              <div className="text-xs text-zinc-500">Быстрый переход к расчётам</div>
              <div className="mt-1 text-sm font-semibold">
                {data?.payments.length || 0} платежей · {data?.expenses.length || 0} расходов
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setTab('cashflow')}
                  className="text-xs font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                >
                  Движение денег →
                </button>
                <button
                  type="button"
                  onClick={() => setTab('orders')}
                  className="text-xs font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                >
                  Экономика заказов →
                </button>
              </div>
            </div>
            {onOpenSalaries && (
              <div className="flex flex-col justify-between rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
                <div>
                  <div className="text-xs text-zinc-500">Выплаты сотрудникам</div>
                  <div className="mt-1 text-sm font-semibold">
                    Остаток к выплате и начисления по сменам
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onOpenSalaries}
                  className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0071E3]/10 px-3 py-2 text-xs font-semibold text-[#0071E3] hover:bg-[#0071E3]/15 dark:text-[#2997FF]"
                >
                  <Users className="h-3.5 w-3.5" />
                  <span>Открыть зарплаты в «Сотрудниках»</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Unified Cashflow (Payments + Expenses) */}
      {tab === 'cashflow' && data && (
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 sm:p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-bold">
              Движение денег ({cashflowItems.length})
            </h3>
            <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums">
              {cashflowType !== 'expense' && (
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  Поступления: +{formatRub(filteredPayments.reduce((s, p) => s + p.amount_kopecks, 0))}
                </span>
              )}
              {cashflowType !== 'income' && (
                <span className="font-semibold text-red-600 dark:text-red-400">
                  Расходы: −{formatRub(filteredExpenses.reduce((s, e) => s + e.amount_kopecks, 0))}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {cashflowItems.length === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-400">
                Операций за выбранный период нет
              </div>
            ) : (
              cashflowItems.map((entry) => {
                if (entry.kind === 'income') {
                  const p = entry.item;
                  return (
                    <div
                      key={`pay:${p.id}`}
                      className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 truncate font-semibold">
                          <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                            Поступление
                          </span>
                          {p.order_number && p.order_id ? (
                            <button
                              type="button"
                              onClick={() => onOpenOrderById(p.order_id!)}
                              className="font-mono text-[#0071E3] hover:underline dark:text-[#2997FF]"
                            >
                              {p.order_number}
                            </button>
                          ) : p.order_number ? (
                            <span className="font-mono text-zinc-500">{p.order_number}</span>
                          ) : null}
                          <span>{p.company_name || p.contact_name || 'Платёж клиента'}</span>
                        </div>
                        <div className="text-zinc-400">
                          {formatDateRu(p.paid_at)} · {PAYMENT_TYPE_LABELS[p.payment_type] || p.payment_type}
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
                  );
                }

                const ex = entry.item;
                const catLabel =
                  expenseCategories.find((c) => c.key === ex.category)?.label || ex.category;
                return (
                  <div
                    key={`exp:${ex.id}`}
                    className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 truncate font-semibold">
                        <span className="rounded bg-red-500/12 px-1.5 py-0.5 text-[10px] font-bold text-red-600 dark:text-red-400">
                          Расход
                        </span>
                        <span>{catLabel}</span>
                        {ex.order_number && ex.order_id ? (
                          <button
                            type="button"
                            onClick={() => onOpenOrderById(ex.order_id!)}
                            className="font-mono text-[#0071E3] hover:underline dark:text-[#2997FF]"
                          >
                            {ex.order_number}
                          </button>
                        ) : ex.order_number ? (
                          <span className="font-mono text-zinc-500">{ex.order_number}</span>
                        ) : null}
                      </div>
                      <div className="text-zinc-400">
                        {formatDateRu(ex.expense_date)} {ex.description ? `· ${ex.description}` : ''}
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
      )}

      {/* Tab 4: Order Breakdown */}
      {tab === 'orders' && data && (
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 sm:p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
          <h3 className="mb-3 font-display text-base font-bold">
            Экономика заказов ({filteredOrderBreakdown.length})
          </h3>
          {filteredOrderBreakdown.length === 0 ? (
            <div className="py-6 text-center text-xs text-zinc-400">Заказы не найдены</div>
          ) : (
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
                {filteredOrderBreakdown.map((o) => {
                  const isEdPrice = inlineEdit?.orderId === o.id && inlineEdit.field === 'price';
                  const isEdDebt = inlineEdit?.orderId === o.id && inlineEdit.field === 'debt';
                  const isEdMat = inlineEdit?.orderId === o.id && inlineEdit.field === 'materials';
                  const onInlineKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitInlineEdit(o);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setInlineEdit(null);
                    }
                  };
                  return (
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
                    <td className="px-3 py-2.5 font-semibold tabular-nums">
                      {isEdPrice ? (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          autoFocus
                          aria-label={`Цена ${o.order_number}`}
                          value={inlineValue}
                          onChange={(e) => setInlineValue(e.target.value)}
                          onBlur={() => void commitInlineEdit(o)}
                          onKeyDown={onInlineKeyDown}
                          className="w-24 rounded-lg border border-[#0071E3] bg-white px-2 py-1 text-xs tabular-nums outline-none dark:bg-[#0B0C10]"
                        />
                      ) : (
                        <button
                          type="button"
                          title="Нажмите для быстрого редактирования цены"
                          onClick={() => startInlineEdit(o, 'price')}
                          className="cursor-pointer rounded px-1 py-0.5 hover:bg-black/[0.04] hover:text-[#0071E3] dark:hover:bg-white/[0.06] dark:hover:text-[#2997FF]"
                        >
                          {formatRub(o.price_kopecks)}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-emerald-600 tabular-nums dark:text-emerald-400">
                      <button
                        type="button"
                        title="Нажмите, чтобы записать оплату"
                        onClick={() => openPaymentForOrder(o.id, o.paid_kopecks)}
                        className="cursor-pointer rounded px-1 py-0.5 hover:bg-emerald-500/10"
                      >
                        {formatRub(o.paid_kopecks)}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-amber-600 tabular-nums dark:text-amber-400">
                      {isEdDebt ? (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          autoFocus
                          aria-label={`Долг ${o.order_number}`}
                          value={inlineValue}
                          onChange={(e) => setInlineValue(e.target.value)}
                          onBlur={() => void commitInlineEdit(o)}
                          onKeyDown={onInlineKeyDown}
                          className="w-24 rounded-lg border border-amber-500 bg-white px-2 py-1 text-xs text-[#1D1D1F] tabular-nums outline-none dark:bg-[#0B0C10] dark:text-white"
                        />
                      ) : (
                        <button
                          type="button"
                          title="Нажмите, чтобы скорректировать долг (пересчитает цену)"
                          onClick={() => startInlineEdit(o, 'debt')}
                          className="cursor-pointer rounded px-1 py-0.5 hover:bg-amber-500/10"
                        >
                          {formatRub(o.debt_kopecks)}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {isEdMat ? (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          autoFocus
                          placeholder="Авто"
                          aria-label={`Материалы ${o.order_number}`}
                          value={inlineValue}
                          onChange={(e) => setInlineValue(e.target.value)}
                          onBlur={() => void commitInlineEdit(o)}
                          onKeyDown={onInlineKeyDown}
                          className="w-24 rounded-lg border border-[#0071E3] bg-white px-2 py-1 text-xs tabular-nums outline-none dark:bg-[#0B0C10]"
                        />
                      ) : (
                        <button
                          type="button"
                          title="Нажмите для ручной корректировки себестоимости (пусто — расчёт по складу)"
                          onClick={() => startInlineEdit(o, 'materials')}
                          className="cursor-pointer rounded px-1 py-0.5 text-left hover:bg-black/[0.04] hover:text-[#0071E3] dark:hover:bg-white/[0.06] dark:hover:text-[#2997FF]"
                        >
                          {formatRub(o.effective_material_cost_kopecks)}
                          {o.cost_override_kopecks !== null && (
                            <span className="ml-1 text-[10px] text-[#0071E3]">(ручн.)</span>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
                        <button
                          type="button"
                          onClick={() => openPaymentForOrder(o.id, o.paid_kopecks)}
                          className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                        >
                          Оплата
                        </button>
                        <button
                          type="button"
                          onClick={() => openPriceEditor(o)}
                          className="text-xs font-medium text-[#0071E3] hover:underline dark:text-[#2997FF]"
                        >
                          Цена
                        </button>
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
                          Себест.
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
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
                <input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
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

      {/* Order Price Modal */}
      {modal === 'price' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handlePriceSubmit}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Сумма заказа</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-3 text-xs text-zinc-500">
              Сумма участвует в расчёте объёма заказов, долга и прибыли. Изменение попадёт в аудит.
            </p>
            <input
              type="number"
              min="0"
              step="0.01"
              autoFocus
              value={priceRub}
              onChange={(e) => setPriceRub(e.target.value)}
              placeholder="Сумма заказа, ₽"
              className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
            />
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Сохранить сумму
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
