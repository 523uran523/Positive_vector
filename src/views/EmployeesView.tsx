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
  id: string;
  full_name: string;
  login: string;
  role: string;
  position: string;
  shift_rate_kopecks: number;
  is_active: number;
  totalAccruedKopecks: number;
  totalPaidKopecks: number;
  remainingKopecks: number;
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
}

export function EmployeesView({ onOpenOrderById }: EmployeesViewProps) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [permissionLabels, setPermissionLabels] = useState<Record<PermissionKey, string>>(
    {} as Record<PermissionKey, string>
  );
  const [salaries, setSalaries] = useState<SalaryEmployeeSummary[]>([]);
  const [visitAssignments, setVisitAssignments] = useState<VisitAssignmentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState('');
  const [employmentNotice, setEmploymentNotice] = useState('');

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

  // Payout & Adjustment forms
  const [targetUserId, setTargetUserId] = useState('');
  const [amountRub, setAmountRub] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'bank' | 'card'>('card');
  const [comment, setComment] = useState('');

  // Inline visit wage inputs
  const [wageDrafts, setWageDrafts] = useState<Record<string, string>>({});

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки списка сотрудников');
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const openCreate = () => {
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
      await apiRequest(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        body: {
          login: fLogin,
          fullName: fName,
          phone: fPhone,
          position: fPos,
          role: fRole,
          shiftRateKopecks: Math.round(Number(fRateRub || 0) * 100),
          permissions: fPerms,
        },
      });
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
    if (!window.confirm(restoring
      ? `Восстановить ${u.fullName}? Учётная запись снова сможет входить с прежним паролем и увидит напоминание сменить его.`
      : `Переместить ${u.fullName} в уволенные? Доступ к системе будет закрыт, история и расчёты сохранятся.`)) return;
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
          paymentMethod: payMethod,
          comment,
        },
      });
      setModal(null);
      setAmountRub('');
      setComment('');
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

      {/* Employees Cards */}
      <div className="flex flex-wrap gap-2" aria-label="Списки сотрудников">
        <button type="button" onClick={() => setShowDismissed(false)} className={`rounded-xl px-4 py-2 text-sm font-semibold ${!showDismissed ? 'bg-[#0071E3] text-white' : 'bg-zinc-200 dark:bg-[#282b32]'}`}>Сотрудники ({users.filter(u => !u.dismissedAt).length})</button>
        <button type="button" onClick={() => setShowDismissed(true)} className={`rounded-xl px-4 py-2 text-sm font-semibold ${showDismissed ? 'bg-[#0071E3] text-white' : 'bg-zinc-200 dark:bg-[#282b32]'}`}>Уволенные ({users.filter(u => u.dismissedAt).length})</button>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-[#F5F5F7] p-3 text-xs dark:bg-[#0B0C10]">
                  <div>
                    <div className="text-zinc-400">Начислено</div>
                    <div className="mt-0.5 font-bold tabular-nums">
                      {formatRub(sal.totalAccruedKopecks)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-400">Выплачено</div>
                    <div className="mt-0.5 font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                      {formatRub(sal.totalPaidKopecks)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-400">К выплате</div>
                    <div className="mt-0.5 font-bold text-[#0071E3] tabular-nums dark:text-[#2997FF]">
                      {formatRub(sal.remainingKopecks)}
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
                  {u.dismissedAt ? 'Восстановить' : 'Уволить'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

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
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as any)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="card">Перевод на карту</option>
                  <option value="cash">Наличные</option>
                  <option value="bank">Банк (р/с)</option>
                </select>
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
