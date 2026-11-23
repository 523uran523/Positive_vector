import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CheckSquare,
  ClipboardCheck,
  Clock,
  ExternalLink,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { DatePresets } from '../components/DatePresets';
import { apiRequest, formatDateRu, formatDateTimeRu, formatDuration, formatRub } from '../lib/api';
import type { AuthUser, DirectoryUser, Order, QuickTaskReport, QuickTasksSummary } from '../types/crm';

interface VisitReportFeedItem {
  id: string;
  visit_id: string;
  order_id: string;
  user_id: string;
  is_primary: number;
  start_time: string;
  end_time: string;
  work_done: string;
  notes: string;
  created_at: string;
  author_name: string;
  author_position: string;
  order_number: string;
  order_title: string;
  order_address: string;
  order_status?: string;
  visit_title: string;
  visit_scheduled_at: string;
}

interface ShiftReportFeedItem {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  work_done: string;
  status: string;
  shift_type?: 'workshop' | 'visit' | 'quick_task';
  order_id?: string | null;
  visit_id?: string | null;
  quick_task_id?: string | null;
  work_date?: string;
  order_number?: string | null;
  order_title?: string | null;
  visit_title?: string | null;
  quick_task_title?: string | null;
  wage_kopecks?: number | null;
  rate_snapshot_kopecks?: number;
  created_at: string;
  employee_name: string;
  employee_position: string;
}

interface ReportsViewProps {
  user: AuthUser;
  directory: DirectoryUser[];
  orders?: Order[];
  onOpenOrderById: (orderId: string) => void;
}

