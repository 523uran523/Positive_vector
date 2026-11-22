import React, { useEffect, useMemo, useState } from 'react';
import { Briefcase, Calendar, CheckCircle2, ListTodo, Plus, Search, X } from 'lucide-react';
import { apiRequest, formatDateRu } from '../lib/api';
import { toLocalDateString } from '../lib/links';
import type { AuthUser, DirectoryUser, Order, QuickTask } from '../types/crm';

interface QuickTaskModalProps {
  user: AuthUser;
  directory: DirectoryUser[];
  orders?: Order[];
  creating: boolean;
  task: QuickTask | null;
  defaultDate: string;
  onClose: () => void;
  onTaskChange: (task: QuickTask | null) => void;
  onRefresh: () => void;
  onNotice: (msg: string) => void;
  onOpenOrderById?: (orderId: string) => void;
}

function QuickTaskModal({
  user,
  directory,
  orders = [],
  creating,
  task,
  defaultDate,
  onClose,
  onTaskChange,
  onRefresh,
  onNotice,
  onOpenOrderById,
}: QuickTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState(task?.due_date || defaultDate);
  const [orderId, setOrderId] = useState('');
  const [assignees, setAssignees] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingAssignees, setEditingAssignees] = useState(false);

  useEffect(() => {
    setError('');
    setEditingAssignees(false);
    setComment('');
    if (creating) {
      setTitle('');
      setDescription('');
      setOrderId('');
      setAssignees([user.id]);
      setDueDate(defaultDate);
    } else if (task) {
      setDueDate(task.due_date);
      setOrderId(task.order_id || '');
      setAssignees(task.assignees.map((a) => a.id));
    }
  }, [creating, task?.id, defaultDate, user.id]);

  if (!creating && !task) return null;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!assignees.length) {
      setError('Выберите хотя бы одного исполнителя.');
      return;
    }
    setBusy(true);
    setError('');
    onNotice('');
    try {
      const result = await apiRequest<{ task?: QuickTask; offlineQueued?: boolean }>('/api/quick-tasks', {
        method: 'POST',
        body: { title, description, dueDate, orderId: orderId || null, assigneeIds: assignees },
        offlineLabel: `Создание задачи «${title.trim()}»`,
      });
      if (result.offlineQueued) {
        onClose();
        onNotice('Задача в офлайн-очереди и появится после отправки на сервер.');
      } else if (result.task) {
        onTaskChange(result.task);
        setDueDate(result.task.due_date);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать задачу');
    } finally {
      setBusy(false);
    }
  };

  const reschedule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task) return;
    setBusy(true);
    setError('');
    onNotice('');
    try {
      const result = await apiRequest<{ task?: QuickTask; offlineQueued?: boolean }>(
        `/api/quick-tasks/${task.id}`,
        {
          method: 'PATCH',
          body: { dueDate },
          offlineLabel: `Перенос задачи «${task.title}»`,
        }
      );
      if (result.offlineQueued) {
        onClose();
        onNotice('Перенос в офлайн-очереди; срок изменится после отправки.');
      } else if (result.task) {
        onTaskChange(result.task);
        setDueDate(result.task.due_date);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось перенести срок');
    } finally {
      setBusy(false);
    }
  };

  const complete = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task) return;
    setBusy(true);
    setError('');
    onNotice('');
    try {
      const result = await apiRequest<{ task?: QuickTask; offlineQueued?: boolean }>(
        `/api/quick-tasks/${task.id}/complete`,
        {
          method: 'POST',
          body: { comment },
          offlineLabel: `Завершение задачи «${task.title}»`,
        }
      );
      if (result.offlineQueued) {
        onClose();
        onNotice('Завершение в офлайн-очереди; задача закроется после отправки.');
      } else if (result.task) {
        onTaskChange(result.task);
        setComment('');
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось завершить задачу');
    } finally {
      setBusy(false);
    }
  };

  const changeAssignees = async () => {
    if (!task || !assignees.length) {
      setError('Выберите хотя бы одного исполнителя.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<{
        task?: QuickTask;
        stillVisible?: boolean;
        offlineQueued?: boolean;
      }>(`/api/quick-tasks/${task.id}/assignees`, {
        method: 'POST',
        body: { assigneeIds: assignees },
        offlineLabel: `Исполнители задачи «${task.title}»`,
      });
      setEditingAssignees(false);
      if (result.offlineQueued) {
        onClose();
        onNotice('Изменение исполнителей сохранено в офлайн-очередь.');
      } else if (result.stillVisible === false) {
        onClose();
        onNotice('Исполнители изменены; задача больше вам не назначена.');
      } else if (result.task) {
        onTaskChange(result.task);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить исполнителей');
    } finally {
      setBusy(false);
    }
  };

  const transition = async (action: 'cancel' | 'reopen') => {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<{ task?: QuickTask; offlineQueued?: boolean }>(
        `/api/quick-tasks/${task.id}/${action}`,
        {
          method: 'POST',
          body: {},
          offlineLabel: `${action === 'cancel' ? 'Отмена' : 'Возобновление'} задачи «${task.title}»`,
        }
      );
      if (result.offlineQueued) {
        onClose();
        onNotice('Действие сохранено в офлайн-очередь.');
      } else if (result.task) {
        onTaskChange(result.task);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить задачу');
    } finally {
      setBusy(false);
    }
  };

  const canComplete = Boolean(
    task?.status === 'open' && task.assignees.some((a) => a.id === user.id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-black/10 bg-white p-5 shadow-2xl sm:rounded-3xl dark:border-white/10 dark:bg-[#15171C]">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold">
            {creating ? 'Новая быстрая задача' : task?.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-xl p-1.5 text-zinc-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <p role="alert" className="mb-3 rounded-xl bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {creating ? (
          <form onSubmit={create} className="space-y-4">
            <label className="block text-sm font-semibold">
              Название
              <input
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Например: Завезти профиль на объект"
                className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal outline-none focus:border-blue-500 dark:border-white/10 dark:bg-[#0B0C10]"
              />
            </label>
            <label className="block text-sm font-semibold">
              Описание
              <textarea
                maxLength={4000}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Детали, адрес или уточнения..."
                className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal outline-none focus:border-blue-500 dark:border-white/10 dark:bg-[#0B0C10]"
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-sm font-semibold">
                Срок
                <input
                  type="date"
                  required
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal dark:border-white/10 dark:bg-[#0B0C10]"
                />
              </label>
              {orders.length > 0 && (
                <label className="block text-sm font-semibold">
                  Заказ (необяз.)
                  <select
                    value={orderId}
                    onChange={(e) => setOrderId(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal dark:border-white/10 dark:bg-[#0B0C10]"
                  >
                    <option value="">Без привязки к заказу</option>
                    {orders.map((ord) => (
                      <option key={ord.id} value={ord.id}>
                        {ord.order_number} · {ord.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <fieldset>
              <legend className="text-sm font-semibold">Исполнители</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {directory.map((person) => (
                  <label
                    key={person.id}
                    className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-black/10 px-3 text-sm dark:border-white/10"
                  >
                    <input
                      type="checkbox"
                      checked={assignees.includes(person.id)}
                      onChange={(e) =>
                        setAssignees((prev) =>
                          e.target.checked
                            ? [...prev, person.id]
                            : prev.filter((id) => id !== person.id)
                        )
                      }
                    />
                    {person.fullName}
                  </label>
                ))}
              </div>
              {!directory.length && (
                <p className="mt-1 text-sm text-zinc-500">
                  Список сотрудников недоступен. Подключитесь к сети.
                </p>
              )}
            </fieldset>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-[#0071E3] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Сохраняем…' : 'Создать задачу'}
            </button>
          </form>
        ) : (
          task && (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-2 font-semibold text-violet-700 dark:text-violet-300">
                {task.status === 'completed' ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <ListTodo className="h-4 w-4" />
                )}
                <span>
                  {task.status === 'completed'
                    ? 'Выполнена'
                    : task.status === 'cancelled'
                      ? 'Отменена'
                      : 'Открыта'}
                </span>
              </div>

              {task.order_id && task.order_number && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.08] dark:bg-[#0B0C10]">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Briefcase className="h-3.5 w-3.5 text-[#0071E3] dark:text-[#2997FF]" />
                    <span>
                      {task.order_number} {task.order_title ? `· ${task.order_title}` : ''}
                    </span>
                  </span>
                  {onOpenOrderById && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenOrderById(task.order_id!);
                      }}
                      className="shrink-0 font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                    >
                      Открыть заказ →
                    </button>
                  )}
                </div>
              )}

              {task.description && (
                <p className="whitespace-pre-wrap break-words rounded-xl bg-[#F5F5F7]/70 p-3 dark:bg-[#0B0C10]">
                  {task.description}
                </p>
              )}

              <div>
                <p>
                  <span className="text-zinc-500">Исполнители: </span>
                  {task.assignees.map((a) => a.full_name).join(', ')}
                </p>
                {!editingAssignees ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAssignees(task.assignees.map((a) => a.id));
                      setEditingAssignees(true);
                    }}
                    className="mt-1 text-xs font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                  >
                    Изменить исполнителей
                  </button>
                ) : (
                  <div className="mt-2 space-y-2 rounded-xl border border-black/[0.06] p-3 dark:border-white/[0.08]">
                    <div className="flex flex-wrap gap-2">
                      {directory.map((person) => (
                        <label
                          key={person.id}
                          className="flex cursor-pointer items-center gap-2 rounded-xl border border-black/10 px-3 py-1.5 text-xs dark:border-white/10"
                        >
                          <input
                            type="checkbox"
                            checked={assignees.includes(person.id)}
                            onChange={(e) =>
                              setAssignees((prev) =>
                                e.target.checked
                                  ? [...prev, person.id]
                                  : prev.filter((id) => id !== person.id)
                              )
                            }
                          />
                          {person.fullName}
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void changeAssignees()}
                        className="rounded-xl bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Сохранить исполнителей
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingAssignees(false)}
                        className="rounded-xl border border-black/10 px-3 py-1.5 text-xs dark:border-white/10"
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <form onSubmit={reschedule} className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 font-semibold">
                  Срок
                  <input
                    type="date"
                    required
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal dark:border-white/10 dark:bg-[#0B0C10]"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || dueDate === task.due_date}
                  className="min-h-10 rounded-xl border border-blue-500/40 px-3 text-xs font-semibold text-blue-700 disabled:opacity-50 dark:text-blue-300"
                >
                  Перенести срок
                </button>
              </form>

              {task.status === 'completed' && (
                <div className="rounded-xl bg-emerald-500/10 p-3">
                  <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                    Завершил: {task.completed_by_name || 'Сотрудник'}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{task.completion_comment}</p>
                </div>
              )}

              {canComplete && (
                <form onSubmit={complete} className="space-y-2 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
                  <label className="block font-semibold">
                    Что выполнено *
                    <textarea
                      required
                      maxLength={4000}
                      rows={3}
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="Напишите обязательный комментарий о выполнении"
                      className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal dark:border-white/10 dark:bg-[#0B0C10]"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Завершить задачу
                  </button>
                </form>
              )}

              <div className="border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void transition(task.status === 'open' ? 'cancel' : 'reopen')}
                  className="rounded-xl border border-black/[0.12] px-4 py-2 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.12]"
                >
                  {task.status === 'open' ? 'Отменить задачу' : 'Вернуть задачу в работу'}
                </button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

interface CompactProps {
  mode?: 'compact';
  user: AuthUser;
  directory: DirectoryUser[];
  orders?: Order[];
  selectedDate: string;
  dayTasks: QuickTask[];
  openTaskId: string | null;
  onConsumeOpenTask: () => void;
  onRefresh: () => void;
  onOpenOrderById?: (orderId: string) => void;
}

interface StandaloneProps {
  mode: 'standalone';
  user: AuthUser;
  directory: DirectoryUser[];
  orders?: Order[];
  tasks: QuickTask[];
  openTaskId: string | null;
  onConsumeOpenTask: () => void;
  onRefresh: () => void;
  onOpenOrderById?: (orderId: string) => void;
}

export function QuickTasks(props: CompactProps | StandaloneProps) {
  const [creating, setCreating] = useState(false);
  const [task, setTask] = useState<QuickTask | null>(null);
  const [notice, setNotice] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'completed' | 'cancelled'>('open');
  const [search, setSearch] = useState('');

  const { user, directory, orders = [], openTaskId, onConsumeOpenTask, onRefresh, onOpenOrderById } = props;
  const todayKey = toLocalDateString(new Date());

  // 1-line quick add state for standalone mode
  const [quickTitle, setQuickTitle] = useState('');
  const [quickDate, setQuickDate] = useState(todayKey);
  const [quickAssignee, setQuickAssignee] = useState(user.id);
  const [quickOrderId, setQuickOrderId] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = quickTitle.trim();
    if (!title || !quickAssignee) return;
    setQuickBusy(true);
    setNotice('');
    try {
      const result = await apiRequest<{ task?: QuickTask; offlineQueued?: boolean }>('/api/quick-tasks', {
        method: 'POST',
        body: {
          title,
          description: '',
          dueDate: quickDate || todayKey,
          orderId: quickOrderId || null,
          assigneeIds: [quickAssignee],
        },
        offlineLabel: `Быстрая задача «${title}»`,
      });
      setQuickTitle('');
      setQuickOrderId('');
      if (result.offlineQueued) {
        setNotice('Задача поставлена в офлайн-очередь.');
      }
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Не удалось создать задачу');
    } finally {
      setQuickBusy(false);
    }
  };

  const openTaskById = async (id: string) => {
    try {
      const result = await apiRequest<{ task: QuickTask }>(`/api/quick-tasks/${id}`);
      setCreating(false);
      setTask(result.task);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Не удалось открыть задачу');
    }
  };

  useEffect(() => {
    if (openTaskId) {
      void openTaskById(openTaskId);
      onConsumeOpenTask();
    }
  }, [openTaskId, onConsumeOpenTask]);

  const statusMeta = (status: QuickTask['status']) => {
    if (status === 'completed') {
      return { label: 'Выполнена', cls: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' };
    }
    if (status === 'cancelled') {
      return { label: 'Отменена', cls: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400' };
    }
    return { label: 'Открыта', cls: 'bg-violet-500/12 text-violet-700 dark:text-violet-300' };
  };

  const filteredStandaloneTasks = useMemo(() => {
    if (props.mode !== 'standalone') return [];
    const q = search.trim().toLowerCase();
    return props.tasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.order_number || '').toLowerCase().includes(q) ||
        t.assignees.some((a) => a.full_name.toLowerCase().includes(q))
      );
    });
  }, [props, statusFilter, search]);

  if (props.mode === 'standalone') {
    return (
      <div className="space-y-4">
        {/* 1-Line Quick Add Bar */}
        <form
          onSubmit={handleQuickAdd}
          className="grid grid-cols-1 gap-2 rounded-2xl border border-violet-500/20 bg-white p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:grid-cols-12 dark:border-violet-500/25 dark:bg-[#15171C]"
        >
          <input
            type="text"
            required
            maxLength={200}
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="Быстрая задача (напр. довезти уголок) — Enter для добавления..."
            className="min-w-0 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs outline-none focus:border-violet-500 focus:bg-white sm:col-span-5 dark:border-white/[0.1] dark:bg-[#0B0C10]"
          />
          <input
            type="date"
            aria-label="Срок задачи"
            value={quickDate}
            onChange={(e) => setQuickDate(e.target.value)}
            className="min-w-0 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs tabular-nums sm:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
          />
          <select
            aria-label="Исполнитель задачи"
            value={quickAssignee}
            onChange={(e) => setQuickAssignee(e.target.value)}
            className="min-w-0 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs sm:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
          >
            {directory.map((person) => (
              <option key={person.id} value={person.id}>
                {person.fullName}
              </option>
            ))}
          </select>
          {orders.length > 0 && (
            <select
              aria-label="Заказ для задачи"
              value={quickOrderId}
              onChange={(e) => setQuickOrderId(e.target.value)}
              className="min-w-0 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs sm:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
            >
              <option value="">Без заказа</option>
              {orders.map((ord) => (
                <option key={ord.id} value={ord.id}>
                  {ord.order_number} · {ord.title}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            disabled={quickBusy || !quickTitle.trim()}
            className={`inline-flex min-h-[36px] items-center justify-center gap-1 rounded-xl bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50 ${
              orders.length > 0 ? 'sm:col-span-1' : 'sm:col-span-3'
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className={orders.length > 0 ? 'sm:hidden lg:inline' : ''}>Добавить</span>
          </button>
        </form>

        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:flex-row sm:items-center dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'open', label: `Открытые (${props.tasks.filter((t) => t.status === 'open').length})` },
                { id: 'completed', label: `Выполненные (${props.tasks.filter((t) => t.status === 'completed').length})` },
                { id: 'cancelled', label: `Отменённые (${props.tasks.filter((t) => t.status === 'cancelled').length})` },
                { id: 'all', label: `Все (${props.tasks.length})` },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setStatusFilter(opt.id)}
                className={`min-h-[36px] rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  statusFilter === opt.id
                    ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                    : 'bg-[#F5F5F7] text-zinc-600 hover:bg-black/[0.06] dark:bg-[#0B0C10] dark:text-zinc-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:w-64">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по названию, заказу, исполнителю..."
                className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-2 pl-8 pr-3 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10] dark:focus:bg-[#0B0C10]"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setTask(null);
                setCreating(true);
                setNotice('');
              }}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-violet-500/35 px-3.5 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-500/10 dark:text-violet-300"
            >
              <Plus className="h-4 w-4" />
              <span>Подробно</span>
            </button>
          </div>
        </div>

        {notice && (
          <p role="status" className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
            {notice}
          </p>
        )}

        {filteredStandaloneTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
            Быстрых задач по выбранным условиям нет
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {filteredStandaloneTasks.map((item) => {
              const meta = statusMeta(item.status);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setNotice('');
                    setCreating(false);
                    setTask(item);
                  }}
                  className="flex flex-col justify-between rounded-2xl border border-black/[0.06] bg-white p-4 text-left shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition hover:border-violet-500/50 dark:border-white/[0.08] dark:bg-[#15171C]"
                >
                  <div className="w-full">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-display text-sm font-bold leading-snug text-[#1D1D1F] dark:text-white">
                        {item.title}
                      </span>
                      <span className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </div>
                    {item.order_number && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-[#0071E3]/10 px-2 py-0.5 text-[11px] font-semibold text-[#0071E3] dark:text-[#2997FF]">
                        <Briefcase className="h-3 w-3" />
                        <span>{item.order_number}</span>
                      </div>
                    )}
                    {item.description && (
                      <p className="mt-1.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.05] pt-2.5 text-xs text-zinc-500 dark:border-white/[0.06] dark:text-zinc-400">
                    <span className="truncate">
                      {item.assignees.map((a) => a.full_name).join(', ') || 'Без исполнителей'}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums">
                      <Calendar className="h-3.5 w-3.5 text-zinc-400" />
                      {formatDateRu(item.due_date)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <QuickTaskModal
          user={user}
          directory={directory}
          orders={orders}
          creating={creating}
          task={task}
          defaultDate={todayKey}
          onClose={() => {
            setCreating(false);
            setTask(null);
          }}
          onTaskChange={(next) => {
            setCreating(false);
            setTask(next);
          }}
          onRefresh={onRefresh}
          onNotice={setNotice}
          onOpenOrderById={onOpenOrderById}
        />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setTask(null);
          setCreating(true);
          setNotice('');
        }}
        className="mb-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-violet-500/40 px-4 py-3 text-sm font-semibold text-violet-700 hover:bg-violet-500/5 dark:text-violet-300"
      >
        <Plus className="h-4 w-4" /> Быстрая задача
      </button>

      {notice && (
        <p role="status" className="mb-3 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          {notice}
        </p>
      )}

      {props.dayTasks.length > 0 && (
        <section className="mb-4 space-y-2">
          <h4 className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
            Быстрые задачи ({props.dayTasks.length})
          </h4>
          {props.dayTasks.map((item) => {
            const meta = statusMeta(item.status);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setNotice('');
                  setCreating(false);
                  setTask(item);
                }}
                className="w-full rounded-2xl border border-violet-500/25 bg-violet-500/[0.06] p-3.5 text-left text-sm transition hover:border-violet-500/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-bold text-violet-700 dark:text-violet-300">
                      Задача
                    </span>
                    {item.order_number && (
                      <span className="rounded-md bg-[#0071E3]/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#0071E3] dark:text-[#2997FF]">
                        {item.order_number}
                      </span>
                    )}
                    <span className="font-semibold">{item.title}</span>
                  </div>
                  <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
                    {meta.label}
                  </span>
                </div>
                <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                  {item.assignees.map((a) => a.full_name).join(', ')}
                </span>
              </button>
            );
          })}
        </section>
      )}

      <QuickTaskModal
        user={user}
        directory={directory}
        orders={orders}
        creating={creating}
        task={task}
        defaultDate={props.selectedDate}
        onClose={() => {
          setCreating(false);
          setTask(null);
        }}
        onTaskChange={(next) => {
          setCreating(false);
          setTask(next);
        }}
        onRefresh={onRefresh}
        onNotice={setNotice}
        onOpenOrderById={onOpenOrderById}
      />
    </>
  );
}
