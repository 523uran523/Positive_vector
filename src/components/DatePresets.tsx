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

  const thisYearStart = new Date(now.getFullYear(), 0, 1);
  const thisYearEnd = new Date(now.getFullYear(), 11, 31);

  const presets = [
    { id: 'today', label: 'Сегодня', from: todayStr, to: todayStr },
    { id: 'week', label: 'Неделя', from: toLocalDateString(weekStart), to: toLocalDateString(weekEnd) },
    { id: 'month', label: 'Этот месяц', from: toLocalDateString(thisMonthStart), to: toLocalDateString(thisMonthEnd) },
    { id: 'prev_month', label: 'Прошлый месяц', from: toLocalDateString(prevMonthStart), to: toLocalDateString(prevMonthEnd) },
    { id: 'year', label: 'Этот год', from: toLocalDateString(thisYearStart), to: toLocalDateString(thisYearEnd) },
  ];

  const matchedPreset = presets.find((p) => p.from === from && p.to === to);
  const selectValue = matchedPreset ? matchedPreset.id : from || to ? '__custom__' : '';

  return (
    <select
      aria-label="Быстрый выбор периода"
      value={selectValue}
      onChange={(e) => {
        const val = e.target.value;
        if (!val) {
          onChange('', '');
          return;
        }
        const preset = presets.find((p) => p.id === val);
        if (preset) {
          onChange(preset.from, preset.to);
        }
      }}
      className="min-h-[32px] shrink-0 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-2.5 py-1.5 text-xs font-medium text-zinc-700 outline-none focus:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10] dark:text-zinc-200"
    >
      <option value="">За всё время</option>
      {selectValue === '__custom__' && (
        <option value="__custom__" disabled>
          Свой период
        </option>
      )}
      {presets.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
