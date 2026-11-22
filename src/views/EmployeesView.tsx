import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserMinus,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { apiRequest, formatDateTimeRu, formatRub } from '../lib/api';
import type { AuthUser, PermissionKey } from '../types/crm';

interface SalaryAccrualRecord {
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
}

interface SalaryPayoutRecord {
  id: string;
  user_id: string;
  amount_kopecks: number;
  paid_at: string;
  comment: string;
  created_at: string;
}

interface SalaryEmployeeSummary {
  activity: Array<{ month: string; visits: number; shifts: number }>;
  accruals: SalaryAccrualRecord[];
  payouts: SalaryPayoutRecord[];
  id: string;
  full_name: string;
  login: string;
  role: string;
  position: string;
  shift_rate_kopecks: number;
  is_active: number;
  visitAccruedKopecks: number;
  shiftAccruedKopecks: number;
  manualAccruedKopecks: number;
  totalAccruedKopecks: number;
  totalPaidKopecks: number;
  remainingKopecks: number;
  overpaidKopecks: number;
  lastOperationAt: string | null;
}

interface LedgerEntry {
  id: string;
  kind: 'accrual' | 'payout';
  source: 'visit' | 'shift' | 'manual' | 'payout';
  amount_kopecks: number;
  description: string;
  occurred_at: string;
  order_id: string | null;
  order_number: string | null;
  visit_title: string | null;
}

interface MonthlyRow {
  month: string;
  accruedKopecks: number;
  paidKopecks: number;
  deltaKopecks: number;
  employees: Array<{
    userId: string;
    fullName: string;
    visitKopecks: number;
    shiftKopecks: number;
    manualKopecks: number;
    paidKopecks: number;
  }>;
}

interface VisitAssignmentRow {
  assignee_id: string;
  visit_id: string;
  user_id: string;
  wage_kopecks: number | null;
  employee_name: string;
  visit_title: string;
  scheduled_at: string;
  visit_status: string;
  order_id: string;
  order_number: string;
  order_title: string;
}

export type EmployeesTab = 'active' | 'dismissed' | 'salaries';

interface EmployeesViewProps {
  onOpenOrderById: (orderId: string) => void;
  currentUserId: string;
  onCurrentUserUpdated: (user: AuthUser) => void;
  initialTab?: EmployeesTab;
}

