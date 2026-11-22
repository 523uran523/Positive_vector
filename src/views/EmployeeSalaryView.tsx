import React, { useEffect, useState } from 'react';
import { Calendar, Clock, ExternalLink, Wallet } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { apiRequest, formatDateRu, formatDateTimeRu, formatRub } from '../lib/api';
import type { WorkshopShift } from '../types/crm';

interface MySalaryData {
  activity: Array<{ month: string; visits: number; shifts: number }>;
  month: string;
  monthAccruedKopecks: number;
  totalAccruedKopecks: number;
  totalPaidKopecks: number;
  remainingKopecks: number;
  accruals: Array<{
    id: string;
    source_type: string;
    amount_kopecks: number;
    description: string;
    created_at: string;
  }>;
  payouts: Array<{
    id: string;
    amount_kopecks: number;
    paid_at: string;
    comment: string;
  }>;
  pendingVisits: Array<{
    assignee_id: string;
    visit_id: string;
    order_id?: string;
    visit_title: string;
    scheduled_at: string;
    visit_status: string;
    order_number: string;
    order_title: string;
  }>;
}

interface EmployeeSalaryViewProps {
  onOpenOrderById?: (orderId: string) => void;
}

export function EmployeeSalaryView({ onOpenOrderById }: EmployeeSalaryViewProps = {}) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [data, setData] = useState<MySalaryData | null>(null);
  const [shifts, setShifts] = useState<WorkshopShift[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void Promise.all([
      apiRequest<MySalaryData>(`/api/salaries/my?month=${encodeURIComponent(selectedMonth)}`),
      apiRequest<{ shifts: WorkshopShift[] }>('/api/shifts'),
    ])
      .then(([salRes, shRes]) => {
        if (!active) return;
        setData(salRes);
        setShifts(shRes.shifts);
        setError('');
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Ошибка загрузки зарплаты');
      });
    return () => {
      active = false;
    };
  }, [selectedMonth]);

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-center text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-2xl border border-black/[0.06] bg-white p-8 text-center text-sm text-zinc-400 dark:border-white/[0.08] dark:bg-[#15171C]">
        Загружаем данные по зарплате...
      </div>
    );
  }

  const currentActivity = data.activity.find((item) => item.month === data.month);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Моя зарплата"
        description="Начисления за выезды и смены, полученные выплаты и остаток к получению"
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
              <span>Месяц:</span>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value || currentMonth)}
                className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
              />
            </label>
            {selectedMonth !== currentMonth && (
              <button
                type="button"
                onClick={() => setSelectedMonth(currentMonth)}
                className="text-xs font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
              >
                Текущий
              </button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="text-xs text-zinc-500">За {data.month}</div>
          <div className="mt-1 text-xl font-bold tabular-nums">
            {formatRub(data.monthAccruedKopecks)}
          </div>
          <div className="mt-1 text-[11px] text-zinc-400 tabular-nums">
            Монтажей: {currentActivity?.visits || 0} · Смен: {currentActivity?.shifts || 0}
          </div>
        </div>
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="text-xs text-zinc-500">Всего начислено</div>
          <div className="mt-1 text-xl font-bold tabular-nums">
            {formatRub(data.totalAccruedKopecks)}
          </div>
        </div>
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="text-xs text-zinc-500">Выплачено</div>
          <div className="mt-1 text-xl font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
            {formatRub(data.totalPaidKopecks)}
          </div>
        </div>
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="text-xs text-zinc-500">Остаток к получению</div>
          <div className="mt-1 text-xl font-bold text-[#0071E3] tabular-nums dark:text-[#2997FF]">
            {formatRub(data.remainingKopecks)}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
        <h3 className="mb-3 font-semibold">Монтажи и смены по месяцам</h3>
        {data.activity.length === 0 ? (
          <p className="text-sm text-zinc-500">Пока нет завершённых работ.</p>
        ) : (
          <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {data.activity.map((item) => (
              <button
                key={item.month}
                type="button"
                onClick={() => setSelectedMonth(item.month)}
                className={`flex w-full justify-between gap-3 py-2 text-left text-sm transition hover:text-[#0071E3] ${
                  item.month === selectedMonth ? 'font-bold text-[#0071E3] dark:text-[#2997FF]' : ''
                }`}
              >
                <span className="tabular-nums">{item.month}</span>
                <span className="tabular-nums">
                  Монтажей: {item.visits} · Смен: {item.shifts}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {data.pendingVisits.length > 0 && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold text-amber-800 dark:text-amber-300">
            <Clock className="h-4 w-4" />
            <span>Ожидает начисления оплаты ({data.pendingVisits.length})</span>
          </div>
          <div className="space-y-2">
            {data.pendingVisits.map((pv) => (
              <div
                key={pv.assignee_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3.5 py-2.5 text-xs dark:bg-[#15171C]"
              >
                <div>
                  {pv.order_id && onOpenOrderById ? (
                    <button
                      type="button"
                      onClick={() => onOpenOrderById(pv.order_id!)}
                      className="inline-flex items-center gap-1 font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
                    >
                      <span className="font-mono">{pv.order_number}</span>
                      <span>{pv.order_title}</span>
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  ) : (
                    <>
                      <span className="font-mono font-semibold text-zinc-500">{pv.order_number}</span>{' '}
                      <span className="font-semibold">{pv.order_title}</span>
                    </>
                  )}
                  <div className="text-zinc-400">
                    {pv.visit_title} · {formatDateTimeRu(pv.scheduled_at)}
                  </div>
                </div>
                <span className="font-semibold text-amber-600 dark:text-amber-400">
                  Ожидает начисления
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
          <h3 className="mb-3 font-display text-base font-bold">Начисления</h3>
          <div className="space-y-2">
            {data.accruals.length === 0 ? (
              <div className="text-xs text-zinc-400">Начислений пока нет</div>
            ) : (
              data.accruals.map((a) => {
                const isDeduction = a.amount_kopecks < 0;
                const typeLabel =
                  a.source_type === 'visit'
                    ? 'Выезд'
                    : a.source_type === 'shift'
                      ? 'Смена'
                      : isDeduction
                        ? 'Удержание'
                        : 'Премия';
                return (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                            isDeduction
                              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                              : a.source_type === 'manual'
                                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                : 'bg-black/[0.05] text-zinc-600 dark:bg-white/[0.08] dark:text-zinc-300'
                          }`}
                        >
                          {typeLabel}
                        </span>
                        <span className="font-semibold">{a.description}</span>
                      </div>
                      <div className="mt-0.5 text-zinc-400">{formatDateRu(a.created_at)}</div>
                    </div>
                    <div
                      className={`shrink-0 font-bold tabular-nums ${
                        isDeduction ? 'text-red-600 dark:text-red-400' : ''
                      }`}
                    >
                      {isDeduction ? '−' : '+'}
                      {formatRub(Math.abs(a.amount_kopecks))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="mb-3 flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            <h3 className="font-display text-base font-bold">Полученные выплаты</h3>
          </div>
          <div className="space-y-2">
            {data.payouts.length === 0 ? (
              <div className="text-xs text-zinc-400">Выплат пока не было</div>
            ) : (
              data.payouts.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
                >
                  <div>
                    <div className="font-semibold">{p.comment ? p.comment : 'Выплата'}</div>
                    <div className="text-zinc-400">{formatDateRu(p.paid_at)}</div>
                  </div>
                  <div className="font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                    {formatRub(p.amount_kopecks)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Worked Shifts History */}
      <div className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="mb-3 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-[#0071E3] dark:text-[#2997FF]" />
          <h3 className="font-display text-base font-bold">
            История рабочих смен в цеху ({shifts.length})
          </h3>
        </div>
        {shifts.length === 0 ? (
          <div className="text-xs text-zinc-400">Отработанных смен пока нет</div>
        ) : (
          <div className="space-y-2">
            {shifts.map((sh) => (
              <div
                key={sh.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
              >
                <div>
                  <div className="font-semibold">
                    {formatDateRu(sh.started_at)} ·{' '}
                    <span className="tabular-nums text-zinc-500">
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
                    </span>
                  </div>
                  {sh.work_done && <div className="mt-0.5 text-zinc-500">{sh.work_done}</div>}
                </div>
                <div className="font-bold tabular-nums">{formatRub(sh.rate_snapshot_kopecks)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
