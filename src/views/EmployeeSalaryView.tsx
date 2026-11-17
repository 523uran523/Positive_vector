import React, { useEffect, useState } from 'react';
import { Calendar, Clock, Wallet } from 'lucide-react';
import { apiRequest, formatDateRu, formatDateTimeRu, formatRub, PAYMENT_METHOD_LABELS } from '../lib/api';
import type { WorkshopShift } from '../types/crm';

interface MySalaryData {
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
    payment_method: string;
    paid_at: string;
    comment: string;
  }>;
  pendingVisits: Array<{
    assignee_id: string;
    visit_id: string;
    visit_title: string;
    scheduled_at: string;
    visit_status: string;
    order_number: string;
    order_title: string;
  }>;
}

export function EmployeeSalaryView() {
  const [data, setData] = useState<MySalaryData | null>(null);
  const [shifts, setShifts] = useState<WorkshopShift[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([
      apiRequest<MySalaryData>('/api/salaries/my'),
      apiRequest<{ shifts: WorkshopShift[] }>('/api/shifts'),
    ])
      .then(([salRes, shRes]) => {
        setData(salRes);
        setShifts(shRes.shifts);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки зарплаты'));
  }, []);

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

  const completedShiftsCount = shifts.filter((s) => s.status === 'completed').length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="text-xs text-zinc-500">За текущий месяц</div>
          <div className="mt-1 text-xl font-bold tabular-nums">
            {formatRub(data.monthAccruedKopecks)}
          </div>
          <div className="mt-1 text-[11px] text-zinc-400 tabular-nums">
            Смен в цеху: {completedShiftsCount}
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
                className="flex items-center justify-between rounded-xl bg-white px-3.5 py-2.5 text-xs dark:bg-[#15171C]"
              >
                <div>
                  <span className="font-mono font-semibold text-zinc-500">{pv.order_number}</span>{' '}
                  <span className="font-semibold">{pv.order_title}</span>
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
              data.accruals.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
                >
                  <div>
                    <div className="font-semibold">{a.description}</div>
                    <div className="text-zinc-400">{formatDateRu(a.created_at)}</div>
                  </div>
                  <div className="font-bold tabular-nums">+{formatRub(a.amount_kopecks)}</div>
                </div>
              ))
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
                    <div className="font-semibold">
                      {PAYMENT_METHOD_LABELS[p.payment_method] || p.payment_method}
                      {p.comment ? ` · ${p.comment}` : ''}
                    </div>
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
          <h3 className="font-display text-base font-bold">История рабочих смен в цеху ({shifts.length})</h3>
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
                      {new Date(sh.started_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                      {sh.ended_at
                        ? ` — ${new Date(sh.ended_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
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
