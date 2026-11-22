import React, { useState } from 'react';
import {
  Bell,
  CalendarDays,
  CheckCheck,
  LogOut,
  Moon,
  MessageCircle,
  Package,
  Settings,
  Sun,
  Users,
  Wallet,
  Building2,
  ClipboardCheck,
  FileText,
  X,
} from 'lucide-react';
import { formatDateTimeRu } from '../lib/api';
import type { AuthUser, NotificationItem } from '../types/crm';
import { OfflineIndicator } from './OfflineIndicator';
import { PWAInstallButton } from './PWAInstallButton';
import { useTheme } from './ThemeContext';

export type NavTab =
  | 'calendar'
  | 'chat'
  | 'reports'
  | 'clients'
  | 'warehouse'
  | 'finance'
  | 'documents'
  | 'employees'
  | 'salary'
  | 'settings';

interface AppShellProps {
  user: AuthUser;
  companyName: string;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  notifications: NotificationItem[];
  unreadCount: number;
  chatUnread: number;
  onMarkNotificationRead: (id: string) => void;
  onMarkAllNotificationsRead: () => void;
  onOpenOrderLink?: (orderId: string) => void;
  onOpenTaskLink?: (taskId: string) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

export function AppShell({
  user,
  companyName,
  activeTab,
  onSelectTab,
  notifications,
  unreadCount,
  chatUnread,
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
  onOpenOrderLink,
  onOpenTaskLink,
  onLogout,
  children,
}: AppShellProps) {
  const { theme, toggleTheme } = useTheme();
  const [notifOpen, setNotifOpen] = useState(false);

  const isAdmin = user.role === 'admin';

  const navItems: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }> = isAdmin
    ? [
        { id: 'calendar', label: 'Работа', icon: CalendarDays },
        { id: 'finance', label: 'Финансы', icon: Wallet },
        { id: 'warehouse', label: 'Склад', icon: Package },
        { id: 'chat', label: 'Чат', icon: MessageCircle },
        ...(user.documentsAccess ? [{ id: 'documents' as const, label: 'Документы', icon: FileText }] : []),
        { id: 'clients', label: 'Клиенты', icon: Building2 },
        { id: 'employees', label: 'Сотрудники', icon: Users },
        { id: 'settings', label: 'Настройки', icon: Settings },
      ]
    : [
        { id: 'calendar', label: 'Работа', icon: CalendarDays },
        { id: 'chat', label: 'Чат', icon: MessageCircle },
        { id: 'salary', label: 'Моя зарплата', icon: Wallet },
        { id: 'settings', label: 'Настройки', icon: Settings },
      ];

