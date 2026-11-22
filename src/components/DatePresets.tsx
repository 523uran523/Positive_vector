import React from 'react';
import { toLocalDateString } from '../lib/links';

interface DatePresetsProps {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

export function DatePresets({ from, to, onChange }: DatePresetsProps) {
  const now = new Date();
  const todayStr = toLocalDateString(now);

  const dayOfWeek = (now.getDay() + 6) % 7; // Monday = 0
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);

  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  const presets = [
    { id: 'today', label: 'Сегодня', from: todayStr, to: todayStr },
    { id: 'week', label: 'Неделя', from: toLocalDateString(weekStart), to: toLocalDateString(weekEnd) },
    { id: 'month', label: 'Этот месяц', from: toLocalDateString(thisMonthStart), to: toLocalDateString(thisMonthEnd) },
    { id: 'prev_month', label: 'Прошлый месяц', from: toLocalDateString(prevMonthStart), to: toLocalDateString(prevMonthEnd) },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {presets.map((p) => {
        const active = from === p.from && to === p.to;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => (active ? onChange('', '') : onChange(p.from, p.to))}
            className={`min-h-[32px] rounded-xl px-2.5 py-1 text-[11px] font-semibold transition ${
              active
                ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                : 'bg-[#F5F5F7] text-zinc-600 hover:bg-black/[0.06] dark:bg-[#0B0C10] dark:text-zinc-300 dark:hover:bg-white/[0.08]'
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
