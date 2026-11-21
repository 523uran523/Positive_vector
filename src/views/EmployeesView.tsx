import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Plus,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  X,
} from 'lucide-react';
import { apiRequest, formatDateTimeRu, formatRub } from '../lib/api';
import type { AuthUser, PermissionKey } from '../types/crm';

interface SalaryEmployeeSummary {
  activity: Array<{ month: string; visits: number; shifts: number }>;
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

interface EmployeesViewProps {
  onOpenOrderById: (orderId: string) => void;
  currentUserId: string;
  onCurrentUserUpdated: (user: AuthUser) => void;
}

export function EmployeesView({ onOpenOrderById, currentUserId, onCurrentUserUpdated }: EmployeesViewProps) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [permissionLabels, setPermissionLabels] = useState<Record<PermissionKey, string>>(
    {} as Record<PermissionKey, string>
  );
  const [salaries, setSalaries] = useState<SalaryEmployeeSummary[]>([]);
  const [visitAssignments, setVisitAssignments] = useState<VisitAssignmentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [salaryOnly, setSalaryOnly] = useState(false);
  const [error, setError] = useState('');
  const [employmentNotice, setEmploymentNotice] = useState('');
  const [confirmEmployment, setConfirmEmployment] = useState<{ user: AuthUser; restoring: boolean } | null>(null);

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
  const [months, setMonths] = useState<MonthlyRow[]>([]);