export function ReportsView({ user, directory, orders = [], onOpenOrderById }: ReportsViewProps) {
  const isAdmin = user.role === 'admin';
  const [subTab, setSubTab] = useState<'visits' | 'shifts' | 'quick_tasks'>('visits');
  const [canViewOthers, setCanViewOthers] = useState(
    isAdmin || Boolean(user.permissions['reports.view_others'])
  );
  const [visitReports, setVisitReports] = useState<VisitReportFeedItem[]>([]);
  const [shiftReports, setShiftReports] = useState<ShiftReportFeedItem[]>([]);
  const [quickTaskReports, setQuickTaskReports] = useState<QuickTaskReport[]>([]);
  const [quickTasksSummary, setQuickTasksSummary] = useState<QuickTasksSummary>({
    total: 0,
    open: 0,
    completed: 0,
    cancelled: 0,
    workedMinutes: 0,
  });
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Inline edit / delete state for visit reports
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [editWork, setEditWork] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (selectedUserId) qs.set('userId', selectedUserId);
      if (selectedOrderId) qs.set('orderId', selectedOrderId);
      if (fromDate) qs.set('from', fromDate);
      if (toDate) qs.set('to', toDate);
      if (search.trim()) qs.set('q', search.trim());
      const res = await apiRequest<{
        canViewOthers: boolean;
        visitReports: VisitReportFeedItem[];
        shiftReports: ShiftReportFeedItem[];
        quickTaskReports?: QuickTaskReport[];
        quickTasksSummary?: QuickTasksSummary;
      }>(`/api/reports${qs.toString() ? `?${qs.toString()}` : ''}`);
      setCanViewOthers(res.canViewOthers);
      setVisitReports(res.visitReports);
      setShiftReports(res.shiftReports);
      setQuickTaskReports(res.quickTaskReports || []);
      setQuickTasksSummary(
        res.quickTasksSummary || { total: 0, open: 0, completed: 0, cancelled: 0, workedMinutes: 0 }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки отчётов');
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, selectedOrderId, fromDate, toDate, search]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const startEdit = (rep: VisitReportFeedItem) => {
    setEditingId(rep.id);
    setEditStart(rep.start_time || '');
    setEditEnd(rep.end_time || '');
    setEditWork(rep.work_done);
    setEditNotes(rep.notes || '');
    setConfirmDeleteId(null);
    setError('');
  };

  const handleSaveEdit = async (e: React.FormEvent, rep: VisitReportFeedItem) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(
        `/api/orders/${rep.order_id}/visits/${rep.visit_id}/reports/${rep.id}`,
        {
          method: 'PATCH',
          body: {
            ...(isAdmin ? { startTime: editStart, endTime: editEnd } : {}),
            workDone: editWork,
            notes: editNotes,
          },
          offlineLabel: `Изменение отчёта по ${rep.order_number}`,
        }
      );
      setEditingId(null);
      if (res.offlineQueued) {
        setNotice('Изменения отчёта сохранены в офлайн-очередь и отправятся при появлении сети.');
      } else {
        await loadReports();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка редактирования отчёта');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteReport = async (rep: VisitReportFeedItem) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(
        `/api/orders/${rep.order_id}/visits/${rep.visit_id}/reports/${rep.id}`,
        {
          method: 'DELETE',
          offlineLabel: `Удаление отчёта по ${rep.order_number}`,
        }
      );
      setConfirmDeleteId(null);
      if (res.offlineQueued) {
        setNotice('Удаление отчёта поставлено в офлайн-очередь.');
      } else {
        await loadReports();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления отчёта');
    } finally {
      setBusy(false);
    }
  };

  const hasFilters = Boolean(selectedUserId || selectedOrderId || fromDate || toDate || search.trim());

  return (
    <div className="space-y-4">
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

      {/* Toolbar: Work type + Filters */}
      <div className="space-y-2.5 rounded-2xl border border-black/[0.06] bg-white p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1 rounded-xl bg-[#F5F5F7] p-1 dark:bg-[#0B0C10]">
            <button
              type="button"
              onClick={() => setSubTab('visits')}
              className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                subTab === 'visits'
                  ? 'bg-[#0071E3] text-white shadow-xs dark:bg-[#2997FF] dark:text-[#0B0C10]'
                  : 'text-zinc-600 dark:text-zinc-300'
              }`}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span>Выезды ({visitReports.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setSubTab('shifts')}
              className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                subTab === 'shifts'
                  ? 'bg-[#0071E3] text-white shadow-xs dark:bg-[#2997FF] dark:text-[#0B0C10]'
                  : 'text-zinc-600 dark:text-zinc-300'
              }`}
            >
              <Wrench className="h-3.5 w-3.5" />
              <span>Смены в цеху ({shiftReports.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setSubTab('quick_tasks')}
              className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                subTab === 'quick_tasks'
                  ? 'bg-[#0071E3] text-white shadow-xs dark:bg-[#2997FF] dark:text-[#0B0C10]'
                  : 'text-zinc-600 dark:text-zinc-300'
              }`}
            >
              <CheckSquare className="h-3.5 w-3.5" />
              <span>Быстрые задачи ({quickTaskReports.length})</span>
            </button>
          </div>
          <DatePresets
            from={fromDate}
            to={toDate}
            onChange={(f, t) => {
              setFromDate(f);
              setToDate(t);
            }}
          />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-12">
          <div className="relative sm:col-span-2 md:col-span-3 lg:col-span-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по заказу, работам..."
              className={`w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-1.5 pl-8 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10] dark:focus:bg-[#0B0C10] ${
                search ? 'pr-8' : 'pr-3'
              }`}
            />
            {search && (
              <button
                type="button"
                aria-label="Очистить поиск"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-zinc-400 transition hover:bg-black/[0.06] hover:text-zinc-700 dark:hover:bg-white/[0.08] dark:hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {canViewOthers && directory.length > 0 && (
            <select
              aria-label="Фильтр по сотруднику"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs lg:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
            >
              <option value="">Все сотрудники</option>
              {directory.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.fullName}
                </option>
              ))}
            </select>
          )}

          {orders.length > 0 && (subTab === 'visits' || subTab === 'quick_tasks') && (
            <select
              aria-label="Фильтр по заказу"
              value={selectedOrderId}
              onChange={(e) => setSelectedOrderId(e.target.value)}
              className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs lg:col-span-3 dark:border-white/[0.1] dark:bg-[#0B0C10]"
            >
              <option value="">Все заказы</option>
              {orders.map((ord) => (
                <option key={ord.id} value={ord.id}>
                  {ord.order_number} · {ord.title}
                </option>
              ))}
            </select>
          )}

          <input
            type="date"
            aria-label="Дата с"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-1.5 text-xs tabular-nums lg:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
          />
          <div className="flex items-center gap-1.5 lg:col-span-2">
            <input
              type="date"
              aria-label="Дата по"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
            />
            {hasFilters && (
              <button
                type="button"
                title="Сбросить фильтры"
                onClick={() => {
                  setSelectedUserId('');
                  setSelectedOrderId('');
                  setFromDate('');
                  setToDate('');
                  setSearch('');
                }}
                className="inline-flex h-8 shrink-0 items-center justify-center rounded-xl border border-black/[0.08] px-2.5 text-xs font-semibold text-zinc-600 hover:bg-black/[0.04] dark:border-white/[0.1] dark:text-zinc-300"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-black/[0.06] bg-white p-8 text-center text-sm text-zinc-400 dark:border-white/[0.08] dark:bg-[#15171C]">
          Загрузка отчётов...
        </div>
      ) : subTab === 'visits' ? (
        visitReports.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
            Отчётов по выездам пока нет
          </div>
        ) : (
          <div className="space-y-3">
            {visitReports.map((rep) => {
              const repClosed = rep.order_status === 'completed' || rep.order_status === 'cancelled';
              const canModify = isAdmin || (rep.user_id === user.id && !repClosed);
              const isEditing = editingId === rep.id;
              const isConfirmingDel = confirmDeleteId === rep.id;
              return (
                <div
                  key={rep.id}
                  className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => onOpenOrderById(rep.order_id)}
                          className="inline-flex items-center gap-1 font-mono font-bold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                        >
                          <span>{rep.order_number}</span>
                          <ExternalLink className="h-3 w-3" />
                        </button>
                        <span className="font-semibold">{rep.order_title}</span>
                        <span className="text-zinc-300 dark:text-zinc-600">·</span>
                        <span className="text-zinc-500">{rep.visit_title}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="font-semibold text-[#1D1D1F] dark:text-white">
                          {rep.author_name}
                        </span>
                        {rep.author_position && <span>({rep.author_position})</span>}
                        <span>·</span>
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <Clock className="h-3 w-3" />
                          {rep.start_time && rep.end_time
                            ? `${rep.start_time}–${rep.end_time} · `
                            : ''}
                          {formatDateTimeRu(rep.created_at)}
                        </span>
                      </div>
                    </div>

                    {canModify && !isEditing && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => startEdit(rep)}
                          title="Редактировать отчёт"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:text-[#0071E3] dark:border-white/[0.1] dark:text-zinc-400"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {!isConfirmingDel ? (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(rep.id)}
                            title="Удалить отчёт"
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:border-red-500/30 hover:text-red-600 dark:border-white/[0.1] dark:text-zinc-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <div className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px]">
                            <span className="font-semibold text-red-600 dark:text-red-400">Удалить?</span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleDeleteReport(rep)}
                              className="rounded bg-red-600 px-1.5 py-0.5 font-semibold text-white"
                            >
                              Да
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-1 text-zinc-500"
                            >
                              Нет
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {isEditing ? (
                    <form
                      onSubmit={(e) => void handleSaveEdit(e, rep)}
                      className="mt-3 space-y-2.5 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]"
                    >
                      {isAdmin ? (
                        <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
                          <input
                            type="time"
                            value={editStart}
                            onChange={(e) => setEditStart(e.target.value)}
                            className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                          />
                          <input
                            type="time"
                            value={editEnd}
                            onChange={(e) => setEditEnd(e.target.value)}
                            className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                          />
                        </div>
                      ) : (
                        <p className="text-[11px] text-zinc-500">
                          Время по отчёту ({rep.start_time && rep.end_time ? `${rep.start_time}–${rep.end_time}` : 'по таймеру'}) может менять только администратор.
                        </p>
                      )}
                      <textarea
                        required
                        rows={2}
                        value={editWork}
                        onChange={(e) => setEditWork(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                      />
                      <input
                        type="text"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Примечания"
                        className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-xl bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>Сохранить</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="inline-flex items-center gap-1 rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold dark:border-white/[0.1]"
                        >
                          <X className="h-3.5 w-3.5" />
                          <span>Отмена</span>
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="mt-2.5 text-sm">
                      <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">{rep.work_done}</p>
                      {rep.notes && <p className="mt-1 text-xs text-zinc-400">{rep.notes}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : subTab === 'quick_tasks' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-2xl border border-black/[0.06] bg-white p-3.5 dark:border-white/[0.08] dark:bg-[#15171C]">
              <div className="text-xs text-zinc-500">Всего</div>
              <div className="mt-1 font-display text-lg font-bold tabular-nums">{quickTasksSummary.total}</div>
            </div>
            <div className="rounded-2xl border border-black/[0.06] bg-white p-3.5 dark:border-white/[0.08] dark:bg-[#15171C]">
              <div className="text-xs text-zinc-500">Открыто</div>
              <div className="mt-1 font-display text-lg font-bold text-violet-600 tabular-nums dark:text-violet-400">
                {quickTasksSummary.open}
              </div>
            </div>
            <div className="rounded-2xl border border-black/[0.06] bg-white p-3.5 dark:border-white/[0.08] dark:bg-[#15171C]">
              <div className="text-xs text-zinc-500">Выполнено</div>
              <div className="mt-1 font-display text-lg font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                {quickTasksSummary.completed}
              </div>
            </div>
            <div className="rounded-2xl border border-black/[0.06] bg-white p-3.5 dark:border-white/[0.08] dark:bg-[#15171C]">
              <div className="text-xs text-zinc-500">Отменено</div>
              <div className="mt-1 font-display text-lg font-bold text-zinc-500 tabular-nums">
                {quickTasksSummary.cancelled}
              </div>
            </div>
            <div className="col-span-2 rounded-2xl border border-black/[0.06] bg-white p-3.5 sm:col-span-1 dark:border-white/[0.08] dark:bg-[#15171C]">
              <div className="text-xs text-zinc-500">Время</div>
              <div className="mt-1 font-display text-lg font-bold text-[#0071E3] tabular-nums dark:text-[#2997FF]">
                {formatDuration(quickTasksSummary.workedMinutes)}
              </div>
            </div>
          </div>

          {quickTaskReports.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
              Быстрых задач за выбранный период нет
            </div>
          ) : (
            <div className="space-y-3">
              {quickTaskReports.map((qt) => {
                const stMeta =
                  qt.status === 'completed'
                    ? { label: 'Выполнена', cls: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' }
                    : qt.status === 'cancelled'
                      ? { label: 'Отменена', cls: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400' }
                      : { label: 'Открыта', cls: 'bg-violet-500/12 text-violet-700 dark:text-violet-300' };
                return (
                  <div
                    key={qt.id}
                    className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-display text-sm font-bold">{qt.title}</span>
                          <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${stMeta.cls}`}>
                            {stMeta.label}
                          </span>
                          {qt.order_id && qt.order_number && (
                            <button
                              type="button"
                              onClick={() => onOpenOrderById(qt.order_id!)}
                              className="inline-flex items-center gap-1 font-mono text-xs font-bold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                            >
                              <span>{qt.order_number}</span>
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                          <span>{qt.assignees.map((a) => a.full_name).join(', ') || 'Без исполнителей'}</span>
                          <span>·</span>
                          <span className="tabular-nums">
                            {qt.due_date ? formatDateRu(qt.due_date) : 'Без срока'}
                          </span>
                          {qt.completed_by_name && qt.completed_at && (
                            <>
                              <span>·</span>
                              <span className="tabular-nums">
                                Закрыл: {qt.completed_by_name} ({formatDateTimeRu(qt.completed_at)})
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      {qt.worked_minutes > 0 && (
                        <span className="rounded-lg bg-emerald-500/12 px-2.5 py-1 text-xs font-bold text-emerald-700 tabular-nums dark:text-emerald-300">
                          {formatDuration(qt.worked_minutes)}
                        </span>
                      )}
                    </div>
                    {qt.completion_comment && (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">
                        {qt.completion_comment}
                      </p>
                    )}
                    {!qt.completion_comment && qt.description && (
                      <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-500 dark:text-zinc-400">
                        {qt.description}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : shiftReports.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
          Завершённых смен в цеху пока нет
        </div>
      ) : (
        <div className="space-y-3">
          {shiftReports.map((sh) => {
            const mins = sh.ended_at
              ? Math.max(1, Math.round((Date.parse(sh.ended_at) - Date.parse(sh.started_at)) / 60_000))
              : 0;
            const targetBadge =
              sh.shift_type === 'visit'
                ? `Монтаж ${sh.order_number || ''}${sh.visit_title ? ` · ${sh.visit_title}` : ''}`.trim()
                : sh.shift_type === 'quick_task'
                  ? `Задача: ${sh.quick_task_title || 'Быстрая задача'}`
                  : 'Цех';
            return (
              <div
                key={sh.id}
                className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                      <span>{sh.employee_name}</span>
                      {sh.employee_position && (
                        <span className="text-xs font-normal text-zinc-400">
                          ({sh.employee_position})
                        </span>
                      )}
                      <span className="rounded-md bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-white/[0.08] dark:text-zinc-300">
                        {targetBadge}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500 tabular-nums">
                      {formatDateTimeRu(sh.started_at)} → {formatDateTimeRu(sh.ended_at)} ·{' '}
                      {Math.floor(mins / 60)} ч {mins % 60} мин
                    </div>
                  </div>
                  {(isAdmin || sh.user_id === user.id) && (
                    <div className="text-xs font-bold tabular-nums">
                      {sh.wage_kopecks != null ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {formatRub(sh.wage_kopecks)}
                        </span>
                      ) : (
                        <span className="text-zinc-400">Учёт времени</span>
                      )}
                    </div>
                  )}
                </div>
                {sh.work_done && (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">
                    {sh.work_done}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
