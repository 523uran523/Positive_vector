import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  X,
} from 'lucide-react';
import { DatePresets } from '../components/DatePresets';
import { SectionHeader } from '../components/SectionHeader';
import {
  apiRequest,
  formatDateTimeRu,
  formatDuration,
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
  ShiftEditRequest,
  ShiftTargetType,
  ShiftTodayOptions,
  WorkshopShift,
} from '../types/crm';
import { CalendarView } from './CalendarView';
import { QuickTaskModal, QuickTasks } from './QuickTasks';
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

function shiftTargetLabel(sh: {
  shift_type?: string;
  order_number?: string | null;
  order_title?: string | null;
  visit_title?: string | null;
  quick_task_title?: string | null;
}): string {
  if (sh.shift_type === 'visit') {
    const num = sh.order_number ? `${sh.order_number}` : '';
    const title = sh.visit_title || sh.order_title || '';
    return ['Монтаж', num, title].filter(Boolean).join(' · ');
  }
  if (sh.shift_type === 'quick_task') {
    return `Задача: ${sh.quick_task_title || 'Быстрая задача'}`;
  }
  return 'Смена в цеху';
}

function toLocalHmInput(iso: string | null | undefined): string {
  if (!iso) return '09:00';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '09:00';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  const [addTaskDropdownOpen, setAddTaskDropdownOpen] = useState(false);
  const [headerTaskCreating, setHeaderTaskCreating] = useState(false);
  const [headerTask, setHeaderTask] = useState<QuickTask | null>(null);
  const workDropdownRef = useRef<HTMLDivElement | null>(null);
  const addTaskDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!workDropdownOpen && !addTaskDropdownOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (workDropdownRef.current && !workDropdownRef.current.contains(target)) {
        setWorkDropdownOpen(false);
      }
      if (addTaskDropdownRef.current && !addTaskDropdownRef.current.contains(target)) {
        setAddTaskDropdownOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWorkDropdownOpen(false);
        setAddTaskDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [workDropdownOpen, addTaskDropdownOpen]);

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
  const [completeQuickTaskOnFinish, setCompleteQuickTaskOnFinish] = useState(true);
  const [shiftMaterials, setShiftMaterials] = useState<Array<{ materialId: string; qty: string }>>([]);
  const [shiftBusy, setShiftBusy] = useState(false);
  const [shiftError, setShiftError] = useState('');
  const [shiftOfflineNotice, setShiftOfflineNotice] = useState('');

  // Unified shift target picker, same-day backfill, edit requests, admin time editor
  const [todayOptions, setTodayOptions] = useState<ShiftTodayOptions | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sameDayModalOpen, setSameDayModalOpen] = useState(false);
  const [sameDayTargetKey, setSameDayTargetKey] = useState('workshop');
  const [sameDayStart, setSameDayStart] = useState('09:00');
  const [sameDayEnd, setSameDayEnd] = useState('18:00');
  const [sameDayWorkDone, setSameDayWorkDone] = useState('');

  const [editRequests, setEditRequests] = useState<ShiftEditRequest[]>([]);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [requestShift, setRequestShift] = useState<WorkshopShift | null>(null);
  const [reqDate, setReqDate] = useState(() => toLocalDateString(new Date()));
  const [reqStart, setReqStart] = useState('09:00');
  const [reqEnd, setReqEnd] = useState('18:00');
  const [reqWorkDone, setReqWorkDone] = useState('');
  const [reqReason, setReqReason] = useState('');

  const [adminEditShift, setAdminEditShift] = useState<WorkshopShift | null>(null);
  const [adminEditDate, setAdminEditDate] = useState('');
  const [adminEditStart, setAdminEditStart] = useState('');
  const [adminEditEnd, setAdminEditEnd] = useState('');
  const [adminEditWorkDone, setAdminEditWorkDone] = useState('');
  const [adminReviewComments, setAdminReviewComments] = useState<Record<string, string>>({});

  const loadTodayOptions = useCallback(async () => {
    try {
      const tzOffsetMinutes = new Date().getTimezoneOffset();
      const res = await apiRequest<ShiftTodayOptions>(
        `/api/shifts/today-options?tzOffsetMinutes=${tzOffsetMinutes}`,
        { useCache: false, skipOfflineQueue: true }
      );
      setTodayOptions(res);
      return res;
    } catch {
      return null;
    }
  }, []);

  const loadEditRequests = useCallback(async () => {
    try {
      const res = await apiRequest<{ requests: ShiftEditRequest[] }>('/api/shifts/edit-requests', {
        useCache: false,
      });
      setEditRequests(res.requests);
    } catch {
      // ignore offline
    }
  }, []);

  useEffect(() => {
    if (workTab === 'shifts' || workTab === 'calendar') {
      void loadTodayOptions();
    }
    if (workTab === 'shifts') {
      void loadEditRequests();
    }
  }, [workTab, loadTodayOptions, loadEditRequests]);

  const startShiftWithTarget = async (explicitTarget?: {
    targetType: ShiftTargetType;
    orderId?: string | null;
    visitId?: string | null;
    quickTaskId?: string | null;
  }) => {
    setShiftBusy(true);
    setShiftError('');
    setShiftOfflineNotice('');
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    try {
      const res = await apiRequest<{ offlineQueued?: boolean; shift?: WorkshopShift }>('/api/shifts/start', {
        method: 'POST',
        body: explicitTarget ? { ...explicitTarget, tzOffsetMinutes } : { tzOffsetMinutes },
      });
      setPickerOpen(false);
      if (res?.offlineQueued) {
        setShiftOfflineNotice(
          'Старт смены сохранён в офлайн-очередь и будет отправлен при появлении сети.'
        );
      } else {
        onShiftChanged();
        void loadTodayOptions();
      }
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Не удалось начать смену');
    } finally {
      setShiftBusy(false);
    }
  };

  const handleStartShift = async (explicitTarget?: {
    targetType: ShiftTargetType;
    orderId?: string | null;
    visitId?: string | null;
    quickTaskId?: string | null;
  }) => {
    if (explicitTarget) {
      await startShiftWithTarget(explicitTarget);
      return;
    }
    setShiftBusy(true);
    setShiftError('');
    setShiftOfflineNotice('');
    const options = await loadTodayOptions();
    if (options && options.totalTargets >= 2) {
      setPickerOpen(true);
      setShiftBusy(false);
      return;
    }
    await startShiftWithTarget();
  };

  const openFinishModal = () => {
    setCompleteQuickTaskOnFinish(Boolean(activeShift?.quick_task_id));
    setFinishModalOpen(true);
  };

  const handleFinishShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setShiftBusy(true);
    setShiftError('');
    setShiftOfflineNotice('');
    try {
      const res = await apiRequest<{
        offlineQueued?: boolean;
        uncoveredToday?: ShiftTodayOptions;
      }>('/api/shifts/finish', {
        method: 'POST',
        body: {
          workDone,
          shiftId: activeShift?.id,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
          ...(activeShift?.quick_task_id ? { completeTarget: completeQuickTaskOnFinish } : {}),
          materials: shiftMaterials
            .filter((m) => m.materialId && Number(m.qty) > 0)
            .map((m) => ({ materialId: m.materialId, qtyMilli: Math.round(Number(m.qty) * 1000) })),
        },
      });
      setFinishModalOpen(false);
      setWorkDone('');
      setShiftMaterials([]);
      if (res?.uncoveredToday) {
        setTodayOptions(res.uncoveredToday);
      } else {
        void loadTodayOptions();
      }
      if (res?.offlineQueued) {
        setShiftOfflineNotice(
          'Завершение смены сохранено в офлайн-очередь и будет отправлено при появлении сети.'
        );
      } else {
        onShiftChanged();
        void loadQuickTasks();
      }
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Ошибка завершения смены');
    } finally {
      setShiftBusy(false);
    }
  };

  const parseSameDayTargetKey = (
    key: string
  ): {
    targetType: ShiftTargetType;
    orderId: string | null;
    visitId: string | null;
    quickTaskId: string | null;
  } => {
    if (key.startsWith('visit:')) {
      const [, visitId, orderId] = key.split(':');
      return { targetType: 'visit', visitId: visitId || null, orderId: orderId || null, quickTaskId: null };
    }
    if (key.startsWith('order:')) {
      const [, orderId] = key.split(':');
      return { targetType: 'visit', visitId: null, orderId: orderId || null, quickTaskId: null };
    }
    if (key.startsWith('quick_task:')) {
      const [, quickTaskId, orderId] = key.split(':');
      return { targetType: 'quick_task', quickTaskId: quickTaskId || null, orderId: orderId || null, visitId: null };
    }
    return { targetType: 'workshop', orderId: null, visitId: null, quickTaskId: null };
  };

  const openSameDayModal = async () => {
    const opts = (await loadTodayOptions()) || todayOptions;
    if (opts) {
      const firstUncoveredVisit = opts.visits.find((v) => !v.hasLoggedShift);
      const firstUncoveredOrder = opts.orders.find((o) => !o.hasLoggedShift);
      const firstUncoveredTask = opts.quickTasks.find((t) => !t.hasLoggedShift);
      if (firstUncoveredVisit) {
        setSameDayTargetKey(`visit:${firstUncoveredVisit.visitId}:${firstUncoveredVisit.orderId}`);
      } else if (firstUncoveredOrder) {
        setSameDayTargetKey(`order:${firstUncoveredOrder.orderId}`);
      } else if (firstUncoveredTask) {
        setSameDayTargetKey(`quick_task:${firstUncoveredTask.quickTaskId}:${firstUncoveredTask.orderId || ''}`);
      } else {
        setSameDayTargetKey('workshop');
      }
    } else {
      setSameDayTargetKey('workshop');
    }
    setSameDayStart('09:00');
    setSameDayEnd('18:00');
    setSameDayWorkDone('');
    setSameDayModalOpen(true);
  };

  const handleSameDayLog = async (e: React.FormEvent) => {
    e.preventDefault();
    setShiftBusy(true);
    setShiftError('');
    try {
      const target = parseSameDayTargetKey(sameDayTargetKey);
      const tzOffsetMinutes = new Date().getTimezoneOffset();
      await apiRequest('/api/shifts/same-day-log', {
        method: 'POST',
        skipOfflineQueue: true,
        body: {
          workDate: todayOptions?.date || toLocalDateString(new Date()),
          startTime: sameDayStart,
          endTime: sameDayEnd,
          workDone: sameDayWorkDone,
          tzOffsetMinutes,
          ...target,
        },
      });
      setSameDayModalOpen(false);
      onShiftChanged();
      void loadTodayOptions();
      void loadQuickTasks();
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Не удалось сохранить время за сегодня');
    } finally {
      setShiftBusy(false);
    }
  };

  const openEditRequestModal = (shift?: WorkshopShift) => {
    setRequestShift(shift || null);
    setReqDate(shift?.work_date || shift?.started_at.slice(0, 10) || toLocalDateString(new Date()));
    setReqStart(shift ? toLocalHmInput(shift.started_at) : '09:00');
    setReqEnd(shift?.ended_at ? toLocalHmInput(shift.ended_at) : '18:00');
    setReqWorkDone(shift?.work_done || '');
    setReqReason('');
    setRequestModalOpen(true);
  };

  const handleCreateEditRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setShiftBusy(true);
    setShiftError('');
    try {
      await apiRequest('/api/shifts/edit-requests', {
        method: 'POST',
        skipOfflineQueue: true,
        body: {
          shiftId: requestShift?.id || null,
          targetType: requestShift?.shift_type || 'workshop',
          orderId: requestShift?.order_id || null,
          visitId: requestShift?.visit_id || null,
          quickTaskId: requestShift?.quick_task_id || null,
          workDate: reqDate,
          requestedStartTime: reqStart,
          requestedEndTime: reqEnd,
          workDone: reqWorkDone,
          reason: reqReason,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      });
      setRequestModalOpen(false);
      await loadEditRequests();
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Не удалось отправить запрос');
    } finally {
      setShiftBusy(false);
    }
  };

  const handleReviewEditRequest = async (requestId: string, decision: 'approve' | 'reject') => {
    setShiftBusy(true);
    setShiftError('');
    try {
      await apiRequest(`/api/shifts/edit-requests/${requestId}/review`, {
        method: 'POST',
        skipOfflineQueue: true,
        body: {
          decision,
          adminComment: adminReviewComments[requestId] || '',
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      });
      await loadEditRequests();
      onShiftChanged();
      void loadQuickTasks();
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Не удалось обработать запрос');
    } finally {
      setShiftBusy(false);
    }
  };

  const openAdminShiftEdit = (sh: WorkshopShift) => {
    setAdminEditShift(sh);
    setAdminEditDate(sh.work_date || sh.started_at.slice(0, 10));
    setAdminEditStart(toLocalHmInput(sh.started_at));
    setAdminEditEnd(sh.ended_at ? toLocalHmInput(sh.ended_at) : '18:00');
    setAdminEditWorkDone(sh.work_done || '');
  };

  const handleAdminSaveShiftEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminEditShift) return;
    setShiftBusy(true);
    setShiftError('');
    try {
      await apiRequest(`/api/shifts/${adminEditShift.id}`, {
        method: 'PATCH',
        skipOfflineQueue: true,
        body: {
          workDate: adminEditDate,
          startTime: adminEditStart,
          endTime: adminEditEnd,
          workDone: adminEditWorkDone,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      });
      setAdminEditShift(null);
      onShiftChanged();
      void loadQuickTasks();
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Не удалось изменить время смены');
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
        actions={
          <>
            {activeShift ? (
              <button
                type="button"
                onClick={openFinishModal}
                className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Завершить смену ({elapsedText || 'идёт'})</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={shiftBusy}
                onClick={() => void handleStartShift()}
                className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/15 disabled:opacity-50 dark:text-emerald-300"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Начать смену</span>
              </button>
            )}
            <div ref={addTaskDropdownRef} className="relative inline-block">
              <button
                type="button"
                onClick={() => {
                  setAddTaskDropdownOpen((prev) => !prev);
                  setWorkDropdownOpen(false);
                }}
                aria-expanded={addTaskDropdownOpen}
                aria-haspopup="true"
                aria-label="Добавить задачу"
                className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#0077ED] dark:bg-[#2997FF] dark:text-[#0B0C10]"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Добавить задачу</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${addTaskDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {addTaskDropdownOpen && (
                <div
                  className="absolute top-[calc(100%+8px)] left-0 z-50 w-52 max-w-[calc(100vw-3rem)] rounded-xl border border-black/[0.08] bg-white p-1 shadow-xl dark:border-white/[0.1] dark:bg-[#15171C]"
                  role="menu"
                  aria-label="Выбор типа задачи"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddTaskDropdownOpen(false);
                      setHeaderTask(null);
                      setHeaderTaskCreating(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[#1D1D1F] hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.06]"
                  >
                    <CheckSquare className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
                    <span>Быстрая</span>
                  </button>
                  {canCreateOrder && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAddTaskDropdownOpen(false);
                        onOpenCreateOrder(workTab === 'calendar' ? calendarDate : undefined);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[#1D1D1F] hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.06]"
                    >
                      <Briefcase className="h-4 w-4 shrink-0 text-[#0071E3] dark:text-[#2997FF]" />
                      <span>Заказ</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* Кнопка календаря с выпадающим меню подразделов "Работа" (для монтажников и админа) */}
            <div ref={workDropdownRef} className="relative inline-block">
              <button
                type="button"
                onClick={() => {
                  setWorkDropdownOpen((prev) => !prev);
                  setAddTaskDropdownOpen(false);
                }}
                className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.04] dark:border-white/[0.1] dark:bg-[#0B0C10] dark:hover:bg-white/[0.06]"
                aria-expanded={workDropdownOpen}
                aria-haspopup="true"
                aria-label="Инструменты и работа"
              >
                <CalendarDays className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {workTab === 'calendar'
                    ? 'Календарь'
                    : workTab === 'orders'
                      ? 'Заказы'
                      : workTab === 'tasks'
                        ? 'Быстрые задачи'
                        : workTab === 'reports' || shiftsSubMode === 'reports'
                          ? 'Отчёты'
                          : 'Смены'}
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 transition-transform ${workDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {workDropdownOpen && (
                <div
                  className="absolute top-[calc(100%+8px)] left-0 z-50 w-56 max-w-[calc(100vw-3rem)] rounded-xl border border-black/[0.08] bg-white p-1 shadow-xl dark:border-white/[0.1] dark:bg-[#15171C]"
                  role="menu"
                  aria-label="Инструменты и работа"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectWorkTab('calendar');
                      setWorkDropdownOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${workTab === 'calendar' ? 'bg-[#0071E3]/10 text-[#0071E3] dark:text-[#2997FF]' : ''}`}
                  >
                    <CalendarDays className="h-4 w-4 shrink-0" />
                    <span>Календарь</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectWorkTab('orders');
                      setWorkDropdownOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${workTab === 'orders' ? 'bg-[#0071E3]/10 text-[#0071E3] dark:text-[#2997FF]' : ''}`}
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
                    className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${workTab === 'tasks' ? 'bg-[#0071E3]/10 text-[#0071E3] dark:text-[#2997FF]' : ''}`}
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
                    className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${workTab === 'shifts' && shiftsSubMode === 'shifts' ? 'bg-[#0071E3]/10 text-[#0071E3] dark:text-[#2997FF]' : ''}`}
                  >
                    <Wrench className="h-4 w-4 shrink-0" />
                    <span>Смены</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShiftsSubMode('reports');
                      onSelectWorkTab('reports');
                      setWorkDropdownOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${workTab === 'reports' || (workTab === 'shifts' && shiftsSubMode === 'reports') ? 'bg-[#0071E3]/10 text-[#0071E3] dark:text-[#2997FF]' : ''}`}
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
          hasActiveShift={Boolean(activeShift)}
          onStartShiftForTarget={(target) => void handleStartShift(target)}
          onShiftChanged={() => {
            void loadQuickTasks();
            onShiftChanged();
          }}
        />
      )}

      {workTab === 'orders' && (
        <div className="space-y-4">
          {/* Orders Search & Filters */}
          <div className="space-y-2.5 rounded-2xl border border-black/[0.06] bg-white p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
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
                    className={`min-h-[32px] shrink-0 whitespace-nowrap rounded-xl px-2.5 py-1 text-xs font-semibold transition ${
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

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-12">
              <div className="relative sm:col-span-2 md:col-span-3 lg:col-span-3">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  placeholder="Поиск по номеру, названию, адресу, клиенту..."
                  className={`w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-1.5 pl-8 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10] dark:focus:bg-[#0B0C10] ${
                    orderSearch ? 'pr-8' : 'pr-3'
                  }`}
                />
                {orderSearch && (
                  <button
                    type="button"
                    aria-label="Очистить поиск"
                    onClick={() => setOrderSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-zinc-400 transition hover:bg-black/[0.06] hover:text-zinc-700 dark:hover:bg-white/[0.08] dark:hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <select
                aria-label="Статус заказа"
                value={orderStatusFilter}
                onChange={(e) => setOrderStatusFilter(e.target.value)}
                className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs lg:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
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
                className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs lg:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
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
                  className="min-w-0 w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs lg:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  <option value="">Все клиенты</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}

              <div className={`flex flex-wrap items-center gap-1.5 sm:flex-nowrap ${companies.length > 0 ? 'lg:col-span-3' : 'lg:col-span-5'}`}>
                <input
                  type="date"
                  aria-label="Дата с"
                  value={orderFromDate}
                  onChange={(e) => setOrderFromDate(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                />
                <input
                  type="date"
                  aria-label="Дата по"
                  value={orderToDate}
                  onChange={(e) => setOrderToDate(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                />
                <DatePresets
                  from={orderFromDate}
                  to={orderToDate}
                  onChange={(f, t) => {
                    setOrderFromDate(f);
                    setOrderToDate(t);
                  }}
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
                    className="inline-flex h-8 shrink-0 items-center justify-center rounded-xl border border-black/[0.08] px-2.5 text-xs text-zinc-600 hover:bg-black/[0.04] dark:border-white/[0.1] dark:text-zinc-300"
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
            onShiftChanged={() => {
              void loadQuickTasks();
              onShiftChanged();
            }}
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
                    <div className="flex flex-wrap items-center gap-2">
                      <Wrench className="h-4 w-4 text-[#0071E3] dark:text-[#2997FF]" />
                      <h3 className="font-display text-base font-bold">
                        {activeShift ? shiftTargetLabel(activeShift) : 'Текущая смена'}
                      </h3>
                      {activeShift && (
                        <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                          Смена идёт
                        </span>
                      )}
                    </div>
                    {activeShift && (
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        Начата в {formatDateTimeRu(activeShift.started_at)}
                      </p>
                    )}
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
                        onClick={openFinishModal}
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

              {/* Uncovered Same-Day Tasks Notice */}
              {todayOptions && todayOptions.uncoveredCount > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs">
                  <div>
                    <div className="font-bold text-amber-800 dark:text-amber-200">
                      На сегодня ({todayOptions.date}) есть задачи без отмеченного времени ({todayOptions.uncoveredCount})
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openSameDayModal()}
                    className="rounded-xl bg-amber-600 px-3.5 py-2 font-semibold text-white hover:bg-amber-700"
                  >
                    Проставить время за сегодня
                  </button>
                </div>
              )}

              {/* Shift History */}
              <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-base font-bold">История смен ({shifts.length})</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void openSameDayModal()}
                      className="rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.04] dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                    >
                      Отметить время за сегодня
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditRequestModal()}
                      className="rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold text-[#0071E3] hover:bg-black/[0.04] dark:border-white/[0.1] dark:text-[#2997FF]"
                    >
                      Запрос за прошлую дату
                    </button>
                  </div>
                </div>
                {shifts.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-black/[0.1] p-8 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
                    Отработанных смен пока нет
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {shifts.map((sh) => {
                      const mins = sh.duration_minutes ?? (sh.ended_at
                        ? Math.max(
                            1,
                            Math.round((Date.parse(sh.ended_at) - Date.parse(sh.started_at)) / 60_000)
                          )
                        : 0);
                      const isOwn = sh.user_id === user.id;
                      const showWage = isAdmin || isOwn;
                      return (
                        <div
                          key={sh.id}
                          className="rounded-xl border border-black/[0.06] bg-[#F5F5F7]/50 p-3.5 text-xs dark:border-white/[0.08] dark:bg-[#0B0C10]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-[#1D1D1F] dark:text-white">
                                  {sh.employee_name || user.fullName}
                                </span>
                                <span className="rounded-md bg-[#0071E3]/10 px-2 py-0.5 text-[11px] font-semibold text-[#0071E3] dark:text-[#71b5ff]">
                                  {shiftTargetLabel(sh)}
                                </span>
                                {sh.is_manual_entry === 1 && (
                                  <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                                    Вручную
                                  </span>
                                )}
                              </div>
                              <div className="text-zinc-500 tabular-nums">
                                {formatDateTimeRu(sh.started_at)}
                                {sh.ended_at
                                  ? ` → ${new Date(sh.ended_at).toLocaleTimeString('ru-RU', {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })} (${formatDuration(mins)})`
                                  : ' · активная смена'}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {showWage && (
                                <span
                                  className={`font-bold tabular-nums ${
                                    sh.wage_kopecks != null
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-zinc-500'
                                  }`}
                                >
                                  {sh.wage_kopecks != null ? formatRub(sh.wage_kopecks) : 'Ожидает оплаты'}
                                </span>
                              )}
                              {isOwn && sh.status === 'completed' && !isAdmin && (
                                <button
                                  type="button"
                                  onClick={() => openEditRequestModal(sh)}
                                  className="rounded-lg border border-black/[0.08] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#0071E3] hover:bg-black/[0.03] dark:border-white/[0.1] dark:bg-[#15171C] dark:text-[#2997FF]"
                                >
                                  Запросить правку
                                </button>
                              )}
                              {isAdmin && (
                                <button
                                  type="button"
                                  onClick={() => openAdminShiftEdit(sh)}
                                  className="rounded-lg border border-black/[0.08] bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-700 hover:text-[#0071E3] dark:border-white/[0.1] dark:bg-[#15171C] dark:text-zinc-200"
                                >
                                  Править время
                                </button>
                              )}
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

              {/* Shift Edit Requests */}
              {editRequests.length > 0 && (
                <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
                  <h3 className="mb-3 font-display text-base font-bold">
                    Запросы на редактирование смен ({editRequests.length})
                  </h3>
                  <div className="space-y-2.5">
                    {editRequests.map((reqItem) => {
                      const statusLabel =
                        reqItem.status === 'approved'
                          ? 'Принят'
                          : reqItem.status === 'rejected'
                            ? 'Отклонён'
                            : 'На рассмотрении';
                      const statusCls =
                        reqItem.status === 'approved'
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : reqItem.status === 'rejected'
                            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                            : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
                      return (
                        <div
                          key={reqItem.id}
                          className="rounded-xl border border-black/[0.06] bg-[#F5F5F7]/50 p-3.5 text-xs dark:border-white/[0.08] dark:bg-[#0B0C10]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold">{reqItem.employee_name || user.fullName}</span>
                              <span className="rounded-md bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium dark:bg-white/[0.08]">
                                {shiftTargetLabel({
                                  shift_type: reqItem.target_type,
                                  order_number: reqItem.order_number,
                                  order_title: reqItem.order_title,
                                  visit_title: reqItem.visit_title,
                                  quick_task_title: reqItem.quick_task_title,
                                })}
                              </span>
                              <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${statusCls}`}>
                                {statusLabel}
                              </span>
                            </div>
                            <span className="text-zinc-500 tabular-nums">
                              {reqItem.work_date} · {toLocalHmInput(reqItem.requested_started_at)}–
                              {toLocalHmInput(reqItem.requested_ended_at)}
                            </span>
                          </div>
                          <p className="mt-1.5 text-zinc-700 dark:text-zinc-200">
                            Причина: {reqItem.reason}
                          </p>
                          {reqItem.work_done && (
                            <p className="mt-1 text-zinc-500">Работы: {reqItem.work_done}</p>
                          )}
                          {reqItem.admin_comment && (
                            <p className="mt-1 text-zinc-500">Комментарий: {reqItem.admin_comment}</p>
                          )}
                          {isAdmin && reqItem.status === 'pending' && (
                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                              <input
                                type="text"
                                value={adminReviewComments[reqItem.id] || ''}
                                onChange={(e) =>
                                  setAdminReviewComments((prev) => ({
                                    ...prev,
                                    [reqItem.id]: e.target.value,
                                  }))
                                }
                                placeholder="Комментарий (опционально)"
                                className="min-w-[180px] flex-1 rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                              />
                              <button
                                type="button"
                                disabled={shiftBusy}
                                onClick={() => void handleReviewEditRequest(reqItem.id, 'approve')}
                                className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                              >
                                Принять
                              </button>
                              <button
                                type="button"
                                disabled={shiftBusy}
                                onClick={() => void handleReviewEditRequest(reqItem.id, 'reject')}
                                className="rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                Отклонить
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
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

      {/* Task Picker Modal on Start Shift */}
      {pickerOpen && todayOptions && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <div className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]">
            <h3 className="font-display text-lg font-bold">По какой задаче начать смену?</h3>
            <div className="mt-4 max-h-[60vh] space-y-2 overflow-y-auto">
              {todayOptions.visits.map((v) => (
                <button
                  key={`v:${v.visitId}`}
                  type="button"
                  disabled={shiftBusy}
                  onClick={() =>
                    void startShiftWithTarget({
                      targetType: 'visit',
                      orderId: v.orderId,
                      visitId: v.visitId,
                    })
                  }
                  className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 p-3 text-left transition hover:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                    <span className="text-[#0071E3] dark:text-[#2997FF]">
                      Монтаж {v.orderNumber} · {v.visitTitle || v.orderTitle}
                    </span>
                    {v.hasLoggedShift && (
                      <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Уже есть смена</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {v.orderTitle}
                    {v.address ? ` · ${v.address}` : ''}
                  </div>
                </button>
              ))}
              {todayOptions.orders.map((o) => (
                <button
                  key={`o:${o.orderId}`}
                  type="button"
                  disabled={shiftBusy}
                  onClick={() =>
                    void startShiftWithTarget({
                      targetType: 'visit',
                      orderId: o.orderId,
                    })
                  }
                  className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 p-3 text-left transition hover:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                    <span className="text-[#0071E3] dark:text-[#2997FF]">
                      Монтаж {o.orderNumber} · {o.orderTitle}
                    </span>
                    {o.hasLoggedShift && (
                      <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Уже есть смена</span>
                    )}
                  </div>
                  {o.address && <div className="mt-1 text-xs text-zinc-500">{o.address}</div>}
                </button>
              ))}
              {todayOptions.quickTasks.map((t) => (
                <button
                  key={`t:${t.quickTaskId}`}
                  type="button"
                  disabled={shiftBusy}
                  onClick={() =>
                    void startShiftWithTarget({
                      targetType: 'quick_task',
                      quickTaskId: t.quickTaskId,
                      orderId: t.orderId,
                    })
                  }
                  className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 p-3 text-left transition hover:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                    <span>Быстрая задача: {t.title}</span>
                    {t.hasLoggedShift && (
                      <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Уже есть смена</span>
                    )}
                  </div>
                  {t.orderNumber && (
                    <div className="mt-1 text-xs text-zinc-500">
                      Заказ {oNum(t)}
                    </div>
                  )}
                </button>
              ))}
              <button
                type="button"
                disabled={shiftBusy}
                onClick={() => void startShiftWithTarget({ targetType: 'workshop' })}
                className="w-full rounded-xl border border-dashed border-black/[0.15] p-3 text-left text-xs font-semibold text-zinc-600 hover:border-[#0071E3] dark:border-white/[0.15] dark:text-zinc-300"
              >
                Работа в цеху (без привязки к монтажу)
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="mt-4 w-full rounded-2xl border border-black/[0.08] py-2.5 text-sm font-semibold dark:border-white/[0.1]"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* Finish Shift Modal */}
      {finishModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleFinishShift}
            className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <h3 className="font-display text-lg font-bold">
              Завершение смены{activeShift ? ` · ${shiftTargetLabel(activeShift)}` : ''}
            </h3>

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
                  placeholder="Что изготовлено, смонтировано или выполнено за смену..."
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>

              {activeShift?.quick_task_id && (
                <label className="flex items-center gap-2 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/60 px-3 py-2.5 text-xs font-semibold dark:border-white/[0.1] dark:bg-[#0B0C10]">
                  <input
                    type="checkbox"
                    checked={completeQuickTaskOnFinish}
                    onChange={(e) => setCompleteQuickTaskOnFinish(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  <span>Отметить связанную быструю задачу выполненной</span>
                </label>
              )}

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

      {/* Same-Day Backfill Modal */}
      {sameDayModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleSameDayLog}
            className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <h3 className="font-display text-lg font-bold">Проставить время за сегодня</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {todayOptions?.date || toLocalDateString(new Date())}
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Задача / смена
                </label>
                <select
                  value={sameDayTargetKey}
                  onChange={(e) => setSameDayTargetKey(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="workshop">Смена в цеху</option>
                  {(todayOptions?.visits || []).map((v) => (
                    <option key={`v:${v.visitId}`} value={`visit:${v.visitId}:${v.orderId}`}>
                      Монтаж {v.orderNumber} · {v.visitTitle || v.orderTitle}
                      {v.hasLoggedShift ? ' (уже есть смена)' : ''}
                    </option>
                  ))}
                  {(todayOptions?.orders || []).map((o) => (
                    <option key={`o:${o.orderId}`} value={`order:${o.orderId}`}>
                      Монтаж {o.orderNumber} · {o.orderTitle}
                      {o.hasLoggedShift ? ' (уже есть смена)' : ''}
                    </option>
                  ))}
                  {(todayOptions?.quickTasks || []).map((t) => (
                    <option key={`t:${t.quickTaskId}`} value={`quick_task:${t.quickTaskId}:${t.orderId || ''}`}>
                      Задача: {t.title}
                      {t.hasLoggedShift ? ' (уже есть смена)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Начало *
                  </label>
                  <input
                    type="time"
                    required
                    value={sameDayStart}
                    onChange={(e) => setSameDayStart(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Окончание *
                  </label>
                  <input
                    type="time"
                    required
                    value={sameDayEnd}
                    onChange={(e) => setSameDayEnd(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Выполненная работа
                </label>
                <textarea
                  rows={2}
                  value={sameDayWorkDone}
                  onChange={(e) => setSameDayWorkDone(e.target.value)}
                  placeholder="Кратко опишите выполненную работу..."
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
            </div>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => setSameDayModalOpen(false)}
                className="flex-1 rounded-2xl border border-black/[0.08] py-2.5 text-sm font-semibold dark:border-white/[0.1]"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={shiftBusy}
                className="flex-1 rounded-2xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                Сохранить
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Past-Day Shift Edit Request Modal */}
      {requestModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleCreateEditRequest}
            className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <h3 className="font-display text-lg font-bold">Запрос на редактирование смены</h3>
            {requestShift && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {shiftTargetLabel(requestShift)}
              </p>
            )}
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Дата *
                  </label>
                  <input
                    type="date"
                    required
                    value={reqDate}
                    onChange={(e) => setReqDate(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Начало *
                  </label>
                  <input
                    type="time"
                    required
                    value={reqStart}
                    onChange={(e) => setReqStart(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Конец *
                  </label>
                  <input
                    type="time"
                    required
                    value={reqEnd}
                    onChange={(e) => setReqEnd(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Выполненная работа
                </label>
                <input
                  type="text"
                  value={reqWorkDone}
                  onChange={(e) => setReqWorkDone(e.target.value)}
                  placeholder="Описание работ"
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Причина корректировки *
                </label>
                <textarea
                  required
                  rows={2}
                  value={reqReason}
                  onChange={(e) => setReqReason(e.target.value)}
                  placeholder="Например: забыл вовремя нажать «Завершить смену»..."
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
            </div>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => setRequestModalOpen(false)}
                className="flex-1 rounded-2xl border border-black/[0.08] py-2.5 text-sm font-semibold dark:border-white/[0.1]"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={shiftBusy}
                className="flex-1 rounded-2xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                Отправить запрос
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Admin Edit Shift Modal */}
      {adminEditShift && isAdmin && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleAdminSaveShiftEdit}
            className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <h3 className="font-display text-lg font-bold">Редактирование смены (админ)</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {adminEditShift.employee_name} · {shiftTargetLabel(adminEditShift)}
            </p>
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Дата
                  </label>
                  <input
                    type="date"
                    required
                    value={adminEditDate}
                    onChange={(e) => setAdminEditDate(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Начало
                  </label>
                  <input
                    type="time"
                    required
                    value={adminEditStart}
                    onChange={(e) => setAdminEditStart(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Конец
                  </label>
                  <input
                    type="time"
                    required
                    value={adminEditEnd}
                    onChange={(e) => setAdminEditEnd(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-2.5 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Выполненная работа
                </label>
                <textarea
                  rows={2}
                  value={adminEditWorkDone}
                  onChange={(e) => setAdminEditWorkDone(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
            </div>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => setAdminEditShift(null)}
                className="flex-1 rounded-2xl border border-black/[0.08] py-2.5 text-sm font-semibold dark:border-white/[0.1]"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={shiftBusy}
                className="flex-1 rounded-2xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                Сохранить
              </button>
            </div>
          </form>
        </div>
      )}
      {(headerTaskCreating || headerTask) && (
        <QuickTaskModal
          user={user}
          directory={directory}
          orders={orders}
          creating={headerTaskCreating}
          task={headerTask}
          defaultDate={workTab === 'calendar' ? calendarDate : toLocalDateString(new Date())}
          onClose={() => {
            setHeaderTaskCreating(false);
            setHeaderTask(null);
          }}
          onTaskChange={(next) => {
            setHeaderTaskCreating(false);
            setHeaderTask(next);
          }}
          onRefresh={() => void loadQuickTasks()}
          onShiftChanged={() => {
            void loadQuickTasks();
            onShiftChanged();
          }}
          onNotice={(msg) => {
            if (msg) setShiftOfflineNotice(msg);
          }}
          onOpenOrderById={onOpenOrderById}
        />
      )}
    </div>
  );
}

function oNum(t: { orderNumber: string | null; orderTitle: string | null }) {
  return [t.orderNumber, t.orderTitle].filter(Boolean).join(' · ');
}
