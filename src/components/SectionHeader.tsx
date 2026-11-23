import React from 'react';

export interface SectionTabItem<T extends string = string> {
  id: T;
  label: string;
  count?: number;
  icon?: React.ComponentType<{ className?: string }>;
}

interface SectionHeaderProps<T extends string = string> {
  title?: string;
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
  const hasHeaderText = Boolean(title || description);
  const hasTabs = Boolean(tabs && tabs.length > 0 && activeTab !== undefined && onSelectTab);

  const tabsBlock = hasTabs && tabs && activeTab !== undefined && onSelectTab && (
    <div
      role="tablist"
      aria-label={tabsAriaLabel || title || 'Подразделы'}
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
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
            className={`inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-semibold transition sm:text-[13px] ${
              isActive
                ? 'bg-[#0071E3] text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]'
                : 'bg-[#F5F5F7] text-zinc-700 hover:bg-black/[0.06] hover:text-[#1D1D1F] dark:bg-[#0B0C10] dark:text-zinc-300 dark:hover:bg-white/[0.08] dark:hover:text-white'
            }`}
          >
            {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
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
  );

  const actionsBlock = actions && (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {actions}
    </div>
  );

  return (
    <section className="space-y-2.5 rounded-2xl border border-black/[0.06] bg-white p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
      {hasHeaderText ? (
        <>
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="min-w-0">
              {title && (
                <h2 className="font-display text-lg font-bold tracking-tight text-[#1D1D1F] sm:text-xl dark:text-white">
                  {title}
                </h2>
              )}
              {description && (
                <p className="mt-0.5 text-xs text-zinc-500 sm:text-sm dark:text-zinc-400">
                  {description}
                </p>
              )}
            </div>
            {actionsBlock}
          </div>
          {tabsBlock}
        </>
      ) : (
        (hasTabs || actions) && (
          <div
            className={
              hasTabs && actions
                ? 'flex flex-wrap items-center justify-between gap-2'
                : 'flex flex-wrap items-center gap-2'
            }
          >
            {tabsBlock}
            {actionsBlock}
          </div>
        )
      )}

      {/* Search & Filters */}
      {filters && (
        <div className="border-t border-black/[0.05] pt-2.5 dark:border-white/[0.06]">
          {filters}
        </div>
      )}
    </section>
  );
}