  const activeTitle = navItems.find((n) => n.id === activeTab)?.label || 'Работа';

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-[#1D1D1F] transition-colors dark:bg-[#0B0C10] dark:text-[#F5F5F7]">
      {/* Desktop Sticky Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-black/[0.06] bg-white/85 backdrop-blur-xl md:flex dark:border-white/[0.08] dark:bg-[#15171C]/90">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#0071E3] text-sm font-bold text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]">
            ПВ
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-base font-bold tracking-tight">
              {companyName || 'Позитив Вектор'}
            </div>
            <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {isAdmin ? 'Администратор' : user.position || 'Сотрудник'}
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                  active
                    ? 'bg-[#0071E3] text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]'
                    : 'text-zinc-600 hover:bg-black/[0.04] hover:text-[#1D1D1F] dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-white'
                }`}
              >
                <Icon className="h-4.5 w-4.5 shrink-0" />
                <span>{item.label}</span>
                {item.id === 'chat' && chatUnread > 0 && <span className="rounded-full bg-red-600 px-1.5 text-xs text-white">{chatUnread}</span>}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-black/[0.06] p-4 dark:border-white/[0.08]">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{user.fullName}</div>
              <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">@{user.login}</div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
              title="Выйти"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
          <PWAInstallButton />
        </div>
      </aside>

      {/* Main Layout */}
      <div className="flex min-h-screen flex-col md:pl-64">
        {/* Top Sticky Header */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-black/[0.06] bg-[#F5F5F7]/85 px-4 backdrop-blur-xl sm:px-6 dark:border-white/[0.08] dark:bg-[#0B0C10]/85">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#0071E3] text-xs font-bold text-white md:hidden dark:bg-[#2997FF] dark:text-[#0B0C10]">
              ПВ
            </div>
            <h1 className="font-display text-lg font-bold tracking-tight sm:text-xl">
              {activeTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <div className="md:hidden">
              <PWAInstallButton compact />
            </div>

            {user.mustChangePassword && (
              <button
                type="button"
                onClick={() => onSelectTab('settings')}
                className="hidden rounded-xl bg-amber-500/12 px-3 py-1.5 text-xs font-semibold text-amber-700 sm:inline-flex dark:text-amber-300"
              >
                Смените временный пароль
              </button>
            )}

            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-black/[0.06] bg-white text-zinc-600 transition hover:bg-zinc-50 dark:border-white/[0.08] dark:bg-[#15171C] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
              title={theme === 'light' ? 'Тёмная тема' : 'Светлая тема'}
            >
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen(!notifOpen)}
                className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-black/[0.06] bg-white text-zinc-600 transition hover:bg-zinc-50 dark:border-white/[0.08] dark:bg-[#15171C] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
                title="Уведомления"
              >
                <Bell className="h-4 w-4" />
                {unreadCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4.5 min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white tabular-nums">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setNotifOpen(false)}
                  />
                  <div className="fixed inset-x-3 top-16 z-40 max-h-[75vh] overflow-y-auto rounded-2xl border border-black/[0.08] bg-white p-3 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-96 dark:border-white/[0.1] dark:bg-[#15171C]">
                    <div className="mb-2 flex items-center justify-between border-b border-black/[0.06] pb-2 dark:border-white/[0.08]">
                      <span className="font-display text-sm font-bold">Уведомления</span>
                      <div className="flex items-center gap-2">
                        {unreadCount > 0 && (
                          <button
                            type="button"
                            onClick={onMarkAllNotificationsRead}
                            className="inline-flex items-center gap-1 text-xs font-medium text-[#0071E3] hover:underline dark:text-[#2997FF]"
                          >
                            <CheckCheck className="h-3.5 w-3.5" />
                            <span>Прочитать все</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setNotifOpen(false)}
                          className="rounded-lg p-1 text-zinc-400 hover:text-zinc-600"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {notifications.length === 0 ? (
                      <div className="py-8 text-center text-sm text-zinc-400">
                        Новых уведомлений нет
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {notifications.map((n) => (
                          <button
                            key={n.id}
                            type="button"
                            onClick={() => {
                              if (n.is_read === 0) onMarkNotificationRead(n.id);
                              if (n.link_entity_type === 'order' && n.link_entity_id && onOpenOrderLink) {
                                onOpenOrderLink(n.link_entity_id);
                                setNotifOpen(false);
                              }
                              if (n.link_entity_type === 'quick_task' && n.link_entity_id && onOpenTaskLink) {
                                onOpenTaskLink(n.link_entity_id);
                                setNotifOpen(false);
                              }
                            }}
                            className={`w-full rounded-xl p-3 text-left transition ${
                              n.is_read === 0
                                ? 'bg-[#0071E3]/[0.06] hover:bg-[#0071E3]/[0.1] dark:bg-[#2997FF]/[0.1]'
                                : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-xs font-semibold">{n.title}</span>
                              {n.is_read === 0 && (
                                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#0071E3] dark:bg-[#2997FF]" />
                              )}
                            </div>
                            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                              {n.body}
                            </p>
                            <div className="mt-1 text-[11px] text-zinc-400 tabular-nums">
                              {formatDateTimeRu(n.created_at)}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-8">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-black/[0.08] bg-white/90 backdrop-blur-xl md:hidden dark:border-white/[0.08] dark:bg-[#15171C]/92">
        <div className="mx-auto flex h-16 max-w-lg overflow-x-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`flex min-h-[44px] min-w-[64px] flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition ${
                  active
                    ? 'text-[#0071E3] dark:text-[#2997FF]'
                    : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="truncate max-w-full">{item.label}</span>
                {item.id === 'chat' && chatUnread > 0 && <span className="absolute -translate-y-5 translate-x-3 rounded-full bg-red-600 px-1 text-[9px] text-white">{chatUnread}</span>}
              </button>
            );
          })}
        </div>
      </nav>

      <OfflineIndicator />
    </div>
  );
}
