import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ClipboardCheck,
  Clock,
  ExternalLink,
  Pencil,
  Search,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { apiRequest, formatDateTimeRu, formatRub } from '../lib/api';
import type { AuthUser, DirectoryUser } from '../types/crm';

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
  rate_snapshot_kopecks?: number;
  created_at: string;
  employee_name: string;
  employee_position: string;
}

interface ReportsViewProps {
  user: AuthUser;
  directory: DirectoryUser[];
  onOpenOrderById: (orderId: string) => void;
}

export function ReportsView({ user, directory, onOpenOrderById }: ReportsViewProps) {
  const isAdmin = user.role === 'admin';
  const [subTab, setSubTab] = useState<'visits' | 'shifts'>('visits');
  const [canViewOthers, setCanViewOthers] = useState(
    isAdmin || Boolean(user.permissions['reports.view_others'])
  );
  const [visitReports, setVisitReports] = useState<VisitReportFeedItem[]>([]);
  const [shiftReports, setShiftReports] = useState<ShiftReportFeedItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
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
      if (search.trim()) qs.set('q', search.trim());
      const res = await apiRequest<{
        canViewOthers: boolean;
        visitReports: VisitReportFeedItem[];
        shiftReports: ShiftReportFeedItem[];
      }>(`/api/reports${qs.toString() ? `?${qs.toString()}` : ''}`);
      setCanViewOthers(res.canViewOthers);
      setVisitReports(res.visitReports);
      setShiftReports(res.shiftReports);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки отчётов');
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, search]);

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
            startTime: editStart,
            endTime: editEnd,
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

      {/* Toolbar */}
      <div className="flex flex-col justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] lg:flex-row lg:items-center dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-xl bg-[#F5F5F7] p-1 dark:bg-[#0B0C10]">
            <button
              type="button"
              onClick={() => setSubTab('visits')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                subTab === 'visits' ? 'bg-white shadow-xs dark:bg-[#15171C]' : 'text-zinc-500'
              }`}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span>Выезды ({visitReports.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setSubTab('shifts')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                subTab === 'shifts' ? 'bg-white shadow-xs dark:bg-[#15171C]' : 'text-zinc-500'
              }`}
            >
              <Wrench className="h-3.5 w-3.5" />
              <span>Смены в цеху ({shiftReports.length})</span>
            </button>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {canViewOthers
              ? 'Доступ ко всем отчётам сотрудников'
              : 'Показаны только ваши личные отчёты'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canViewOthers && directory.length > 0 && (
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
            >
              <option value="">Все сотрудники</option>
              {directory.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.fullName}
                </option>
              ))}
            </select>
          )}
          <div className="relative min-w-[200px] flex-1 sm:w-64">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по заказу, работам..."
              className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-2 pl-8 pr-3 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:focus:bg-[#0B0C10] dark:border-white/[0.1] dark:bg-[#0B0C10]"
            />
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
              const canModify = isAdmin || rep.user_id === user.id;
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
                    <form onSubmit={(e) => void handleSaveEdit(e, rep)} className="mt-3 space-y-2.5 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
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
                      {rep.notes && (
                        <p className="mt-1 text-xs text-zinc-400">{rep.notes}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
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
            return (
              <div
                key={sh.id}
                className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold">
                      {sh.employee_name}
                      {sh.employee_position && (
                        <span className="ml-1.5 text-xs font-normal text-zinc-400">
                          ({sh.employee_position})
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500 tabular-nums">
                      {formatDateTimeRu(sh.started_at)} → {formatDateTimeRu(sh.ended_at)} ·{' '}
                      {Math.floor(mins / 60)} ч {mins % 60} мин
                    </div>
                  </div>
                  {sh.rate_snapshot_kopecks !== undefined && (
                    <div className="text-sm font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                      {formatRub(sh.rate_snapshot_kopecks)}
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