  const openLedger = async (user: AuthUser) => {
    setLedgerUser(user);
    setLedger([]);
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
    if (!confirmEmployment || confirmEmployment.user.id !== u.id) {
      setConfirmEmployment({ user: u, restoring });
      return;
    }
    setConfirmEmployment(null);
    setBusy(true); setError(''); setEmploymentNotice('');
    try {
      const result = await apiRequest<{activeShift?:boolean}>(`/api/users/${u.id}/${restoring ? 'restore' : 'dismiss'}`, { method:'POST',body:{},skipOfflineQueue:true });
      await loadAll();
      if (result.activeShift) setEmploymentNotice(`У ${u.fullName} осталась незавершённая смена. Она не закрыта автоматически и требует отдельной сверки.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка изменения статуса сотрудника'); }
    finally { setBusy(false); }
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

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {employmentNotice && <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">{employmentNotice}</div>}
      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
        <div>
          <h2 className="font-display text-base font-bold">Команда и расчёт зарплат</h2>
          <p className="text-xs text-zinc-500">
            Права доступа, ставки смен в цеху, начисления за выезды и выплаты
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
        >
          <Plus className="h-4 w-4" />
          <span>Добавить сотрудника</span>
        </button>
      </div>

      {/* Pending visit wages queue */}
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

      {/* Cross-employee summary table */}
      {salaries.length > 0 && (
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
              {salaries.map((s) => {
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
                      <button
                        type="button"
                        onClick={() => {
                          if (user) void openLedger(user);
                        }}
                        className="text-[#0071E3] hover:underline dark:text-[#2997FF]"
                      >
                        Операции
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Monthly breakdown */}
      {months.length > 0 && (
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
          <h3 className="mb-3 font-display text-base font-bold">Сводка по месяцам</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-xs">
              <thead>
                <tr className="border-b text-zinc-400">
                  <th className="py-2 pr-3">Месяц</th>
                  <th className="px-3 py-2">Начислено</th>
                  <th className="px-3 py-2">Выплачено</th>
                  <th className="px-3 py-2">Изменение долга</th>
                </tr>
              </thead>
              <tbody>
                {months.map((month) => (
                  <tr
                    key={month.month}
                    className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]"
                  >
                    <td className="py-2.5 pr-3 font-semibold">{month.month}</td>
                    <td className="px-3 py-2.5 tabular-nums">{formatRub(month.accruedKopecks)}</td>
                    <td className="px-3 py-2.5 text-emerald-600 tabular-nums dark:text-emerald-400">
                      {formatRub(month.paidKopecks)}
                    </td>
                    <td className="px-3 py-2.5 font-semibold tabular-nums">
                      {formatRub(month.deltaKopecks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Employees Cards */}
      <div className="flex flex-wrap gap-2" aria-label="Списки сотрудников">
        <button type="button" onClick={() => { setSalaryOnly(false); setShowDismissed(false); }} className={`rounded-xl px-4 py-2 text-sm font-semibold ${!salaryOnly && !showDismissed ? 'bg-[#0071E3] text-white' : 'bg-zinc-200 dark:bg-[#282b32]'}`}>Сотрудники ({users.filter(u => !u.dismissedAt).length})</button>
        <button type="button" onClick={() => { setSalaryOnly(false); setShowDismissed(true); }} className={`rounded-xl px-4 py-2 text-sm font-semibold ${!salaryOnly && showDismissed ? 'bg-[#0071E3] text-white' : 'bg-zinc-200 dark:bg-[#282b32]'}`}>Уволенные ({users.filter(u => u.dismissedAt).length})</button>
        <button type="button" onClick={() => setSalaryOnly(true)} className={`rounded-xl px-4 py-2 text-sm font-semibold ${salaryOnly ? 'bg-[#0071E3] text-white' : 'bg-zinc-200 dark:bg-[#282b32]'}`}>Зарплаты</button>
      </div>
      {!salaryOnly && <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {users.filter(u => Boolean(u.dismissedAt) === showDismissed).map((u) => {
          const sal = salaries.find((s) => s.id === u.id);
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
                  {sal.activity.length > 0 && <details className="mb-3 text-xs"><summary className="cursor-pointer font-semibold">Монтажи и смены по месяцам</summary>{sal.activity.map(item => <div key={item.month} className="mt-1 flex justify-between gap-2"><span>{item.month}</span><span>Монтажей: {item.visits} · Смен: {item.shifts}</span></div>)}</details>}
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
                {!u.dismissedAt && <button
                  type="button"
                  onClick={() => openEdit(u)}
                  className="inline-flex items-center gap-1 rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>Права и ставка</span>
                </button>}
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
                {!u.dismissedAt && <button
                  type="button"
                  onClick={() => void handleResetPassword(u)}
                  className="inline-flex items-center gap-1 rounded-xl bg-black/[0.04] px-3 py-1.5 text-xs font-semibold text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>Сброс пароля</span>
                </button>}
                {!u.dismissedAt && <button
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
                </button>}
                <button type="button" disabled={busy} onClick={() => void handleEmployment(u)} className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${u.dismissedAt ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600 dark:text-red-400'}`}>
                  {confirmEmployment?.user.id === u.id ? 'Нажмите ещё раз' : u.dismissedAt ? 'Восстановить' : 'Уволить'}
                </button>
              </div>
            </div>
          );
        })}
      </div>}

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
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-5 dark:bg-[#15171C] sm:rounded-3xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Операции: {ledgerUser.fullName}</h3>
              <button type="button" onClick={() => setLedgerUser(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {ledgerBusy ? (
              <p className="text-sm text-zinc-500">Загрузка…</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b text-zinc-400">
                    <th className="py-2 pr-3">Дата</th>
                    <th className="px-3 py-2">Тип</th>
                    <th className="px-3 py-2">Описание</th>
                    <th className="px-3 py-2 text-right">Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]"
                    >
                      <td className="py-2.5 pr-3 tabular-nums">{formatDateTimeRu(entry.occurred_at)}</td>
                      <td className="px-3 py-2.5">
                        {entry.kind === 'payout'
                          ? 'Выплата'
                          : entry.source === 'visit'
                            ? 'Выезд'
                            : entry.source === 'shift'
                              ? 'Смена'
                              : 'Корректировка'}
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
                        className={`px-3 py-2.5 text-right font-semibold tabular-nums ${
                          entry.kind === 'payout'
                            ? 'text-emerald-600'
                            : entry.amount_kopecks < 0
                              ? 'text-red-600'
                              : ''
                        }`}
                      >
                        {entry.kind === 'payout' ? '−' : entry.amount_kopecks < 0 ? '' : '+'}
                        {formatRub(Math.abs(entry.amount_kopecks))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
