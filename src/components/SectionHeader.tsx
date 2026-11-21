import React from 'react';

export interface SectionTabItem<T extends string = string> {
  id: T;
  label: string;
  count?: number;
  icon?: React.ComponentType<{ className?: string }>;
}

interface SectionHeaderProps<T extends string = string> {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tabs?: SectionTabItem<T>[];
  activeTab?: T;
  onSelectTab?: (tab: T) => void;
  filters?: React.ReactNode;
  tabsAriaLabel?: string;
}

export function SectionHeader<T extends string = string>({
  title,
  description,
  actions,
  tabs,
  activeTab,
  onSelectTab,
  filters,
  tabsAriaLabel,
}: SectionHeaderProps<T>) {
  return (
    <section className="space-y-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
      {/* 1. Title + description & 2. Primary CTA */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold tracking-tight text-[#1D1D1F] sm:text-xl dark:text-white">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-xs text-zinc-500 sm:text-sm dark:text-zinc-400">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {actions}
          </div>
        )}
      </div>

      {/* 3. Section Tabs (mobile scrollable, high-contrast active state) */}
      {tabs && tabs.length > 0 && activeTab !== undefined && onSelectTab && (
        <div
          role="tablist"
          aria-label={tabsAriaLabel || title}
          className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelectTab(tab.id)}
                className={`inline-flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-2 text-xs font-semibold transition sm:text-sm ${
                  isActive
                    ? 'bg-[#0071E3] text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]'
                    : 'bg-[#F5F5F7] text-zinc-700 hover:bg-black/[0.06] hover:text-[#1D1D1F] dark:bg-[#0B0C10] dark:text-zinc-300 dark:hover:bg-white/[0.08] dark:hover:text-white'
                }`}
              >
                {Icon && <Icon className="h-4 w-4 shrink-0" />}
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
                      isActive
                        ? 'bg-white/20 text-white dark:bg-[#0B0C10]/15 dark:text-[#0B0C10]'
                        : 'bg-black/[0.06] text-zinc-600 dark:bg-white/[0.08] dark:text-zinc-300'
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 4. Search & Filters */}
      {filters && (
        <div className="border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
          {filters}
        </div>
      )}
    </section>
  );
}
