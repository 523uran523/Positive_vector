export { apiRequest, setCsrfToken, syncOfflineQueue, establishOfflineSession, restoredOfflineSession, endOfflineSession } from './apiTransport';

export function formatRub(kopecks: number | null | undefined): string {
  const val = Number(kopecks || 0) / 100;
  return `${val.toLocaleString('ru-RU', {
    minimumFractionDigits: val % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

export function formatQty(milli: number | null | undefined): string {
  const val = Number(milli || 0) / 1000;
  return val.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

export function formatDuration(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(Number(minutes || 0)));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem} мин`;
  if (rem === 0) return `${h} ч`;
  return `${h} ч ${rem} мин`;
}

export function formatDateRu(iso: string | null | undefined): string {
  if (!iso) return 'Без даты';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatTimeRu(iso: string | null | undefined): string {
  if (!iso) return '';
  if (iso.includes('T')) return iso.slice(11, 16);
  return '';
}

export function formatDateTimeRu(iso: string | null | undefined): string {
  if (!iso) return 'Не запланирован';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function toLocalDateKey(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export const ORDER_STATUS_META: Record<
  string,
  { label: string; dotClass: string; textClass: string }
> = {
  new: {
    label: 'Новый',
    dotClass: 'bg-[#0071E3] dark:bg-[#2997FF]',
    textClass: 'text-[#0071E3] dark:text-[#2997FF]',
  },
  in_progress: {
    label: 'В работе',
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-600 dark:text-amber-400',
  },
  completed: {
    label: 'Завершён',
    dotClass: 'bg-emerald-500',
    textClass: 'text-emerald-600 dark:text-emerald-400',
  },
  cancelled: {
    label: 'Отменён',
    dotClass: 'bg-zinc-400',
    textClass: 'text-zinc-500 dark:text-zinc-400',
  },
  planned: {
    label: 'Запланирован',
    dotClass: 'bg-[#0071E3] dark:bg-[#2997FF]',
    textClass: 'text-[#0071E3] dark:text-[#2997FF]',
  },
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  urgent: 'Срочный',
};

export const PAYMENT_TYPE_LABELS: Record<string, string> = {
  advance: 'Аванс',
  partial: 'Доплата',
  full: 'Полный расчёт',
  refund: 'Возврат клиенту',
};

export const OP_TYPE_LABELS: Record<string, string> = {
  receipt: 'Поступление',
  issue: 'Взято на объект',
  consume: 'Израсходовано',
  return: 'Возврат на склад',
  adjust: 'Корректировка',
};
