import React from 'react';
import {
  Briefcase,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  Inbox,
  Wrench,
} from 'lucide-react';
import type { AuthUser } from '../types/crm';

export type WorkSubTab = 'calendar' | 'orders' | 'tasks' | 'shifts' | 'reports';

interface WorkViewProps {
  user: AuthUser;
  workTab?: WorkSubTab;
  onSelectWorkTab?: (tab: WorkSubTab) => void;
}

const TABS: Array<{ id: WorkSubTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'calendar', label: 'Календарь', icon: CalendarDays },
  { id: 'orders', label: 'Заказы', icon: Briefcase },
  { id: 'tasks', label: 'Быстрые задачи', icon: CheckSquare },
  { id: 'shifts', label: 'Смены', icon: Wrench },
  { id: 'reports', label: 'Отчёты', icon: ClipboardCheck },
];

/**
 * WorkView — единая точка входа раздела «Работа».
 * Конкретные вкладки рендерятся в CalendarView / ReportsView; здесь
 * реализован только переключатель и подписи разделов.
 */
export function WorkView({ workTab = 'calendar', onSelectWorkTab }: WorkViewProps) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Разделы работы">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = workTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectWorkTab?.(tab.id)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition ${
                active ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]' : 'border border-black/[0.08] dark:border-white/[0.1]'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
      {workTab === 'orders' && (
        <div className="flex items-center gap-2 rounded-2xl border border-dashed border-black/[0.1] p-6 text-sm text-zinc-500 dark:border-white/[0.1]">
          <Inbox className="h-4 w-4" />
          <span>Незапланированные заказы и черновики</span>
        </div>
      )}
    </section>
  );
}