export function EmployeesView({
  onOpenOrderById,
  currentUserId,
  onCurrentUserUpdated,
  initialTab = 'active',
}: EmployeesViewProps) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [permissionLabels, setPermissionLabels] = useState<Record<PermissionKey, string>>(
    {} as Record<PermissionKey, string>
  );
  const [salaries, setSalaries] = useState<SalaryEmployeeSummary[]>([]);
  const [visitAssignments, setVisitAssignments] = useState<VisitAssignmentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<EmployeesTab>(initialTab);
  const [search, setSearch] = useState('');
  const [confirmEmploymentUserId, setConfirmEmploymentUserId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [employmentNotice, setEmploymentNotice] = useState('');

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  // Modals
  const [modal, setModal] = useState<'create' | 'edit' | 'payout' | 'adjust' | null>(null);
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null);
  const [revealedPassword, setRevealedPassword] = useState<{
    login: string;
    password: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Create/Edit form
  const [fLogin, setFLogin] = useState('');
  const [fName, setFName] = useState('');
  const [fPhone, setFPhone] = useState('');
  const [fPos, setFPos] = useState('Монтажник');
  const [fRole, setFRole] = useState<'admin' | 'employee'>('employee');
  const [fRateRub, setFRateRub] = useState('3000');
  const [fPerms, setFPerms] = useState<Record<string, boolean>>({});
  const [fChatHistory, setFChatHistory] = useState(false);
  const [fAccountingAccess, setFAccountingAccess] = useState(true);

  // Payout & Adjustment forms
  const [targetUserId, setTargetUserId] = useState('');
  const [amountRub, setAmountRub] = useState('');
  const [comment, setComment] = useState('');

  // Inline visit wage inputs
  const [wageDrafts, setWageDrafts] = useState<Record<string, string>>({});

  // Payout form: payment date (payment method is no longer part of accounting)
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));

  // Per-employee ledger and monthly breakdown
  const [ledgerUser, setLedgerUser] = useState<AuthUser | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerMonthFilter, setLedgerMonthFilter] = useState('');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<'all' | 'visit' | 'shift' | 'bonus' | 'deduction' | 'payout'>('all');
  const [months, setMonths] = useState<MonthlyRow[]>([]);
  const [salaryMonthFilter, setSalaryMonthFilter] = useState('');
  const [salaryUserFilter, setSalaryUserFilter] = useState('');
  const [salaryOpFilter, setSalaryOpFilter] = useState<'all' | 'visit' | 'shift' | 'bonus' | 'deduction' | 'payout'>('all');

  const openLedger = async (user: AuthUser) => {
    setLedgerUser(user);
    setLedger([]);
    setLedgerMonthFilter('');
    setLedgerTypeFilter('all');
    setLedgerBusy(true);
    try {
      const result = await apiRequest<{ entries: LedgerEntry[] }>(
        `/api/salaries/ledger?userId=${encodeURIComponent(user.id)}&limit=200`,
        { useCache: false }
      );
      setLedger(result.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить операции');
    } finally {
      setLedgerBusy(false);
    }
  };

  const loadMonthly = async () => {
    try {
      const result = await apiRequest<{ months: MonthlyRow[] }>('/api/salaries/monthly', {
        useCache: false,
      });
      setMonths(result.months);
    } catch {
      // Monthly breakdown is a nice-to-have; do not block the page on failure.
    }
  };

  const loadAll = async () => {
    try {
      setError('');
      const [uRes, sRes] = await Promise.all([
        apiRequest<{ users: AuthUser[]; permissionLabels: Record<PermissionKey, string> }>('/api/users'),
        apiRequest<{
          employees: SalaryEmployeeSummary[];
          visitAssignments: VisitAssignmentRow[];
        }>('/api/salaries/summary'),
      ]);
      setUsers(uRes.users);
      setPermissionLabels(uRes.permissionLabels);
      setSalaries(sRes.employees);
      setVisitAssignments(sRes.visitAssignments);
      void loadMonthly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки списка сотрудников');
    }
  };

  useEffect(() => {
    void loadAll();
    void loadMonthly();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setFAccountingAccess(true);
    setFLogin('');
    setFName('');
    setFPhone('');
    setFPos('Монтажник');
    setFRole('employee');
    setFRateRub('3000');
    setFPerms({ 'orders.edit_assigned': true, 'warehouse.take': true });
    setFChatHistory(false);
    setError('');
    setModal('create');
  };

  const openEdit = (u: AuthUser) => {
    setFAccountingAccess(u.role === 'admin' ? u.documentsAccess : true);
    setEditingUser(u);
    setFLogin(u.login);
    setFName(u.fullName);
    setFPhone(u.phone);
    setFPos(u.position);
    setFRole(u.role);
    setFRateRub(String(Math.round(u.shiftRateKopecks / 100)));
    setFPerms({ ...u.permissions });
    setError('');
    setModal('edit');
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await apiRequest<{ user: AuthUser; temporaryPassword: string }>('/api/users', {
        method: 'POST',
        skipOfflineQueue: true,
        body: {
          login: fLogin,
          fullName: fName,
          phone: fPhone,
          position: fPos,
          role: fRole,
          shiftRateKopecks: Math.round(Number(fRateRub || 0) * 100),
          permissions: fPerms,
          ...(fRole === 'admin' ? { documentsAccess: fAccountingAccess } : {}),
          chatHistory: fChatHistory,
        },
      });
      setModal(null);
      setRevealedPassword({ login: res.user.login, password: res.temporaryPassword });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания сотрудника');
    } finally {
      setBusy(false);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<{user:AuthUser}>(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        body: {
          login: fLogin,
          fullName: fName,
          phone: fPhone,
          position: fPos,
          role: fRole,
          shiftRateKopecks: Math.round(Number(fRateRub || 0) * 100),
          permissions: fPerms,
          ...(fRole === 'admin' ? { documentsAccess: fAccountingAccess } : {}),
        },
      });
      if (result.user.id === currentUserId) onCurrentUserUpdated(result.user);
      setModal(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleBlock = async (u: AuthUser) => {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: { isActive: !u.isActive },
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка изменения статуса');
    } finally {
      setBusy(false);
    }
  };

  const handleEmployment = async (u: AuthUser) => {
    const restoring = Boolean(u.dismissedAt);
    setBusy(true);
    setError('');
    setEmploymentNotice('');
    try {
      const result = await apiRequest<{ activeShift?: boolean }>(
        `/api/users/${u.id}/${restoring ? 'restore' : 'dismiss'}`,
        { method: 'POST', body: {}, skipOfflineQueue: true }
      );
      setConfirmEmploymentUserId(null);
      await loadAll();
      if (result.activeShift) {
        setEmploymentNotice(
          `У ${u.fullName} осталась незавершённая смена. Она не закрыта автоматически и требует отдельной сверки.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка изменения статуса сотрудника');
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async (u: AuthUser) => {
    setBusy(true);
    setError('');
    try {
      const res = await apiRequest<{ temporaryPassword: string; user: AuthUser }>(
        `/api/users/${u.id}/reset-password`,
        { method: 'POST', skipOfflineQueue: true, body: {} }
      );
      setRevealedPassword({ login: res.user.login, password: res.temporaryPassword });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сброса пароля');
    } finally {
      setBusy(false);
    }
  };

  const handlePayoutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiRequest('/api/salaries/payouts', {
        method: 'POST',
        body: {
          userId: targetUserId,
          amountKopecks: Math.round(Number(amountRub) * 100),
          paidAt: payDate,
          comment,
        },
      });
      setModal(null);
      setAmountRub('');
      setComment('');
      setPayDate(new Date().toISOString().slice(0, 10));
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка проведения выплаты');
    } finally {
      setBusy(false);
    }
  };

  const handleAdjustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiRequest('/api/salaries/adjustments', {
        method: 'POST',
        body: {
          userId: targetUserId,
          amountKopecks: Math.round(Number(amountRub) * 100),
          description: comment,
        },
      });
      setModal(null);
      setAmountRub('');
      setComment('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения корректировки');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignVisitWage = async (visitId: string, userId: string, key: string) => {
    const val = Number(wageDrafts[key]);
    if (Number.isNaN(val) || val < 0) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest('/api/salaries/visit-wage', {
        method: 'POST',
        body: { visitId, userId, amountKopecks: Math.round(val * 100) },
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка назначения оплаты');
    } finally {
      setBusy(false);
    }
  };

  const pendingVisits = visitAssignments.filter((v) => v.wage_kopecks === null);
  const activeUsers = useMemo(() => users.filter((u) => !u.dismissedAt), [users]);
  const dismissedUsers = useMemo(() => users.filter((u) => Boolean(u.dismissedAt)), [users]);

  const filteredUsers = useMemo(() => {
    const source = tab === 'dismissed' ? dismissedUsers : activeUsers;
    const q = search.trim().toLowerCase();
    if (!q) return source;
    return source.filter((u) =>
      `${u.fullName} ${u.login} ${u.position || ''} ${u.phone || ''}`.toLowerCase().includes(q)
    );
  }, [tab, activeUsers, dismissedUsers, search]);

  const filteredSalaries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return salaries.filter((s) => {
      if (salaryUserFilter && s.id !== salaryUserFilter) return false;
      if (!q) return true;
      return `${s.full_name} ${s.login} ${s.position || ''}`.toLowerCase().includes(q);
    });
  }, [salaries, salaryUserFilter, search]);

  const salaryMonthsList = useMemo(() => {
    const set = new Set<string>();
    for (const m of months) set.add(m.month);
    for (const s of salaries) {
      for (const a of s.accruals || []) set.add(a.created_at.slice(0, 7));
      for (const p of s.payouts || []) set.add(p.paid_at.slice(0, 7));
    }
    return [...set].filter(Boolean).sort((a, b) => b.localeCompare(a));
  }, [months, salaries]);

  const filteredMonthlyRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return months
      .filter((m) => !salaryMonthFilter || m.month === salaryMonthFilter)
      .map((m) => {
        const emps = m.employees.filter((e) => {
          if (salaryUserFilter && e.userId !== salaryUserFilter) return false;
          if (q && !e.fullName.toLowerCase().includes(q)) return false;
          return true;
        });
        return { ...m, employees: emps };
      })
      .filter((m) => m.employees.length > 0);
  }, [months, salaryMonthFilter, salaryUserFilter, search]);

  const combinedSalaryLedger = useMemo(() => {
    type CombinedRow = {
      id: string;
      userId: string;
      userName: string;
      occurredAt: string;
      month: string;
      category: 'visit' | 'shift' | 'bonus' | 'deduction' | 'payout';
      description: string;
      orderId: string | null;
      orderNumber: string | null;
      amountKopecks: number;
    };
    const rows: CombinedRow[] = [];
    for (const s of salaries) {
      for (const a of s.accruals || []) {
        const category =
          a.source_type === 'visit'
            ? 'visit'
            : a.source_type === 'shift'
              ? 'shift'
              : a.amount_kopecks < 0
                ? 'deduction'
                : 'bonus';
        rows.push({
          id: `acc:${a.id}`,
          userId: s.id,
          userName: s.full_name,
          occurredAt: a.created_at,
          month: a.created_at.slice(0, 7),
          category,
          description: a.description || (category === 'deduction' ? 'Удержание' : 'Начисление'),
          orderId: a.order_id,
          orderNumber: a.order_number,
          amountKopecks: a.amount_kopecks,
        });
      }
      for (const p of s.payouts || []) {
        rows.push({
          id: `pay:${p.id}`,
          userId: s.id,
          userName: s.full_name,
          occurredAt: p.paid_at,
          month: p.paid_at.slice(0, 7),
          category: 'payout',
          description: p.comment || 'Выплата зарплаты',
          orderId: null,
          orderNumber: null,
          amountKopecks: p.amount_kopecks,
        });
      }
    }
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (salaryMonthFilter && r.month !== salaryMonthFilter) return false;
        if (salaryUserFilter && r.userId !== salaryUserFilter) return false;
        if (salaryOpFilter !== 'all' && r.category !== salaryOpFilter) return false;
        if (q && !`${r.userName} ${r.description} ${r.orderNumber || ''}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [salaries, salaryMonthFilter, salaryUserFilter, salaryOpFilter, search]);

  return (
    <div className="space-y-5">
      <SectionHeader<EmployeesTab>
        title="Сотрудники"
        description="Учётные записи, права доступа, ставки смен, начисления и статистика"
        actions={
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#0077ED] dark:bg-[#2997FF] dark:text-[#0B0C10]"
          >
            <Plus className="h-4 w-4" />
            <span>Добавить сотрудника</span>
          </button>
        }
        tabs={[
          { id: 'active', label: 'Сотрудники', count: activeUsers.length, icon: Users },
          { id: 'dismissed', label: 'Уволенные', count: dismissedUsers.length, icon: UserMinus },
          {
            id: 'salaries',
            label: 'Зарплаты',
            count: pendingVisits.length > 0 ? pendingVisits.length : undefined,
            icon: Wallet,
          },
        ]}
        activeTab={tab}
        onSelectTab={setTab}
        filters={
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск сотрудника по ФИО, логину или должности..."
              className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-2 pl-8 pr-3 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10] dark:focus:bg-[#0B0C10]"
            />
          </div>
        }
      />

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {employmentNotice && (
        <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          {employmentNotice}
        </div>
      )}

      {/* Tab 3: Salaries */}
      {tab === 'salaries' && (
        <div className="space-y-4">
          {pendingVisits.length > 0 && (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
              <div className="mb-2.5 text-xs font-bold text-amber-800 dark:text-amber-300">
                Выезды, ожидающие назначения оплаты ({pendingVisits.length})
              </div>
              <div className="space-y-2">
                {pendingVisits.map((v) => {
                  const key = `${v.visit_id}:${v.user_id}`;
                  return (
                    <div
                      key={v.assignee_id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-3 text-xs shadow-2xs dark:bg-[#15171C]"
                    >
                      <div>
                        <button
                          type="button"
                          onClick={() => onOpenOrderById(v.order_id)}
                          className="font-semibold hover:text-[#0071E3]"
                        >
                          {v.order_number} · {v.visit_title}
                        </button>
                        <div className="text-zinc-500">
                          {v.employee_name} · {formatDateTimeRu(v.scheduled_at)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          placeholder="Сумма ₽"
                          value={wageDrafts[key] ?? ''}
                          onChange={(e) =>
                            setWageDrafts((p) => ({ ...p, [key]: e.target.value }))
                          }
                          className="w-24 rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAssignVisitWage(v.visit_id, v.user_id, key)}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
                        >
                          Начислить
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Salary Filters: Month, Employee, Operation Type */}
          <div className="space-y-2.5 rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
            {(() => {
              const now = new Date();
              const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
              const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
              const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
              return (
                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { id: '', label: 'Все месяцы' },
                    { id: thisMonth, label: 'Этот месяц' },
                    { id: prevMonth, label: 'Прошлый месяц' },
                  ].map((chip) => {
                    const active = salaryMonthFilter === chip.id;
                    return (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() => setSalaryMonthFilter(chip.id)}
                        className={`min-h-[30px] rounded-xl px-2.5 py-1 text-[11px] font-semibold transition ${
                          active
                            ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                            : 'bg-[#F5F5F7] text-zinc-600 hover:bg-black/[0.06] dark:bg-[#0B0C10] dark:text-zinc-300 dark:hover:bg-white/[0.08]'
                        }`}
                      >
                        {chip.label}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select
                aria-label="Фильтр по месяцу"
                value={salaryMonthFilter}
                onChange={(e) => setSalaryMonthFilter(e.target.value)}
                className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              >
                <option value="">Все месяцы</option>
                {salaryMonthsList.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select
                aria-label="Фильтр по сотруднику"
                value={salaryUserFilter}
                onChange={(e) => setSalaryUserFilter(e.target.value)}
                className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              >
                <option value="">Все сотрудники</option>
                {salaries.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Тип операции"
                value={salaryOpFilter}
                onChange={(e) => setSalaryOpFilter(e.target.value as any)}
                className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              >
                <option value="all">Все операции</option>
                <option value="visit">Выезды и монтажи</option>
                <option value="shift">Смены в цеху</option>
                <option value="bonus">Премии</option>
                <option value="deduction">Удержания / списания</option>
                <option value="payout">Выплаты</option>
              </select>
            </div>
          </div>

          {filteredSalaries.length > 0 && (
            <div className="overflow-x-auto rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
              <h3 className="mb-3 font-display text-base font-bold">Сводка по сотрудникам</h3>
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead>
                  <tr className="border-b border-black/[0.06] text-zinc-400 dark:border-white/[0.08]">
                    <th className="py-2 pr-3 font-semibold">Сотрудник</th>
                    <th className="px-3 py-2 font-semibold">Выезды</th>
                    <th className="px-3 py-2 font-semibold">Смены</th>
                    <th className="px-3 py-2 font-semibold">Премии / удержания</th>
                    <th className="px-3 py-2 font-semibold">Начислено</th>
                    <th className="px-3 py-2 font-semibold">Выплачено</th>
                    <th className="px-3 py-2 font-semibold">Долг</th>
                    <th className="px-3 py-2 text-right font-semibold">История</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSalaries.map((s) => {
                    const user = users.find((u) => u.id === s.id);
                    const dismissed = Boolean(user?.dismissedAt);
                    return (
                      <tr
                        key={s.id}
                        className={`border-b border-black/[0.04] last:border-0 dark:border-white/[0.05] ${dismissed ? 'opacity-50' : ''}`}
                      >
                        <td className="py-2.5 pr-3 font-semibold">
                          {s.full_name}
                          {dismissed && <span className="ml-1 text-[10px] font-normal text-zinc-400">· уволен</span>}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">{formatRub(s.visitAccruedKopecks)}</td>
                        <td className="px-3 py-2.5 tabular-nums">{formatRub(s.shiftAccruedKopecks)}</td>
                        <td className="px-3 py-2.5 tabular-nums">{formatRub(s.manualAccruedKopecks)}</td>
                        <td className="px-3 py-2.5 font-semibold tabular-nums">{formatRub(s.totalAccruedKopecks)}</td>
                        <td className="px-3 py-2.5 text-emerald-600 tabular-nums dark:text-emerald-400">
                          {formatRub(s.totalPaidKopecks)}
                        </td>
                        <td
                          className={`px-3 py-2.5 font-bold tabular-nums ${
                            s.remainingKopecks >= 0
                              ? 'text-[#0071E3] dark:text-[#2997FF]'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {formatRub(Math.abs(s.remainingKopecks))}
                          <span className="ml-1 text-[10px] font-normal text-zinc-400">
                            {s.remainingKopecks >= 0 ? 'к выплате' : 'переплата'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setTargetUserId(s.id);
                                setAmountRub('');
                                setComment('');
                                setPayDate(new Date().toISOString().slice(0, 10));
                                setModal('payout');
                              }}
                              className="text-emerald-600 hover:underline dark:text-emerald-400"
                            >
                              Выплатить
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setTargetUserId(s.id);
                                setAmountRub('');
                                setComment('');
                                setModal('adjust');
                              }}
                              className="text-amber-600 hover:underline dark:text-amber-400"
                            >
                              Премия/штраф
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (user) void openLedger(user);
                              }}
                              className="text-[#0071E3] hover:underline dark:text-[#2997FF]"
                            >
                              Операции
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

          {filteredMonthlyRows.length > 0 && (
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
              <h3 className="mb-3 font-display text-base font-bold">Сводка по месяцам и сотрудникам</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-black/[0.06] text-zinc-400 dark:border-white/[0.08]">
                      <th className="py-2 pr-3 font-semibold">Месяц</th>
                      <th className="px-3 py-2 font-semibold">Сотрудник</th>
                      <th className="px-3 py-2 font-semibold">Выезды</th>
                      <th className="px-3 py-2 font-semibold">Смены</th>
                      <th className="px-3 py-2 font-semibold">Премии / удерж.</th>
                      <th className="px-3 py-2 font-semibold">Начислено</th>
                      <th className="px-3 py-2 font-semibold">Выплачено</th>
                      <th className="px-3 py-2 font-semibold">Разница за месяц</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMonthlyRows.map((month) => (
                      <React.Fragment key={month.month}>
                        <tr className="border-b border-black/[0.05] bg-[#F5F5F7]/70 font-semibold dark:border-white/[0.06] dark:bg-[#0B0C10]">
                          <td className="py-2 pr-3 tabular-nums">{month.month}</td>
                          <td className="px-3 py-2 text-zinc-500">Итого по месяцу ({month.employees.length} сотр.)</td>
                          <td className="px-3 py-2 tabular-nums">
                            {formatRub(month.employees.reduce((sum, e) => sum + e.visitKopecks, 0))}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {formatRub(month.employees.reduce((sum, e) => sum + e.shiftKopecks, 0))}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {formatRub(month.employees.reduce((sum, e) => sum + e.manualKopecks, 0))}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatRub(month.accruedKopecks)}</td>
                          <td className="px-3 py-2 text-emerald-600 tabular-nums dark:text-emerald-400">
                            {formatRub(month.paidKopecks)}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatRub(month.deltaKopecks)}</td>
                        </tr>
                        {month.employees.map((emp) => {
                          const empAccrued = emp.visitKopecks + emp.shiftKopecks + emp.manualKopecks;
                          const empDelta = empAccrued - emp.paidKopecks;
                          return (
                            <tr
                              key={`${month.month}:${emp.userId}`}
                              className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]"
                            >
                              <td className="py-2 pr-3 text-zinc-400 tabular-nums">{month.month}</td>
                              <td className="px-3 py-2 font-medium">{emp.fullName}</td>
                              <td className="px-3 py-2 tabular-nums">{formatRub(emp.visitKopecks)}</td>
                              <td className="px-3 py-2 tabular-nums">{formatRub(emp.shiftKopecks)}</td>
                              <td className="px-3 py-2 tabular-nums">{formatRub(emp.manualKopecks)}</td>
                              <td className="px-3 py-2 font-semibold tabular-nums">{formatRub(empAccrued)}</td>
                              <td className="px-3 py-2 text-emerald-600 tabular-nums dark:text-emerald-400">
                                {formatRub(emp.paidKopecks)}
                              </td>
                              <td className="px-3 py-2 font-semibold tabular-nums">{formatRub(empDelta)}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Cross-employee Detailed Ledger: what was accrued, deducted, and paid */}
          <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-base font-bold">
                Детальная таблица начислений, удержаний и выплат ({combinedSalaryLedger.length})
              </h3>
              {(salaryMonthFilter || salaryUserFilter || salaryOpFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSalaryMonthFilter('');
                    setSalaryUserFilter('');
                    setSalaryOpFilter('all');
                  }}
                  className="text-xs font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                >
                  Сбросить фильтры
                </button>
              )}
            </div>
            {combinedSalaryLedger.length === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-400">
                Операций по выбранным фильтрам пока нет
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[780px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-black/[0.06] text-zinc-400 dark:border-white/[0.08]">
                      <th className="py-2 pr-3 font-semibold">Дата</th>
                      <th className="px-3 py-2 font-semibold">Сотрудник</th>
                      <th className="px-3 py-2 font-semibold">Тип</th>
                      <th className="px-3 py-2 font-semibold">За что / комментарий</th>
                      <th className="px-3 py-2 text-right font-semibold">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combinedSalaryLedger.map((row) => {
                      const badge =
                        row.category === 'visit'
                          ? { label: 'Выезд', cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' }
                          : row.category === 'shift'
                            ? { label: 'Смена', cls: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' }
                            : row.category === 'bonus'
                              ? { label: 'Премия', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' }
                              : row.category === 'deduction'
                                ? { label: 'Удержание', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' }
                                : { label: 'Выплата', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
                      return (
                        <tr
                          key={row.id}
                          className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]"
                        >
                          <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">
                            {formatDateTimeRu(row.occurredAt)}
                          </td>
                          <td className="px-3 py-2.5 font-semibold">{row.userName}</td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
                              {badge.label}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            {row.description}
                            {row.orderNumber && row.orderId && (
                              <button
                                type="button"
                                onClick={() => onOpenOrderById(row.orderId!)}
                                className="ml-1.5 font-mono font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                              >
                                {row.orderNumber}
                              </button>
                            )}
                          </td>
                          <td
                            className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums ${
                              row.category === 'payout'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : row.category === 'deduction'
                                  ? 'text-red-600 dark:text-red-400'
                                  : ''
                            }`}
                          >
                            {row.category === 'payout' || row.category === 'deduction' ? '−' : '+'}
                            {formatRub(Math.abs(row.amountKopecks))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs 1 & 2: Active & Dismissed Employees */}
      {(tab === 'active' || tab === 'dismissed') && (
        filteredUsers.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
            {tab === 'dismissed' ? 'Уволенных сотрудников нет' : 'Сотрудники не найдены'}
          </div>
        ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filteredUsers.map((u) => {
            const sal = salaries.find((s) => s.id === u.id);
            const restoring = Boolean(u.dismissedAt);
            return (
              <div
                key={u.id}
                className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-display text-base font-bold">{u.fullName}</h3>
                      {!u.isActive && (
                        <span className="text-xs font-semibold text-red-600 dark:text-red-400">
                          · {u.dismissedAt ? 'Уволен' : 'Заблокирован'}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      @{u.login} · {u.role === 'admin' ? 'Администратор' : u.position || 'Сотрудник'} ·
                      Ставка смены {formatRub(u.shiftRateKopecks)}
                    </div>
                  </div>
                </div>

                {sal && (
                  <div className="mt-4 rounded-xl bg-[#F5F5F7] p-3.5 dark:bg-[#0B0C10]">
                    {sal.activity.length > 0 && (
                      <details className="mb-3 text-xs">
                        <summary className="cursor-pointer font-semibold">Монтажи и смены по месяцам</summary>
                        {sal.activity.map((item) => (
                          <div key={item.month} className="mt-1 flex justify-between gap-2">
                            <span>{item.month}</span>
                            <span>Монтажей: {item.visits} · Смен: {item.shifts}</span>
                          </div>
                        ))}
                      </details>
                    )}
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <div className="text-xs text-zinc-400">Общий долг</div>
                        <div
                          className={`mt-0.5 text-2xl font-bold tabular-nums ${
                            sal.remainingKopecks >= 0
                              ? 'text-[#0071E3] dark:text-[#2997FF]'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {formatRub(Math.abs(sal.remainingKopecks))}
                        </div>
                        <div className="text-[11px] text-zinc-500">
                          {sal.remainingKopecks >= 0 ? 'К выплате сотруднику' : 'Переплата сотруднику'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void openLedger(u)}
                        className="rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold dark:border-white/[0.1]"
                      >
                        Все операции
                      </button>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      <div>
                        <div className="text-zinc-400">Выезды</div>
                        <div className="font-semibold tabular-nums">{formatRub(sal.visitAccruedKopecks)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-400">Смены</div>
                        <div className="font-semibold tabular-nums">{formatRub(sal.shiftAccruedKopecks)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-400">Премии / удержания</div>
                        <div className="font-semibold tabular-nums">{formatRub(sal.manualAccruedKopecks)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-400">Выплачено</div>
                        <div className="font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
                          {formatRub(sal.totalPaidKopecks)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  {!u.dismissedAt && (
                    <button
                      type="button"
                      onClick={() => openEdit(u)}
                      className="inline-flex items-center gap-1 rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      <span>Права и ставка</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setTargetUserId(u.id);
                      setAmountRub('');
                      setComment('');
                      setPayDate(new Date().toISOString().slice(0, 10));
                      setModal('payout');
                    }}
                    className="inline-flex items-center gap-1 rounded-xl bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
                  >
                    <Wallet className="h-3.5 w-3.5" />
                    <span>Выплатить</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTargetUserId(u.id);
                      setAmountRub('');
                      setComment('');
                      setModal('adjust');
                    }}
                    className="rounded-xl bg-black/[0.04] px-3 py-1.5 text-xs font-semibold text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300"
                  >
                    Премия/штраф
                  </button>
                  {!u.dismissedAt && (
                    <button
                      type="button"
                      onClick={() => void handleResetPassword(u)}
                      className="inline-flex items-center gap-1 rounded-xl bg-black/[0.04] px-3 py-1.5 text-xs font-semibold text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      <span>Сброс пароля</span>
                    </button>
                  )}
                  {!u.dismissedAt && (
                    <button
                      type="button"
                      onClick={() => void handleToggleBlock(u)}
                      className={`inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold ${
                        u.isActive
                          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                          : 'bg-emerald-500/10 text-emerald-600'
                      }`}
                    >
                      {u.isActive ? (
                        <>
                          <ShieldAlert className="h-3.5 w-3.5" />
                          <span>Блокировать</span>
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-3.5 w-3.5" />
                          <span>Разблокировать</span>
                        </>
                      )}
                    </button>
                  )}
                  {confirmEmploymentUserId !== u.id ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmEmploymentUserId(u.id)}
                      className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                        restoring
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'bg-red-500/10 text-red-600 dark:text-red-400'
                      }`}
                    >
                      {restoring ? 'Восстановить' : 'Уволить'}
                    </button>
                  ) : (
                    <div className="flex w-full items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                      <span className="text-amber-900 dark:text-amber-200">
                        {restoring
                          ? `Восстановить ${u.fullName}?`
                          : `Переместить ${u.fullName} в уволенные? Доступ закроется, история сохранится.`}
                      </span>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleEmployment(u)}
                          className={`rounded-lg px-2.5 py-1 font-semibold text-white ${
                            restoring ? 'bg-emerald-600' : 'bg-red-600'
                          }`}
                        >
                          Подтвердить
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmEmploymentUserId(null)}
                          className="rounded-lg border border-black/[0.1] px-2.5 py-1 text-zinc-600 dark:border-white/[0.12] dark:text-zinc-300"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        )
      )}

      {/* Create / Edit Modal with Permission Checkboxes */}
      {(modal === 'create' || modal === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={modal === 'create' ? handleCreate : handleEdit}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {modal === 'create' ? 'Новый сотрудник' : `Редактирование: ${editingUser?.fullName}`}
              </h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}

            <div className="space-y-3">
              {modal === 'create' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={fChatHistory} onChange={e => setFChatHistory(e.target.checked)} className="mt-1 accent-[#0071E3]" /><span>Разрешить видеть переписку до создания учётной записи<br /><span className="text-xs text-zinc-500">Выбор нельзя изменить после создания.</span></span></label>}
              <input
                type="text"
                required
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="ФИО *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="text"
                  required
                  value={fLogin}
                  onChange={(e) => setFLogin(e.target.value)}
                  placeholder="Логин *"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
                <input
                  type="tel"
                  value={fPhone}
                  onChange={(e) => setFPhone(e.target.value)}
                  placeholder="Телефон"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <select
                  aria-label="Роль сотрудника"
                  value={fRole}
                  onChange={(e) => setFRole(e.target.value as any)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="employee">Сотрудник</option>
                  <option value="admin">Админ</option>
                </select>
                <input
                  type="text"
                  value={fPos}
                  onChange={(e) => setFPos(e.target.value)}
                  placeholder="Должность"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
                <input
                  type="number"
                  min="0"
                  value={fRateRub}
                  onChange={(e) => setFRateRub(e.target.value)}
                  placeholder="Ставка ₽"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>

              {fRole === 'admin' && modal === 'edit' && (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fAccountingAccess} onChange={(e) => setFAccountingAccess(e.target.checked)} /> Доступ к бухгалтерии</label>
              )}
              {fRole === 'employee' && (
                <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7]/70 p-3.5 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                  <div className="mb-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Индивидуальные разрешения сотрудника
                  </div>
                  <div className="space-y-2">
                    {(Object.entries(permissionLabels) as Array<[PermissionKey, string]>).map(
                      ([key, label]) => (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-2.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(fPerms[key])}
                            onChange={(e) =>
                              setFPerms((p) => ({ ...p, [key]: e.target.checked }))
                            }
                            className="h-4 w-4 accent-[#0071E3]"
                          />
                          <span>{label}</span>
                        </label>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {modal === 'create' ? 'Создать и сгенерировать пароль' : 'Сохранить'}
            </button>
          </form>
        </div>
      )}

      {/* Payout or Adjustment Modal */}
      {(modal === 'payout' || modal === 'adjust') && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={modal === 'payout' ? handlePayoutSubmit : handleAdjustSubmit}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {modal === 'payout' ? 'Выплата зарплаты' : 'Премия / удержание'}
              </h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              {modal === 'payout' && (
                <div className="rounded-xl bg-[#F5F5F7] p-3 text-xs dark:bg-[#0B0C10]">
                  <div className="text-zinc-400">Текущий долг</div>
                  <div className="font-bold text-[#0071E3] dark:text-[#2997FF]">
                    {formatRub(Math.max(0, salaries.find((s) => s.id === targetUserId)?.remainingKopecks || 0))}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setAmountRub(
                        String(
                          Math.round(
                            Math.max(0, salaries.find((s) => s.id === targetUserId)?.remainingKopecks || 0) / 100
                          )
                        )
                      )
                    }
                    className="mt-1 text-[#0071E3] underline dark:text-[#2997FF]"
                  >
                    Выплатить весь долг
                  </button>
                </div>
              )}
              <input
                type="number"
                required
                value={amountRub}
                onChange={(e) => setAmountRub(e.target.value)}
                placeholder={
                  modal === 'payout'
                    ? 'Сумма выплаты, ₽'
                    : 'Сумма (+ премия, - удержание), ₽'
                }
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              {modal === 'payout' && (
                <input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  aria-label="Дата выплаты"
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              )}
              <input
                type="text"
                required={modal === 'adjust'}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Комментарий"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Сохранить
            </button>
          </form>
        </div>
      )}

      {/* Ledger Modal: normalized operation history for a single employee */}
      {ledgerUser && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-white p-5 dark:bg-[#15171C] sm:rounded-3xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-display text-lg font-bold">Операции: {ledgerUser.fullName}</h3>
              <button type="button" onClick={() => setLedgerUser(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {!ledgerBusy && ledger.length > 0 && (
              <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <select
                  aria-label="Месяц операций сотрудника"
                  value={ledgerMonthFilter}
                  onChange={(e) => setLedgerMonthFilter(e.target.value)}
                  className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  <option value="">Все месяцы</option>
                  {[...new Set(ledger.map((e) => e.occurred_at.slice(0, 7)).filter(Boolean))]
                    .sort((a, b) => b.localeCompare(a))
                    .map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Тип операций сотрудника"
                  value={ledgerTypeFilter}
                  onChange={(e) => setLedgerTypeFilter(e.target.value as any)}
                  className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  <option value="all">Все типы</option>
                  <option value="visit">Выезды</option>
                  <option value="shift">Смены</option>
                  <option value="bonus">Премии</option>
                  <option value="deduction">Удержания</option>
                  <option value="payout">Выплаты</option>
                </select>
              </div>
            )}
            {ledgerBusy ? (
              <p className="text-sm text-zinc-500">Загрузка…</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[540px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-black/[0.06] text-zinc-400 dark:border-white/[0.08]">
                      <th className="py-2 pr-3">Дата</th>
                      <th className="px-3 py-2">Тип</th>
                      <th className="px-3 py-2">Описание</th>
                      <th className="px-3 py-2 text-right">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger
                      .filter((entry) => {
                        if (ledgerMonthFilter && entry.occurred_at.slice(0, 7) !== ledgerMonthFilter) return false;
                        const cat =
                          entry.kind === 'payout'
                            ? 'payout'
                            : entry.source === 'visit'
                              ? 'visit'
                              : entry.source === 'shift'
                                ? 'shift'
                                : entry.amount_kopecks < 0
                                  ? 'deduction'
                                  : 'bonus';
                        if (ledgerTypeFilter !== 'all' && cat !== ledgerTypeFilter) return false;
                        return true;
                      })
                      .map((entry) => (
                        <tr
                          key={entry.id}
                          className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]"
                        >
                          <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">{formatDateTimeRu(entry.occurred_at)}</td>
                          <td className="px-3 py-2.5">
                            {entry.kind === 'payout'
                              ? 'Выплата'
                              : entry.source === 'visit'
                                ? 'Выезд'
                                : entry.source === 'shift'
                                  ? 'Смена'
                                  : entry.amount_kopecks < 0
                                    ? 'Удержание'
                                    : 'Премия'}
                          </td>
                          <td className="px-3 py-2.5">
                            {entry.description || '—'}
                            {entry.order_number && entry.order_id && (
                              <button
                                type="button"
                                onClick={() => onOpenOrderById(entry.order_id!)}
                                className="ml-1 text-[#0071E3] hover:underline dark:text-[#2997FF]"
                              >
                                {entry.order_number}
                              </button>
                            )}
                          </td>
                          <td
                            className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums ${
                              entry.kind === 'payout'
                                ? 'text-emerald-600'
                                : entry.amount_kopecks < 0
                                  ? 'text-red-600'
                                  : ''
                            }`}
                          >
                            {entry.kind === 'payout' || entry.amount_kopecks < 0 ? '−' : '+'}
                            {formatRub(Math.abs(entry.amount_kopecks))}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            {!ledgerBusy && ledger.length === 0 && (
              <p className="text-sm text-zinc-500">Операций пока нет.</p>
            )}
          </div>
        </div>
      )}

      {/* One-time Temporary Password Reveal Modal */}
      {revealedPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-3xl border border-black/[0.08] bg-white p-6 shadow-2xl dark:border-white/[0.1] dark:bg-[#15171C]">
            <h3 className="font-display text-lg font-bold">Одноразовый пароль</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Передайте данные сотруднику. Повторно пароль не отображается.
            </p>
            <div className="mt-4 space-y-2 rounded-2xl bg-[#F5F5F7] p-4 dark:bg-[#0B0C10]">
              <div className="text-xs text-zinc-500">
                Логин: <span className="font-mono font-bold text-[#1D1D1F] dark:text-white">{revealedPassword.login}</span>
              </div>
              <div className="text-xs text-zinc-500">
                Пароль:{' '}
                <span className="font-mono font-bold text-[#0071E3] dark:text-[#2997FF]">
                  {revealedPassword.password}
                </span>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    `Логин: ${revealedPassword.login}\nВременный пароль: ${revealedPassword.password}`
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-black/[0.1] py-2.5 text-xs font-semibold dark:border-white/[0.1]"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                <span>{copied ? 'Скопировано' : 'Копировать'}</span>
              </button>
              <button
                type="button"
                onClick={() => setRevealedPassword(null)}
                className="flex-1 rounded-xl bg-[#0071E3] py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
