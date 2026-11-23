import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  MapPin,
  Phone,
  Play,
} from 'lucide-react';
import {
  formatDuration,
  formatRub,
  formatTimeRu,
  ORDER_STATUS_META,
  toLocalDateKey,
} from '../lib/api';
import { getMapHref, getTelHref } from '../lib/links';
import type {
  AuthUser,
  DirectoryUser,
  Order,
  OrderVisit,
  QuickTask,
  WorkshopShift,
} from '../types/crm';
import { QuickTasks } from './QuickTasks';

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
  quickTasks: QuickTask[];
  taskLoadError?: string;
  directory: DirectoryUser[];
  openTaskId: string | null;
  onConsumeOpenTask: () => void;
  onRefreshQuickTasks: () => void;
  onSelectedDateChange?: (date: string) => void;
  onOpenUnplannedOrders?: () => void;
  onOpenOrder: (order: Order) => void;
  onOpenOrderById?: (orderId: string) => void;
  hasActiveShift?: boolean;
  onStartShiftForTarget?: (target: {
    targetType: 'workshop' | 'visit' | 'quick_task';
    orderId?: string | null;
    visitId?: string | null;
    quickTaskId?: string | null;
  }) => void;
  onShiftChanged?: () => void;
}

export function CalendarView({
  user,
  orders,
  shifts,
  quickTasks,
  taskLoadError,
  directory,
  openTaskId,
  onConsumeOpenTask,
  onRefreshQuickTasks,
  onSelectedDateChange,
  onOpenUnplannedOrders,
  onOpenOrder,
  onOpenOrderById,
  hasActiveShift = false,
  onStartShiftForTarget,
  onShiftChanged,
}: CalendarViewProps) {
  const isAdmin = user.role === 'admin';

  const localNow = new Date();
  const todayKey = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [cursorMonth, setCursorMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const handleSelectDate = (dateKey: string) => {
    setSelectedDate(dateKey);
    onSelectedDateChange?.(dateKey);
  };

  // Map dateKey -> day items (visits or top-level orders without visits), shifts, quick tasks
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

    for (const task of quickTasks) {
      if (task.due_date) ensure(task.due_date).tasks.push(task);
    }

    return map;
  }, [orders, shifts, quickTasks]);

  const unplannedOrders = useMemo(
    () => orders.filter((o) => !o.scheduled_at && o.visits.length === 0 && o.status !== 'cancelled'),
    [orders]
  );

  const undatedOpenTasks = useMemo(
    () => quickTasks.filter((t) => !t.due_date && t.status === 'open'),
    [quickTasks]
  );

  const cancelledWithIssues = isAdmin
    ? orders.filter((order) => {
        const issues = order.cancellationIssues;
        if (order.status !== 'cancelled' || !issues) return false;
        return (
          issues.materials.length > 0 ||
          issues.tools.length > 0 ||
          Boolean(issues.paymentsKopecks && !issues.reviews.some((review) => review.issue_key === 'payments')) ||
          Boolean(issues.accrualsKopecks && !issues.reviews.some((review) => review.issue_key === 'accruals'))
        );
      })
    : [];

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
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      {/* Calendar Grid Card */}
      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-5 lg:col-span-7 dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-base font-bold sm:text-lg">
            {MONTHS_RU[cursorMonth.getMonth()]} {cursorMonth.getFullYear()}
          </h3>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                const d = new Date();
                setCursorMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                handleSelectDate(todayKey);
              }}
              className="rounded-xl px-2.5 py-1.5 text-xs font-semibold text-[#0071E3] hover:bg-[#0071E3]/10 dark:text-[#2997FF]"
            >
              Сегодня
            </button>
            <button
              type="button"
              aria-label="Предыдущий месяц"
              onClick={() =>
                setCursorMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
              }
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-black/[0.07] hover:bg-black/[0.03] dark:border-white/[0.08]"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Следующий месяц"
              onClick={() =>
                setCursorMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
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
              return <div key={`empty-${idx}`} className="min-h-[58px] sm:min-h-[68px]" />;
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
                onClick={() => handleSelectDate(cell.dateKey!)}
                className={`relative flex min-h-[58px] flex-col items-start justify-between rounded-xl p-1.5 text-left transition sm:min-h-[68px] ${
                  isSelected
                    ? 'bg-[#0071E3] text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]'
                    : isToday
                      ? 'border border-[#0071E3]/40 bg-[#0071E3]/[0.06] text-[#0071E3] dark:border-[#2997FF]/50 dark:text-[#2997FF]'
                      : 'border border-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                }`}
              >
                <span className="self-end text-xs font-bold tabular-nums">{cell.dayNum}</span>
                <div className="flex w-full flex-col gap-0.5 text-[9px] font-semibold leading-tight tabular-nums sm:text-[10px]">
                  {orderCount > 0 && (
                    <span
                      className={`truncate rounded px-1 py-0.5 ${
                        isSelected
                          ? 'bg-white/20 text-white dark:bg-[#0B0C10]/15 dark:text-[#0B0C10]'
                          : 'bg-[#0071E3]/12 text-[#0071E3] dark:bg-[#2997FF]/15 dark:text-[#2997FF]'
                      }`}
                    >
                      <span className="sm:hidden">В:{orderCount}</span>
                      <span className="hidden sm:inline">Выезд · {orderCount}</span>
                    </span>
                  )}
                  {shiftCount > 0 && (
                    <span
                      className={`truncate rounded px-1 py-0.5 ${
                        isSelected
                          ? 'bg-white/20 text-white dark:bg-[#0B0C10]/15 dark:text-[#0B0C10]'
                          : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      }`}
                    >
                      <span className="sm:hidden">С:{shiftCount}</span>
                      <span className="hidden sm:inline">Смена · {shiftCount}</span>
                    </span>
                  )}
                  {taskCount > 0 && (
                    <span
                      className={`truncate rounded px-1 py-0.5 ${
                        isSelected
                          ? 'bg-white/20 text-white dark:bg-[#0B0C10]/15 dark:text-[#0B0C10]'
                          : 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                      }`}
                    >
                      <span className="sm:hidden">З:{taskCount}</span>
                      <span className="hidden sm:inline">Задача · {taskCount}</span>
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] pt-3 text-xs text-zinc-600 dark:border-white/[0.08] dark:text-zinc-300">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1 rounded-md bg-[#0071E3]/10 px-2 py-0.5 font-semibold text-[#0071E3] dark:text-[#2997FF]">
              В — Выезды и монтажи
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-2 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300">
              С — Смены в цеху
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-violet-500/12 px-2 py-0.5 font-semibold text-violet-700 dark:text-violet-300">
              З — Быстрые задачи
            </span>
          </div>

          {unplannedOrders.length > 0 && onOpenUnplannedOrders && (
            <button
              type="button"
              onClick={onOpenUnplannedOrders}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/12 px-3 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-500/20 dark:text-amber-300"
            >
              <Inbox className="h-3.5 w-3.5" />
              <span>Без даты: {unplannedOrders.length} →</span>
            </button>
          )}
        </div>
      </div>

      {/* Selected Date Agenda Panel */}
      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-5 lg:col-span-5 dark:border-white/[0.08] dark:bg-[#15171C]">
        {taskLoadError && (
          <div role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
            {taskLoadError}
          </div>
        )}

        <QuickTasks
          user={user}
          directory={directory}
          orders={orders}
          selectedDate={selectedDate}
          dayTasks={selectedDayData.tasks}
          undatedTasks={undatedOpenTasks}
          openTaskId={openTaskId}
          onConsumeOpenTask={onConsumeOpenTask}
          onRefresh={onRefreshQuickTasks}
          onOpenOrderById={onOpenOrderById}
          onShiftChanged={onShiftChanged}
        />

        {cancelledWithIssues.length > 0 && (
          <section className="mb-4 space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
            <h4 className="text-xs font-bold text-amber-800 dark:text-amber-300">
              Отменённые заказы: вопросы требуют решения
            </h4>
            {cancelledWithIssues.map((order) => (
              <button
                type="button"
                key={order.id}
                onClick={() => onOpenOrder(order)}
                className="block w-full rounded-xl bg-white p-2 text-left text-xs font-semibold hover:text-[#0071E3] dark:bg-[#15171C]"
              >
                {order.order_number} · {order.title}
              </button>
            ))}
          </section>
        )}

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-display text-base font-bold capitalize tabular-nums">
              {new Date(`${selectedDate}T12:00:00`).toLocaleDateString('ru-RU', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </h4>
            <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
              Выезды: {selectedDayData.entries.length} · Смены: {selectedDayData.shifts.length} · Задачи: {selectedDayData.tasks.length}
            </span>
          </div>

            <div className="mt-3 space-y-2.5">
              {selectedDayData.entries.length === 0 &&
                selectedDayData.shifts.length === 0 &&
                selectedDayData.tasks.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-black/[0.1] p-8 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
                    На выбранный день выездов, смен и задач нет
                  </div>
                )}

              {selectedDayData.entries.map(({ order, visit, time }, idx) => {
                const st = visit ? visit.status : order.status;
                const meta = ORDER_STATUS_META[st] || ORDER_STATUS_META.new;
                const telPhone = order.site_contact_phone || order.contact?.phone || order.company?.phone;
                const telHref = getTelHref(telPhone);
                const mapHref = getMapHref(order.address);
                return (
                  <div
                    key={`${order.id}-${visit?.id || idx}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenOrder(order)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenOrder(order);
                      }
                    }}
                    className="w-full cursor-pointer rounded-2xl border border-black/[0.07] bg-[#F5F5F7]/65 p-3.5 text-left transition hover:border-[#0071E3] dark:border-white/[0.08] dark:bg-[#0B0C10]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded-md bg-[#0071E3]/12 px-1.5 py-0.5 text-[10px] font-bold text-[#0071E3] dark:text-[#2997FF]">
                          {visit ? 'Выезд' : 'Заказ'}
                        </span>
                        {time && (
                          <span className="font-mono font-semibold text-[#0071E3] tabular-nums dark:text-[#2997FF]">
                            {time}
                          </span>
                        )}
                        <span className="font-mono text-zinc-500">{order.order_number}</span>
                      </div>
                      <span className={`font-semibold ${meta.textClass}`}>{meta.label}</span>
                    </div>

                    <div className="mt-1 font-semibold leading-snug">{order.title}</div>
                    {visit && (
                      <div className="mt-0.5 text-xs font-medium text-[#0071E3] dark:text-[#2997FF]">
                        {visit.title}
                      </div>
                    )}

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {order.address && (
                        mapHref ? (
                          <a
                            href={mapHref}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Открыть адрес на карте"
                            className="inline-flex items-center gap-1 hover:text-[#0071E3] hover:underline dark:hover:text-[#2997FF]"
                          >
                            <MapPin className="h-3 w-3 shrink-0 text-[#0071E3] dark:text-[#2997FF]" />
                            <span className="max-w-[200px] truncate">{order.address}</span>
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 shrink-0" />
                            <span className="max-w-[200px] truncate">{order.address}</span>
                          </span>
                        )
                      )}
                      {telHref && telPhone && (
                        <a
                          href={telHref}
                          onClick={(e) => e.stopPropagation()}
                          title="Позвонить"
                          className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                        >
                          <Phone className="h-3 w-3 shrink-0" />
                          <span>{telPhone}</span>
                        </a>
                      )}
                      {isAdmin && order.price_kopecks !== undefined && order.price_kopecks > 0 && (
                        <span className="font-semibold text-[#1D1D1F] tabular-nums dark:text-zinc-200">
                          {formatRub(order.price_kopecks)}
                        </span>
                      )}
                    </div>
                    {selectedDate === todayKey &&
                      !hasActiveShift &&
                      onStartShiftForTarget &&
                      st !== 'completed' &&
                      st !== 'cancelled' &&
                      order.status !== 'completed' &&
                      order.status !== 'cancelled' && (
                        <div className="mt-2 pt-2 border-t border-black/[0.05] dark:border-white/[0.06]">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onStartShiftForTarget({
                                targetType: 'visit',
                                orderId: order.id,
                                visitId: visit?.id || null,
                              });
                            }}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600/12 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-600/20 dark:text-emerald-300"
                          >
                            <Play className="h-3 w-3 fill-current" />
                            <span>Начать смену по выезду</span>
                          </button>
                        </div>
                      )}
                  </div>
                );
              })}

              {selectedDayData.shifts.map((sh) => {
                const targetLabel =
                  sh.shift_type === 'visit'
                    ? `Монтаж ${sh.order_number || ''}${sh.visit_title ? ` · ${sh.visit_title}` : ''}`.trim()
                    : sh.shift_type === 'quick_task'
                      ? `Задача: ${sh.quick_task_title || 'Быстрая задача'}`
                      : 'Цех';
                const mins =
                  sh.duration_minutes ??
                  (sh.ended_at
                    ? Math.max(0, Math.round((Date.parse(sh.ended_at) - Date.parse(sh.started_at)) / 60_000))
                    : null);
                return (
                  <div
                    key={sh.id}
                    className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                          {targetLabel}
                        </span>
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                          {sh.employee_name || user.fullName}
                        </span>
                      </div>
                      <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                        {sh.wage_kopecks != null
                          ? formatRub(sh.wage_kopecks)
                          : mins != null
                            ? formatDuration(mins)
                            : 'Учёт времени'}
                      </span>
                    </div>
                    {sh.work_done && (
                      <p className="mt-1 text-zinc-700 dark:text-zinc-200">{sh.work_done}</p>
                    )}
                    <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
                      {new Date(sh.started_at).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {sh.ended_at
                        ? ` — ${new Date(sh.ended_at).toLocaleTimeString('ru-RU', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}`
                        : ' — идёт сейчас'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
      </div>
    </div>
  );
}
