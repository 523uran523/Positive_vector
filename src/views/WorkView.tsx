import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  ClipboardCheck,
  Clock,
  Inbox,
  MapPin,
  Phone,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react';
import { DatePresets } from '../components/DatePresets';
import { SectionHeader } from '../components/SectionHeader';
import {
  apiRequest,
  formatDateTimeRu,
  formatQty,
  formatRub,
  ORDER_STATUS_META,
  toLocalDateKey,
} from '../lib/api';
import { getMapHref, getTelHref, toLocalDateString } from '../lib/links';
import type {
  AuthUser,
  Company,
  DirectoryUser,
  MaterialItem,
  Order,
  QuickTask,
  WorkshopShift,
} from '../types/crm';
import { CalendarView } from './CalendarView';
import { QuickTasks } from './QuickTasks';
import { ReportsView } from './ReportsView';

export type WorkSubTab = 'calendar' | 'orders' | 'tasks' | 'shifts' | 'reports';

interface WorkViewProps {
  user: AuthUser;
  workTab: WorkSubTab;
  onSelectWorkTab: (tab: WorkSubTab) => void;
  orders: Order[];
  companies: Company[];
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

function getNearestOrderDate(order: Order): string | null {
  const activeVisits = order.visits
    .filter((v) => v.status !== 'cancelled' && v.scheduled_at)
    .map((v) => v.scheduled_at)
    .sort();
  if (activeVisits.length > 0) {
    const nowIso = new Date().toISOString();
    const upcoming = activeVisits.find((d) => d >= nowIso);
    return upcoming || activeVisits[activeVisits.length - 1];
  }
  return order.scheduled_at || null;
}

export function WorkView({
  user,
  workTab,
  onSelectWorkTab,
  orders,
  companies,
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
}: WorkViewProps) {
  const isAdmin = user.role === 'admin';
  const canCreateOrder = isAdmin || user.permissions['orders.create'];
  const canTakeWarehouse = isAdmin || user.permissions['warehouse.take'];
  const [calendarDate, setCalendarDate] = useState(() => toLocalDateString(new Date()));
  const [shiftsSubMode, setShiftsSubMode] = useState<'shifts' | 'reports'>(
    workTab === 'reports' ? 'reports' : 'shifts'
  );
  const [workDropdownOpen, setWorkDropdownOpen] = useState(false);

  useEffect(() => {
    if (workTab === 'reports') setShiftsSubMode('reports');
  }, [workTab]);

  // Shared Quick Tasks state across Календарь and Быстрые задачи
  const [quickTasks, setQuickTasks] = useState<QuickTask[]>([]);
  const [taskLoadError, setTaskLoadError] = useState('');
  const loadQuickTasks = useCallback(async () => {
    try {
      const result = await apiRequest<{ tasks: QuickTask[] }>('/api/quick-tasks');
      setQuickTasks(result.tasks);
      setTaskLoadError('');
    } catch {
      setTaskLoadError('Не удалось загрузить быстрые задачи. Проверьте подключение.');
    }
  }, []);

  useEffect(() => {
    void loadQuickTasks();
    const onSynced = () => void loadQuickTasks();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void loadQuickTasks();
    }, 30_000);
    window.addEventListener('pv:offline-synced', onSynced);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pv:offline-synced', onSynced);
    };
  }, [loadQuickTasks]);

  // Live timer & Finish Shift modal (accessible both from quick bar & Смены tab)
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

  // Orders Tab Filters
  const [orderSearch, setOrderSearch] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all');
  const [orderUserFilter, setOrderUserFilter] = useState('');
  const [orderClientFilter, setOrderClientFilter] = useState('');
  const [orderFromDate, setOrderFromDate] = useState('');
  const [orderToDate, setOrderToDate] = useState('');
  const [orderQuickFilter, setOrderQuickFilter] = useState<'all' | 'today' | 'mine' | 'debt'>('all');

  const unplannedOrders = useMemo(
    () => orders.filter((o) => !o.scheduled_at && o.visits.length === 0 && o.status !== 'cancelled'),
    [orders]
  );

  const cancelledWithIssues = useMemo(
    () =>
      isAdmin
        ? orders.filter((order) => {
            const issues = order.cancellationIssues;
            if (order.status !== 'cancelled' || !issues) return false;
            return (
              issues.materials.length > 0 ||
              issues.tools.length > 0 ||
              Boolean(
                issues.paymentsKopecks &&
                  !issues.reviews.some((review) => review.issue_key === 'payments')
              ) ||
              Boolean(
                issues.accrualsKopecks &&
                  !issues.reviews.some((review) => review.issue_key === 'accruals')
              )
            );
          })
        : [],
    [isAdmin, orders]
  );

  const filteredOrders = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    const todayKey = toLocalDateString(new Date());
    return orders.filter((ord) => {
      if (orderStatusFilter !== 'all' && ord.status !== orderStatusFilter) return false;
      if (orderClientFilter && ord.company_id !== orderClientFilter) return false;
      if (orderUserFilter) {
        const hasAssignee =
          ord.assignees.some((a) => a.id === orderUserFilter) ||
          ord.visits.some((v) => v.assignees?.some((a) => a.id === orderUserFilter));
        if (!hasAssignee) return false;
      }
      if (orderQuickFilter === 'today') {
        const dates = [
          toLocalDateKey(ord.scheduled_at),
          ...ord.visits.filter((v) => v.status !== 'cancelled').map((v) => toLocalDateKey(v.scheduled_at)),
        ].filter(Boolean) as string[];
        if (!dates.includes(todayKey)) return false;
      } else if (orderQuickFilter === 'mine') {
        const mine =
          ord.assignees.some((a) => a.id === user.id) ||
          ord.visits.some((v) => v.assignees?.some((a) => a.id === user.id));
        if (!mine || ord.status === 'completed' || ord.status === 'cancelled') return false;
      } else if (orderQuickFilter === 'debt') {
        const debt = Math.max(0, Number(ord.price_kopecks || 0) - Number(ord.paid_kopecks || 0));
        if (debt <= 0 || ord.status === 'cancelled') return false;
      }
      if (orderFromDate || orderToDate) {
        const dates = [
          toLocalDateKey(ord.scheduled_at),
          ...ord.visits.filter((v) => v.status !== 'cancelled').map((v) => toLocalDateKey(v.scheduled_at)),
        ].filter(Boolean) as string[];
        if (dates.length === 0) return false;
        const matchesRange = dates.some(
          (d) => (!orderFromDate || d >= orderFromDate) && (!orderToDate || d <= orderToDate)
        );
        if (!matchesRange) return false;
      }
      if (q) {
        const hay = [
          ord.order_number,
          ord.title,
          ord.address,
          ord.company?.name,
          ord.contact?.full_name,
          ...ord.assignees.map((a) => a.full_name),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, orderSearch, orderStatusFilter, orderUserFilter, orderClientFilter, orderFromDate, orderToDate, orderQuickFilter, user.id]);

  const scheduledFilteredOrders = useMemo(
    () =>
      filteredOrders.filter(
        (o) => Boolean(o.scheduled_at) || o.visits.length > 0 || o.status === 'cancelled'
      ),
    [filteredOrders]
  );

  const unplannedFilteredOrders = useMemo(
    () =>
      filteredOrders.filter(
        (o) => !o.scheduled_at && o.visits.length === 0 && o.status !== 'cancelled'
      ),
    [filteredOrders]
  );

  const openTasksCount = quickTasks.filter((t) => t.status === 'open').length;
  const hasOrderFilters = Boolean(
    orderSearch.trim() ||
      orderStatusFilter !== 'all' ||
      orderUserFilter ||
      orderClientFilter ||
      orderFromDate ||
      orderToDate ||
      orderQuickFilter !== 'all'
  );

  return (
    <div className="space-y-4">
      <SectionHeader<WorkSubTab>
        title="Работа"
        description="Планирование выездов, заказы, быстрые задачи, смены в цеху и отчёты"
        actions={
          <>
            {activeShift ? (
              <button
                type="button"
                onClick={() => setFinishModalOpen(true)}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-red-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-red-700"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Завершить смену ({elapsedText || 'идёт'})</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={shiftBusy}
                onClick={() => void handleStartShift()}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/15 disabled:opacity-50 dark:text-emerald-300"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Начать смену</span>
              </button>
            )}
            {canCreateOrder && (
              <button
                type="button"
                onClick={() => onOpenCreateOrder(workTab === 'calendar' ? calendarDate : undefined)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#0077ED] dark:bg-[#2997FF] dark:text-[#0B0C10]"
              >
                <Plus className="h-4 w-4" />
                <span>Новый заказ</span>
              </button>
            )}
            {/* Кнопка календаря с выпадающим меню подразделов "Работа" (для монтажников и админа) */}
            <div className="relative inline-block">
              <button
                type="button"
                onClick={() => setWorkDropdownOpen(!workDropdownOpen)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3.5 py-2 text-xs font-semibold hover:bg-black/[0.04] dark:border-white/[0.1] dark:bg-[#0B0C10] dark:hover:bg-white/[0.06]"
                aria-expanded={workDropdownOpen}
                aria-haspopup="true"
                aria-label="Подразделы Работа"
              >
                <CalendarDays className="h-4 w-4" />
                <span>Работа</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${workDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {workDropdownOpen && (
                <div
                  className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-52 rounded-xl border border-black/[0.08] bg-white shadow-xl p-1 animate-[slide-down_150ms_ease-out] dark:border-white/[0.1] dark:bg-[#15171C]"
                  role="menu"
                  aria-label="Подразделы Работа"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectWorkTab('orders');
                      setWorkDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  >
                    <Briefcase className="h-4 w-4 shrink-0" />
                    <span>Заказы</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectWorkTab('tasks');
                      setWorkDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  >
                    <CheckSquare className="h-4 w-4 shrink-0" />
                    <span>Быстрые задачи</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShiftsSubMode('shifts');
                      onSelectWorkTab('shifts');
                      setWorkDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  >
                    <Wrench className="h-4 w-4 shrink-0" />
                    <span>Смены</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectWorkTab('reports');
                      setWorkDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  >
                    <ClipboardCheck className="h-4 w-4 shrink-0" />
                    <span>Отчёты</span>
                  </button>
                </div>
              )}
            </div>
          </>
        }
        tabs={undefined}
        activeTab={workTab === 'reports' ? 'shifts' : workTab}
        onSelectTab={(nextTab) => {
          if (nextTab === 'shifts') setShiftsSubMode('shifts');
          onSelectWorkTab(nextTab);
        }}
        tabsAriaLabel="Подразделы работы"
      />

      {shiftError && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {shiftError}
        </div>
      )}
      {shiftOfflineNotice && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          {shiftOfflineNotice}
        </div>
      )}

      {workTab === 'calendar' && (
        <CalendarView
          user={user}
          orders={orders}
          shifts={shifts}
          quickTasks={quickTasks}
          taskLoadError={taskLoadError}
          directory={directory}
          openTaskId={openTaskId}
          onConsumeOpenTask={onConsumeOpenTask}
          onRefreshQuickTasks={() => void loadQuickTasks()}
          onSelectedDateChange={setCalendarDate}
          onOpenUnplannedOrders={() => onSelectWorkTab('orders')}
          onOpenOrder={onOpenOrder}
          onOpenOrderById={onOpenOrderById}
        />
      )}

      {workTab === 'orders' && (
        <div className="space-y-4">
          {/* Orders Search & Filters */}
          <div className="space-y-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'all', label: 'Все заказы' },
                  { id: 'today', label: 'Сегодня' },
                  { id: 'mine', label: 'Мои активные' },
                  ...(isAdmin ? [{ id: 'debt', label: 'С долгом' }] : []),
                ].map((chip) => {
                  const active = orderQuickFilter === chip.id;
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() =>
                        setOrderQuickFilter(
                          active && chip.id !== 'all' ? 'all' : (chip.id as typeof orderQuickFilter)
                        )
                      }
                      className={`min-h-[32px] rounded-xl px-3 py-1 text-xs font-semibold transition ${
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
              <DatePresets
                from={orderFromDate}
                to={orderToDate}
                onChange={(f, t) => {
                  setOrderFromDate(f);
                  setOrderToDate(t);
                }}
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6">
              <div className="relative sm:col-span-2">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  placeholder="Поиск по номеру, названию, адресу, клиенту..."
                  className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-2 pl-8 pr-3 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10] dark:focus:bg-[#0B0C10]"
                />
              </div>

              <select
                aria-label="Статус заказа"
                value={orderStatusFilter}
                onChange={(e) => setOrderStatusFilter(e.target.value)}
                className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              >
                <option value="all">Все статусы</option>
                <option value="new">Новый</option>
                <option value="in_progress">В работе</option>
                <option value="completed">Завершён</option>
                <option value="cancelled">Отменён</option>
              </select>

              <select
                aria-label="Фильтр по исполнителю"
                value={orderUserFilter}
                onChange={(e) => setOrderUserFilter(e.target.value)}
                className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              >
                <option value="">Все исполнители</option>
                {directory.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName}
                  </option>
                ))}
              </select>

              {companies.length > 0 && (
                <select
                  aria-label="Фильтр по клиенту"
                  value={orderClientFilter}
                  onChange={(e) => setOrderClientFilter(e.target.value)}
                  className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  <option value="">Все клиенты</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}

              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  aria-label="Дата с"
                  value={orderFromDate}
                  onChange={(e) => setOrderFromDate(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                />
                <input
                  type="date"
                  aria-label="Дата по"
                  value={orderToDate}
                  onChange={(e) => setOrderToDate(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                />
                {hasOrderFilters && (
                  <button
                    type="button"
                    title="Сбросить фильтры"
                    onClick={() => {
                      setOrderSearch('');
                      setOrderStatusFilter('all');
                      setOrderUserFilter('');
                      setOrderClientFilter('');
                      setOrderFromDate('');
                      setOrderToDate('');
                      setOrderQuickFilter('all');
                    }}
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.08] px-2.5 text-xs text-zinc-600 hover:bg-black/[0.04] dark:border-white/[0.1] dark:text-zinc-300"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Cancelled orders needing admin review */}
          {cancelledWithIssues.length > 0 && (
            <section className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <h3 className="text-xs font-bold text-amber-800 dark:text-amber-300">
                Отменённые заказы: вопросы требуют решения ({cancelledWithIssues.length})
              </h3>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {cancelledWithIssues.map((order) => (
                  <button
                    type="button"
                    key={order.id}
                    onClick={() => onOpenOrder(order)}
                    className="rounded-xl bg-white p-3 text-left text-xs font-semibold shadow-2xs hover:text-[#0071E3] dark:bg-[#15171C]"
                  >
                    <span className="font-mono text-zinc-500">{order.order_number}</span> · {order.title}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Separate Unplanned / Draft Orders Section */}
          {(unplannedFilteredOrders.length > 0 || (!hasOrderFilters && unplannedOrders.length > 0)) && (
            <section className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.05] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <h3 className="font-display text-sm font-bold">
                    Незапланированные заказы и черновики ({unplannedFilteredOrders.length})
                  </h3>
                </div>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Без даты выезда в календаре
                </span>
              </div>

              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                {unplannedFilteredOrders.map((ord) => {
                  const meta = ORDER_STATUS_META[ord.status] || ORDER_STATUS_META.new;
                  const clientName = ord.company?.name || ord.contact?.full_name || 'Клиент не указан';
                  const assigneeNames = ord.assignees.map((a) => a.full_name).join(', ');
                  return (
                    <button
                      key={ord.id}
                      type="button"
                      onClick={() => onOpenOrder(ord)}
                      className="rounded-2xl border border-black/[0.07] bg-white p-3.5 text-left transition hover:border-[#0071E3] dark:border-white/[0.08] dark:bg-[#15171C]"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-bold text-zinc-500">{ord.order_number}</span>
                        <span className={`font-semibold ${meta.textClass}`}>{meta.label}</span>
                      </div>
                      <div className="mt-1 font-display text-sm font-bold">{ord.title}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                        <span>{clientName}</span>
                        {assigneeNames && (
                          <span className="inline-flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            {assigneeNames}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Main Scheduled Orders List */}
          <div className="space-y-2.5">
            {scheduledFilteredOrders.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
                {filteredOrders.length === 0
                  ? 'Заказы по выбранным фильтрам не найдены'
                  : 'Запланированных заказов в выборке нет (смотрите блок выше)'}
              </div>
            ) : (
              scheduledFilteredOrders.map((ord) => {
                const meta = ORDER_STATUS_META[ord.status] || ORDER_STATUS_META.new;
                const nearestDate = getNearestOrderDate(ord);
                const clientName = ord.company?.name || ord.contact?.full_name || 'Клиент не указан';
                const assigneeNames = ord.assignees.map((a) => a.full_name).join(', ');
                const telPhone = ord.site_contact_phone || ord.contact?.phone || ord.company?.phone;
                const telHref = getTelHref(telPhone);
                const mapHref = getMapHref(ord.address);
                return (
                  <div
                    key={ord.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenOrder(ord)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenOrder(ord);
                      }
                    }}
                    className="w-full cursor-pointer rounded-2xl border border-black/[0.06] bg-white p-4 text-left shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition hover:border-[#0071E3] dark:border-white/[0.08] dark:bg-[#15171C]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md bg-[#F5F5F7] px-2 py-0.5 font-mono text-xs font-bold text-zinc-600 dark:bg-[#0B0C10] dark:text-zinc-300">
                          {ord.order_number}
                        </span>
                        <span className="font-display text-sm font-bold sm:text-base">{ord.title}</span>
                      </div>
                      <span className={`text-xs font-semibold ${meta.textClass}`}>{meta.label}</span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="font-medium text-[#1D1D1F] dark:text-zinc-200">{clientName}</span>
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <CalendarDays className="h-3.5 w-3.5 text-[#0071E3] dark:text-[#2997FF]" />
                        {nearestDate ? formatDateTimeRu(nearestDate) : 'Дата не задана'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {assigneeNames || 'Исполнители не назначены'}
                      </span>
                      {ord.address && (
                        mapHref ? (
                          <a
                            href={mapHref}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Открыть на карте"
                            className="inline-flex items-center gap-1 hover:text-[#0071E3] hover:underline dark:hover:text-[#2997FF]"
                          >
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-[#0071E3] dark:text-[#2997FF]" />
                            <span className="max-w-[220px] truncate">{ord.address}</span>
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5 shrink-0" />
                            <span className="max-w-[220px] truncate">{ord.address}</span>
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
                          <Phone className="h-3.5 w-3.5 shrink-0" />
                          <span>{telPhone}</span>
                        </a>
                      )}
                      {isAdmin && ord.price_kopecks !== undefined && ord.price_kopecks > 0 && (
                        <span className="ml-auto font-bold text-[#1D1D1F] tabular-nums dark:text-white">
                          {formatRub(ord.price_kopecks)}
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

      {workTab === 'tasks' && (
        <>
          {taskLoadError && (
            <div role="alert" className="rounded-2xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
              {taskLoadError}
            </div>
          )}
          <QuickTasks
            mode="standalone"
            user={user}
            directory={directory}
            orders={orders}
            tasks={quickTasks}
            openTaskId={openTaskId}
            onConsumeOpenTask={onConsumeOpenTask}
            onRefresh={() => void loadQuickTasks()}
            onOpenOrderById={onOpenOrderById}
          />
        </>
      )}

      {(workTab === 'shifts' || workTab === 'reports') && (
        <div className="space-y-4">
          <div className="inline-flex rounded-xl border border-black/[0.06] bg-white p-1 dark:border-white/[0.08] dark:bg-[#15171C]">
            <button
              type="button"
              onClick={() => setShiftsSubMode('shifts')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                shiftsSubMode === 'shifts'
                  ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                  : 'text-zinc-600 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]'
              }`}
            >
              <Wrench className="h-3.5 w-3.5" />
              <span>Смены в цеху ({shifts.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setShiftsSubMode('reports')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                shiftsSubMode === 'reports'
                  ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                  : 'text-zinc-600 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]'
              }`}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span>Отчёты</span>
            </button>
          </div>

          {shiftsSubMode === 'shifts' ? (
            <>
              {/* Active Shift Card */}
              <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                  <div>
                    <div className="flex items-center gap-2">
                      <Wrench className="h-4 w-4 text-[#0071E3] dark:text-[#2997FF]" />
                      <h3 className="font-display text-base font-bold">Текущая смена в цеху</h3>
                      {activeShift && (
                        <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                          Смена идёт
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {activeShift
                        ? `Начата в ${formatDateTimeRu(activeShift.started_at)} · Ставка ${formatRub(activeShift.rate_snapshot_kopecks)}`
                        : `Фиксированная ставка смены: ${formatRub(user.shiftRateKopecks)} · Время фиксируется сервером`}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {activeShift && (
                      <div className="flex items-center gap-1.5 font-mono text-lg font-bold text-[#1D1D1F] tabular-nums dark:text-white">
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
              </div>

              {/* Shift History */}
              <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
                <h3 className="mb-3 font-display text-base font-bold">История смен ({shifts.length})</h3>
                {shifts.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-black/[0.1] p-8 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
                    Отработанных смен пока нет
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {shifts.map((sh) => {
                      const mins = sh.ended_at
                        ? Math.max(
                            1,
                            Math.round((Date.parse(sh.ended_at) - Date.parse(sh.started_at)) / 60_000)
                          )
                        : 0;
                      return (
                        <div
                          key={sh.id}
                          className="rounded-xl border border-black/[0.06] bg-[#F5F5F7]/50 p-3.5 text-xs dark:border-white/[0.08] dark:bg-[#0B0C10]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="font-semibold text-[#1D1D1F] dark:text-white">
                                {sh.employee_name || user.fullName}
                                <span className="ml-2 font-normal text-zinc-500 tabular-nums">
                                  {formatDateTimeRu(sh.started_at)}
                                  {sh.ended_at
                                    ? ` → ${new Date(sh.ended_at).toLocaleTimeString('ru-RU', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })} (${Math.floor(mins / 60)} ч ${mins % 60} мин)`
                                    : ' · активная смена'}
                                </span>
                              </div>
                            </div>
                            <div className="font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                              {formatRub(sh.rate_snapshot_kopecks)}
                            </div>
                          </div>
                          {sh.work_done && (
                            <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">
                              {sh.work_done}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <ReportsView
              user={user}
              directory={directory}
              orders={orders}
              onOpenOrderById={onOpenOrderById}
            />
          )}
        </div>
      )}

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
                        className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
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
                        className="w-20 shrink-0 rounded-xl border border-black/[0.08] bg-white px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                      />
                      <button
                        type="button"
                        aria-label="Убрать материал"
                        title="Убрать материал"
                        onClick={() => setShiftMaterials((prev) => prev.filter((_, i) => i !== idx))}
                        className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-500/10 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
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
