import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Inbox,
  MapPin,
  Play,
  Plus,
  Square,
  Wrench,
} from 'lucide-react';
import {
  apiRequest,
  formatQty,
  formatRub,
  formatTimeRu,
  ORDER_STATUS_META,
  toLocalDateKey,
} from '../lib/api';
import type {
  AuthUser,
  DirectoryUser,
  MaterialItem,
  Order,
  OrderVisit,
  QuickTask,
  WorkshopShift,
} from '../types/crm';
import { QuickTasks } from './QuickTasks';
import { ReportsView } from './ReportsView';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

interface CalendarViewProps {
  user: AuthUser;
  orders: Order[];
  shifts: WorkshopShift[];
  activeShift: WorkshopShift | null;
  materials: MaterialItem[];
  directory: DirectoryUser[];
  openTaskId: string | null;
  onConsumeOpenTask: () => void;
  onOpenCreateOrder: (defaultDate?: string) => void;
  onOpenOrder: (order: Order) => void;
  onOpenOrderById: (orderId: string) => void;
  onShiftChanged: () => void;
}

export function CalendarView({
  user,
  orders,
  shifts,
  activeShift,
  materials,
  directory,
  openTaskId,
  onConsumeOpenTask,
  onOpenCreateOrder,
  onOpenOrder,
  onOpenOrderById,
  onShiftChanged,
}: CalendarViewProps) {
  const isAdmin = user.role === 'admin';
  const canCreateOrder = isAdmin || user.permissions['orders.create'];
  const canTakeWarehouse = isAdmin || user.permissions['warehouse.take'];

  const localNow = new Date();
  const todayKey = `${localNow.getFullYear()}-${String(localNow.getMonth()+1).padStart(2,'0')}-${String(localNow.getDate()).padStart(2,'0')}`;
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [cursorMonth, setCursorMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [showUnplanned, setShowUnplanned] = useState(false);
  const [calendarView, setCalendarView] = useState<'calendar' | 'orders' | 'tasks' | 'shifts'>('calendar');
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [quickTasks, setQuickTasks] = useState<QuickTask[]>([]);
  const [taskLoadError, setTaskLoadError] = useState('');
  const loadQuickTasks = useCallback(async () => {
    try { const result=await apiRequest<{tasks:QuickTask[]}>('/api/quick-tasks'); setQuickTasks(result.tasks); setTaskLoadError(''); }
    catch { setTaskLoadError('Не удалось загрузить быстрые задачи. Проверьте подключение.'); }
  }, []);
  useEffect(() => {
    void loadQuickTasks();
    const onSynced=() => void loadQuickTasks();
    const timer=window.setInterval(() => { if(document.visibilityState === 'visible' && navigator.onLine) void loadQuickTasks(); }, 30000);
    window.addEventListener('pv:offline-synced',onSynced);
    return () => {window.clearInterval(timer);window.removeEventListener('pv:offline-synced',onSynced);};
  }, [loadQuickTasks]);

  // Live timer for active shift
  const [elapsedText, setElapsedText] = useState('');
  useEffect(() => {
    if (!activeShift) {
      setElapsedText('');
      return;
    }
    const update = () => {
      const diffMs = Math.max(0, Date.now() - new Date(activeShift.started_at).getTime());
      const hrs = Math.floor(diffMs / 3600_000);
      const mins = Math.floor((diffMs % 3600_000) / 60_000);
      const secs = Math.floor((diffMs % 60_000) / 1000);
      setElapsedText(
        `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [activeShift]);

  // Finish shift modal
  const [finishModalOpen, setFinishModalOpen] = useState(false);
  const [workDone, setWorkDone] = useState('');
  const [shiftMaterials, setShiftMaterials] = useState<Array<{ materialId: string; qty: string }>>([]);
  const [shiftBusy, setShiftBusy] = useState(false);
  const [shiftError, setShiftError] = useState('');
  const [shiftOfflineNotice, setShiftOfflineNotice] = useState('');

  const handleStartShift = async () => {
    setShiftBusy(true);
    setShiftError('');
    setShiftOfflineNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>('/api/shifts/start', {
        method: 'POST',
        body: {},
      });
      if (res?.offlineQueued) {
        setShiftOfflineNotice(
          'Старт смены сохранён в офлайн-очередь и будет отправлен при появлении сети.'
        );
      } else {
        onShiftChanged();
      }
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Не удалось начать смену');
    } finally {
      setShiftBusy(false);
    }
  };

  const handleFinishShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setShiftBusy(true);
    setShiftError('');
    setShiftOfflineNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>('/api/shifts/finish', {
        method: 'POST',
        body: {
          workDone,
          shiftId: activeShift?.id,
          materials: shiftMaterials
            .filter((m) => m.materialId && Number(m.qty) > 0)
            .map((m) => ({ materialId: m.materialId, qtyMilli: Math.round(Number(m.qty) * 1000) })),
        },
      });
      setFinishModalOpen(false);
      setWorkDone('');
      setShiftMaterials([]);
      if (res?.offlineQueued) {
        setShiftOfflineNotice(
          'Завершение смены сохранено в офлайн-очередь и будет отправлено при появлении сети.'
        );
      } else {
        onShiftChanged();
      }
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Ошибка завершения смены');
    } finally {
      setShiftBusy(false);
    }
  };

  // Map dateKey -> day items (visits or top-level orders without visits) and shifts
  const dayMap = useMemo(() => {
    const map = new Map<
      string,
      {
        entries: Array<{ order: Order; visit?: OrderVisit; time: string }>;
        shifts: WorkshopShift[];
        tasks: QuickTask[];
      }
    >();

    const ensure = (k: string) => {
      let cell = map.get(k);
      if (!cell) {
        cell = { entries: [], shifts: [], tasks: [] };
        map.set(k, cell);
      }
      return cell;
    };

    for (const ord of orders) {
      if (ord.visits.length > 0) {
        for (const v of ord.visits) {
          if (v.status === 'cancelled') continue;
          const k = toLocalDateKey(v.scheduled_at);
          if (k) {
            ensure(k).entries.push({ order: ord, visit: v, time: formatTimeRu(v.scheduled_at) });
          }
        }
      } else if (ord.scheduled_at) {
        const k = toLocalDateKey(ord.scheduled_at);
        if (k) {
          ensure(k).entries.push({ order: ord, time: formatTimeRu(ord.scheduled_at) });
        }
      }
    }

    for (const sh of shifts) {
      const k = toLocalDateKey(sh.started_at);
      if (k) ensure(k).shifts.push(sh);
    }

    for (const task of quickTasks) ensure(task.due_date).tasks.push(task);

    return map;
  }, [orders, shifts, quickTasks]);

  const unplannedOrders = useMemo(
    () => orders.filter((o) => !o.scheduled_at && o.visits.length === 0 && o.status !== 'cancelled'),
    [orders]
  );
  const cancelledWithIssues = isAdmin ? orders.filter(order=>{
    const issues=order.cancellationIssues;
    if(order.status!=='cancelled' || !issues) return false;
    return issues.materials.length>0 || issues.tools.length>0 ||
      Boolean(issues.paymentsKopecks && !issues.reviews.some(review=>review.issue_key==='payments')) ||
      Boolean(issues.accrualsKopecks && !issues.reviews.some(review=>review.issue_key==='accruals'));
  }) : [];

  // Build calendar grid cells
  const calendarDays = useMemo(() => {
    const year = cursorMonth.getFullYear();
    const month = cursorMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: Array<{ dateKey: string | null; dayNum: number | null }> = [];
    for (let i = 0; i < startOffset; i++) cells.push({ dateKey: null, dayNum: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const mm = String(month + 1).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      cells.push({ dateKey: `${year}-${mm}-${dd}`, dayNum: d });
    }
    return cells;
  }, [cursorMonth]);

  const selectedDayData = dayMap.get(selectedDate) || { entries: [], shifts: [], tasks: [] };

  return (
    <div className="space-y-5">
      {/* Workshop Shift Bar (Primary CTA for Employees & available for quick workshop logging) */}
      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-[#0071E3] dark:text-[#2997FF]" />
              <span className="font-display text-sm font-bold">Работа в цеху</span>
              {activeShift && (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                  Смена идёт
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {activeShift
                ? `Начата в ${new Date(activeShift.started_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · Ставка ${formatRub(activeShift.rate_snapshot_kopecks)}`
                : `Фиксированная ставка смены: ${formatRub(user.shiftRateKopecks)} · Время фиксируется сервером`}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {activeShift && (
              <div className="flex items-center gap-1.5 font-mono text-base font-bold text-[#1D1D1F] tabular-nums dark:text-white">
                <Clock className="h-4 w-4 text-zinc-400" />
                <span>{elapsedText}</span>
              </div>
            )}

            {activeShift ? (
              <button
                type="button"
                onClick={() => setFinishModalOpen(true)}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-red-700"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Завершить смену</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={shiftBusy}
                onClick={() => void handleStartShift()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#0077ED] disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Начать смену</span>
              </button>
            )}
          </div>
        </div>
        {shiftError && (
          <div className="mt-2.5 text-xs font-medium text-red-600 dark:text-red-400">
            {shiftError}
          </div>
        )}
        {shiftOfflineNotice && (
          <div className="mt-2.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
            {shiftOfflineNotice}
          </div>
        )}
      </div>

      {/* Main Two-Column Calendar + Day Agenda */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Calendar Grid Card */}
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-5 lg:col-span-7 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="mb-4 flex items-center justify-between">
            <div className="relative">
              <button
                type="button"
                onClick={() => setViewMenuOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-black/[0.07] px-3 py-1.5 text-sm font-semibold hover:bg-black/[0.03] dark:border-white/[0.08]"
              >
                <span>
                  {calendarView === 'calendar' && 'Календарь'}
                  {calendarView === 'orders' && 'Заказы'}
                  {calendarView === 'tasks' && 'Быстрые задачи'}
                  {calendarView === 'shifts' && 'Смены'}
                </span>
                <ChevronDown className="h-4 w-4" />
              </button>
              {viewMenuOpen && (
                <div className="absolute left-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-black/[0.08] bg-white py-1 shadow-lg dark:border-white/[0.1] dark:bg-[#15171C]">
                  {([
                    ['calendar', 'Календарь'],
                    ['orders', 'Заказы'],
                    ['tasks', 'Быстрые задачи'],
                    ['shifts', 'Смены'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => { setCalendarView(key); setViewMenuOpen(false); }}
                      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${calendarView === key ? 'font-semibold text-[#0071E3] dark:text-[#2997FF]' : ''}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <h2 className="font-display text-base font-bold sm:text-lg">
              {MONTHS_RU[cursorMonth.getMonth()]} {cursorMonth.getFullYear()}
            </h2>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const d = new Date();
                  setCursorMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                  setSelectedDate(todayKey);
                }}
                className="rounded-xl px-2.5 py-1.5 text-xs font-semibold text-[#0071E3] hover:bg-[#0071E3]/10 dark:text-[#2997FF]"
              >
                Сегодня
              </button>
              <button
                type="button"
                onClick={() =>
                  setCursorMonth(
                    (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)
                  )
                }
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-black/[0.07] hover:bg-black/[0.03] dark:border-white/[0.08]"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setCursorMonth(
                    (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)
                  )
                }
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-black/[0.07] hover:bg-black/[0.03] dark:border-white/[0.08]"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-zinc-400">
            {WEEKDAYS.map((wd) => (
              <div key={wd} className="py-1.5">
                {wd}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((cell, idx) => {
              if (!cell.dateKey || !cell.dayNum) {
                return <div key={`empty-${idx}`} className="h-12 sm:h-14" />;
              }
              const info = dayMap.get(cell.dateKey);
              const orderCount = info?.entries.length || 0;
              const shiftCount = info?.shifts.length || 0;
              const taskCount = info?.tasks.length || 0;
              const isSelected = cell.dateKey === selectedDate;
              const isToday = cell.dateKey === todayKey;

              return (
                <button
                  key={cell.dateKey}
                  type="button"
                  onClick={() => {
                    setSelectedDate(cell.dateKey!);
                    setShowUnplanned(false);
                  }}
                  className={`relative flex h-12 flex-col items-center justify-between rounded-xl p-1.5 transition sm:h-14 ${
                    isSelected
                      ? 'bg-[#0071E3] text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]'
                      : isToday
                      ? 'border border-[#0071E3]/40 bg-[#0071E3]/[0.06] text-[#0071E3] dark:border-[#2997FF]/50 dark:text-[#2997FF]'
                      : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                  }`}
                >
                  <span className="text-xs font-semibold tabular-nums">{cell.dayNum}</span>
                  <div className="flex items-center gap-1">
                    {orderCount > 0 && (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isSelected ? 'bg-white dark:bg-[#0B0C10]' : 'bg-[#0071E3] dark:bg-[#2997FF]'
                        }`}
                      />
                    )}
                    {shiftCount > 0 && (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isSelected ? 'bg-emerald-200 dark:bg-emerald-900' : 'bg-emerald-500'
                        }`}
                      />
                    )}
                    {taskCount > 0 && <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-violet-200 dark:bg-violet-900' : 'bg-violet-500'}`} />}
                    {orderCount > 1 && (
                      <span className="text-[10px] font-bold tabular-nums opacity-85">
                        {orderCount}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] pt-3 text-xs text-zinc-500 dark:border-white/[0.08] dark:text-zinc-400">
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[#0071E3] dark:bg-[#2997FF]" />
                Заказы и выезды
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Смены в цеху
              </span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-violet-500" />Быстрые задачи</span>
            </div>

            <button
              type="button"
              onClick={() => setShowReports((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                showReports
                  ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                  : 'bg-[#F5F5F7] text-zinc-700 hover:bg-black/[0.06] dark:bg-[#0B0C10] dark:text-zinc-300'
              }`}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span>Отчёты</span>
            </button>
          </div>
        </div>

        {showReports ? (
          <ReportsView user={user} directory={directory} onOpenOrderById={onOpenOrderById} />
        ) : (
          <>
            {/* Selected Date Agenda Panel */}
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-5 lg:col-span-5 dark:border-white/[0.08] dark:bg-[#15171C]">
          {/* Mandatory "+ Добавить заказ" button positioned directly above orders */}
          {canCreateOrder && (
            <button
              type="button"
              onClick={() => onOpenCreateOrder(showUnplanned ? undefined : selectedDate)}
              className="mb-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl bg-[#0071E3] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0077ED] active:scale-[0.99] dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              <Plus className="h-4 w-4" />
              <span>Добавить заказ</span>
            </button>
          )}

          {taskLoadError && <div role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{taskLoadError}</div>}
          {(calendarView === 'calendar' || calendarView === 'tasks') && <QuickTasks user={user} directory={directory} selectedDate={selectedDate} dayTasks={showUnplanned ? [] : selectedDayData.tasks} openTaskId={openTaskId} onConsumeOpenTask={onConsumeOpenTask} onRefresh={() => void loadQuickTasks()} />}

          {cancelledWithIssues.length>0 && <section className="mb-4 space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3"><h3 className="text-sm font-semibold">Отменённые заказы: вопросы требуют решения</h3>{cancelledWithIssues.map(order=><button type="button" key={order.id} onClick={()=>onOpenOrder(order)} className="block w-full rounded-xl bg-white p-2 text-left text-sm dark:bg-[#15171C]">{order.order_number} · {order.title}</button>)}</section>}

          {showUnplanned ? (
            <div>
              <h3 className="font-display text-base font-bold">
                Незапланированные заказы
              </h3>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                Заказы и черновики без назначенной даты в календаре
              </p>

              <div className="mt-3 space-y-2.5">
                {unplannedOrders.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-black/[0.1] p-6 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
                    Все заказы распределены по датам
                  </div>
                ) : (
                  unplannedOrders.map((ord) => {
                    const meta = ORDER_STATUS_META[ord.status] || ORDER_STATUS_META.new;
                    return (
                      <button
                        key={ord.id}
                        type="button"
                        onClick={() => onOpenOrder(ord)}
                        className="w-full rounded-2xl border border-black/[0.07] bg-[#F5F5F7]/70 p-3.5 text-left transition hover:border-[#0071E3] dark:border-white/[0.08] dark:bg-[#0B0C10]"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono font-semibold text-zinc-500">
                            {ord.order_number}
                          </span>
                          <span className={`inline-flex items-center gap-1.5 font-semibold ${meta.textClass}`}>
                            <span className={`h-2 w-2 rounded-full ${meta.dotClass}`} />
                            {meta.label}
                          </span>
                        </div>
                        <div className="mt-1 font-semibold">{ord.title}</div>
                        {ord.company && (
                          <div className="mt-0.5 text-xs text-zinc-500">{ord.company.name}</div>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold tabular-nums">
                  {new Date(`${selectedDate}T12:00:00`).toLocaleDateString('ru-RU', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                </h3>
                <span className="text-xs text-zinc-400 tabular-nums">
                  {selectedDayData.entries.length} выезд. · {selectedDayData.shifts.length} смен · {selectedDayData.tasks.length} задач
                </span>
              </div>

              <div className="mt-3 space-y-2.5">
                {selectedDayData.entries.length === 0 && selectedDayData.shifts.length === 0 && selectedDayData.tasks.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-black/[0.1] p-8 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
                    На выбранный день заказов, смен и задач нет
                  </div>
                )}

                {(calendarView === 'calendar' || calendarView === 'orders') && selectedDayData.entries.map(({ order, visit, time }, idx) => {
                  const st = visit ? visit.status : order.status;
                  const meta = ORDER_STATUS_META[st] || ORDER_STATUS_META.new;
                  return (
                    <button
                      key={`${order.id}-${visit?.id || idx}`}
                      type="button"
                      onClick={() => onOpenOrder(order)}
                      className="w-full rounded-2xl border border-black/[0.07] bg-[#F5F5F7]/65 p-3.5 text-left transition hover:border-[#0071E3] dark:border-white/[0.08] dark:bg-[#0B0C10]"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5">
                          {time && (
                            <span className="font-mono font-semibold text-[#0071E3] tabular-nums dark:text-[#2997FF]">
                              {time}
                            </span>
                          )}
                          <span className="font-mono text-zinc-500">{order.order_number}</span>
                        </div>
                        <span className={`inline-flex items-center gap-1.5 font-semibold ${meta.textClass}`}>
                          <span className={`h-2 w-2 rounded-full ${meta.dotClass}`} />
                          {meta.label}
                        </span>
                      </div>

                      <div className="mt-1 font-semibold leading-snug">{order.title}</div>
                      {visit && (
                        <div className="mt-0.5 text-xs font-medium text-[#0071E3] dark:text-[#2997FF]">
                          {visit.title}
                        </div>
                      )}

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {order.address && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 shrink-0" />
                            <span className="truncate max-w-[200px]">{order.address}</span>
                          </span>
                        )}
                        {isAdmin && order.price_kopecks !== undefined && order.price_kopecks > 0 && (
                          <span className="font-semibold text-[#1D1D1F] tabular-nums dark:text-zinc-200">
                            {formatRub(order.price_kopecks)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}

                {(calendarView === 'calendar' || calendarView === 'shifts') && selectedDayData.shifts.map((sh) => (
                  <div
                    key={sh.id}
                    className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3.5 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                        Смена в цеху · {sh.employee_name || user.fullName}
                      </span>
                      <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                        {formatRub(sh.rate_snapshot_kopecks)}
                      </span>
                    </div>
                    {sh.work_done && (
                      <p className="mt-1 text-zinc-600 dark:text-zinc-300">{sh.work_done}</p>
                    )}
                    <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
                      {new Date(sh.started_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                      {sh.ended_at
                        ? ` — ${new Date(sh.ended_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                        : ' — идёт сейчас'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
            </div>
          </>
        )}
      </div>

      {/* Finish Shift Modal */}
      {finishModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleFinishShift}
            className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <h3 className="font-display text-lg font-bold">Завершение смены в цеху</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              После сохранения смена закроется, а ставка {formatRub(activeShift?.rate_snapshot_kopecks)} будет автоматически начислена в зарплату.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Выполненная работа *
                </label>
                <textarea
                  required
                  rows={3}
                  value={workDone}
                  onChange={(e) => setWorkDone(e.target.value)}
                  placeholder="Что изготовлено, сварено, раскроено или подготовлено к монтажу..."
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>

              {canTakeWarehouse && materials.length > 0 && (
                <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7]/60 p-3 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Израсходованные материалы (опц.)</span>
                    <button
                      type="button"
                      onClick={() =>
                        setShiftMaterials((prev) => [
                          ...prev,
                          { materialId: materials[0].id, qty: '1' },
                        ])
                      }
                      className="text-xs font-semibold text-[#0071E3] dark:text-[#2997FF]"
                    >
                      + Добавить материал
                    </button>
                  </div>
                  {shiftMaterials.map((sm, idx) => (
                    <div key={idx} className="mt-2 flex items-center gap-2">
                      <select
                        value={sm.materialId}
                        onChange={(e) => {
                          const next = [...shiftMaterials];
                          next[idx].materialId = e.target.value;
                          setShiftMaterials(next);
                        }}
                        className="flex-1 rounded-xl border border-black/[0.08] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                      >
                        {materials.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({formatQty(m.quantity_milli)} {m.unit})
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={sm.qty}
                        onChange={(e) => {
                          const next = [...shiftMaterials];
                          next[idx].qty = e.target.value;
                          setShiftMaterials(next);
                        }}
                        className="w-20 rounded-xl border border-black/[0.08] bg-white px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => setFinishModalOpen(false)}
                className="flex-1 rounded-2xl border border-black/[0.08] py-3 text-sm font-semibold dark:border-white/[0.1]"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={shiftBusy}
                className="flex-1 rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {shiftBusy ? 'Сохраняем...' : 'Завершить смену'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
