import React, { useCallback, useEffect, useState } from 'react';
import { AppShell, type NavTab } from './components/AppShell';
import { AuthScreen } from './components/AuthScreen';
import { DismissedScreen } from './components/DismissedScreen';
import { ThemeProvider } from './components/ThemeContext';
import { apiRequest, setCsrfToken, establishOfflineSession, restoredOfflineSession, endOfflineSession } from './lib/api';
import { setOfflineOwner, offlineOwner } from './lib/offlineDb';

import type {
  AppSettings,
  AuthUser,
  Company,
  Contact,
  DirectoryUser,
  MaterialItem,
  NotificationItem,
  Order,
  ToolItem,
  WarehouseOp,
  WorkshopShift,
} from './types/crm';
import { CalendarView } from './views/CalendarView';
import { ClientsView } from './views/ClientsView';
import { EmployeeSalaryView } from './views/EmployeeSalaryView';
import { EmployeesView } from './views/EmployeesView';
import { FinanceView } from './views/FinanceView';
import { CreateOrderModal, OrderDetailModal } from './views/OrderModals';
import { ReportsView } from './views/ReportsView';
import { SettingsView } from './views/SettingsView';
import { WarehouseView } from './views/WarehouseView';
import { ChatView } from './views/ChatView';

function CRMWorkspace() {
  const [booting, setBooting] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>(() => new URLSearchParams(window.location.search).has('chat') ? 'chat' : 'calendar');

  // Shared CRM data
  const [settings, setSettings] = useState<AppSettings>({});
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [warehouseOps, setWarehouseOps] = useState<WarehouseOp[]>([]);
  const [shifts, setShifts] = useState<WorkshopShift[]>([]);
  const [activeShift, setActiveShift] = useState<WorkshopShift | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatUnread, setChatUnread] = useState(0);
  const refreshChatUnread = useCallback(() => { void apiRequest<{ unreadCount: number }>('/api/chat/rooms', { useCache: false }).then(r => setChatUnread(r.unreadCount)).catch(() => {}); }, []);
  useEffect(() => {
    if (!user || user.dismissedAt) { setChatUnread(0); return; }
    refreshChatUnread();
    const timer = window.setInterval(refreshChatUnread, 10000);
    return () => clearInterval(timer);
  }, [user?.id, user?.dismissedAt, refreshChatUnread]);

  // Modals
  const [createOrderDate, setCreateOrderDate] = useState<string | undefined>(undefined);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const clearWorkspace = useCallback(() => {
    setOrders([]);setCompanies([]);setContacts([]);setMaterials([]);setTools([]);
    setWarehouseOps([]);setShifts([]);setActiveShift(null);setNotifications([]);
    setUnreadCount(0);setSettings({});setDirectory([]);setSelectedOrder(null);
    setCreateOrderOpen(false);setActiveTab('calendar');
  }, []);

  const checkSession = useCallback(async () => {
    try {
      if(localStorage.getItem('pv-local-logout')) return;
      const status = await apiRequest<{
        needsSetup: boolean;
        authenticated: boolean;
        user: AuthUser | null;
        csrfToken: string | null;
      }>('/api/auth/status');
      setNeedsSetup(status.needsSetup);
      setCsrfToken(status.csrfToken);
      if (status.user) await establishOfflineSession(status.user);
      else await endOfflineSession();
      setUser(status.user);
    } catch {
      const saved = restoredOfflineSession();
      if (saved) { setOfflineOwner(saved.id); setUser(saved); }
    } finally {
      setBooting(false);
    }
  }, []);

  const loadWorkspaceData = useCallback(async (currentUser: AuthUser) => {
    const isAdmin = currentUser.role === 'admin';
    const canViewClients =
      isAdmin ||
      currentUser.permissions['clients.view_all'] ||
      currentUser.permissions['orders.create'];

    const [
      settingsRes,
      dirRes,
      ordersRes,
      whRes,
      shiftsRes,
      activeShiftRes,
      notifRes,
      clientsRes,
    ] = await Promise.all([
      apiRequest<{ settings: AppSettings }>('/api/settings').catch(() => ({ settings: {} })),
      apiRequest<{ items: DirectoryUser[] }>('/api/users/directory').catch(() => ({ items: [] })),
      apiRequest<{ orders: Order[] }>('/api/orders').catch(() => ({ orders: [] })),
      apiRequest<{ materials: MaterialItem[]; tools: ToolItem[]; operations: WarehouseOp[] }>(
        '/api/warehouse'
      ).catch(() => ({ materials: [], tools: [], operations: [] })),
      apiRequest<{ shifts: WorkshopShift[] }>('/api/shifts').catch(() => ({ shifts: [] })),
      apiRequest<{ activeShift: WorkshopShift | null }>('/api/shifts/active').catch(() => ({
        activeShift: null,
      })),
      apiRequest<{ notifications: NotificationItem[]; unreadCount: number }>(
        '/api/notifications'
      ).catch(() => ({ notifications: [], unreadCount: 0 })),
      canViewClients
        ? apiRequest<{ companies: Company[]; contacts: Contact[] }>('/api/clients').catch(() => ({
            companies: [],
            contacts: [],
          }))
        : Promise.resolve({ companies: [], contacts: [] }),
    ]);

    if(offlineOwner()!==currentUser.id) return;
    setSettings(settingsRes.settings);
    setDirectory(dirRes.items);
    setOrders(ordersRes.orders);
    setMaterials(whRes.materials);
    setTools(whRes.tools);
    setWarehouseOps(whRes.operations);
    setShifts(shiftsRes.shifts);
    setActiveShift(activeShiftRes.activeShift);
    setNotifications(notifRes.notifications);
    setUnreadCount(notifRes.unreadCount);
    setCompanies(clientsRes.companies);
    setContacts(clientsRes.contacts);
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    const onUnauthorized = () => {
      setCsrfToken(null);
      setUser(null);
      clearWorkspace();
    };
    window.addEventListener('pv:unauthorized', onUnauthorized);
    return () => window.removeEventListener('pv:unauthorized', onUnauthorized);
  }, [clearWorkspace]);

  useEffect(() => {
    if (user && !user.dismissedAt) {
      void loadWorkspaceData(user);
    }
  }, [user, loadWorkspaceData]);

  useEffect(() => {
    if (!user || user.dismissedAt) return;
    const onSynced = () => void loadWorkspaceData(user);
    window.addEventListener('pv:offline-synced', onSynced);
    return () => window.removeEventListener('pv:offline-synced', onSynced);
  }, [user, loadWorkspaceData]);

  // Periodic notifications refresh every 30s while authenticated
  useEffect(() => {
    if (!user || user.dismissedAt) return;
    const id = setInterval(() => {
      void apiRequest<{ notifications: NotificationItem[]; unreadCount: number }>(
        '/api/notifications'
      )
        .then((res) => {
          setNotifications(res.notifications);
          setUnreadCount(res.unreadCount);
        })
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [user]);

  const handleLogout = async () => {
    // Do not claim server logout when the request cannot reach the server.
    await apiRequest('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    try { await endOfflineSession(); }
    finally { setCsrfToken(null); setUser(null); clearWorkspace(); }
  };

  const handleOpenOrderById = async (orderId: string) => {
    const existing = orders.find((o) => o.id === orderId);
    if (existing) {
      setSelectedOrder(existing);
      return;
    }
    try {
      const res = await apiRequest<{ order: Order }>(`/api/orders/${orderId}`);
      setSelectedOrder(res.order);
    } catch {
      // Ignore if inaccessible
    }
  };

  const handleOrderUpdated = (updated: Order) => {
    setOrders((prev) => {
      const idx = prev.findIndex((o) => o.id === updated.id);
      if (idx === -1) return [updated, ...prev];
      const next = [...prev];
      next[idx] = updated;
      return next;
    });
    setSelectedOrder(updated);
  };

  const handleOrderDeleted = (orderId: string) => {
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
    setSelectedOrder(null);
  };

  const handleMarkNotifRead = async (id: string) => {
    await apiRequest(`/api/notifications/${id}/read`, { method: 'POST', body: {} });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
  };

  const handleMarkAllRead = async () => {
    await apiRequest('/api/notifications/read-all', { method: 'POST', body: {} });
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
    setUnreadCount(0);
  };

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F5F5F7] text-sm text-zinc-500 dark:bg-[#0B0C10]">
        Загрузка «Позитив Вектор»...
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        needsSetup={needsSetup}
        onAuthenticated={(authUser) => {
          return establishOfflineSession(authUser).then(() => {
          clearWorkspace();
          setNeedsSetup(false);
          setUser(authUser);
          setActiveTab('calendar');
          });
        }}
      />
    );
  }

  if (user.dismissedAt) return <DismissedScreen onLogout={() => void handleLogout()} />;

  const isAdmin = user.role === 'admin';
  const empCanClients = !isAdmin && (user.permissions['clients.view_all'] || user.permissions['orders.create']);
  const empCanWarehouse =
    !isAdmin &&
    (user.permissions['warehouse.take'] ||
      user.permissions['warehouse.receive'] ||
      user.permissions['warehouse.edit']);

  return (
    <AppShell
      user={user}
      companyName={settings.company_name || 'Позитив Вектор'}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      notifications={notifications}
      unreadCount={unreadCount}
      chatUnread={chatUnread}
      onMarkNotificationRead={(id) => void handleMarkNotifRead(id)}
      onMarkAllNotificationsRead={() => void handleMarkAllRead()}
      onOpenOrderLink={(id) => void handleOpenOrderById(id)}
      onLogout={() => void handleLogout()}
    >
      {/* Optional quick shortcuts for Employees with granted Client/Warehouse permissions */}
      {!isAdmin && (empCanClients || empCanWarehouse) && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('calendar')}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
              activeTab === 'calendar'
                ? 'bg-[#0071E3] text-white'
                : 'border border-black/[0.08] bg-white dark:border-white/[0.1] dark:bg-[#15171C]'
            }`}
          >
            Календарь и заказы
          </button>
          {empCanClients && (
            <button
              type="button"
              onClick={() => setActiveTab('clients')}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                activeTab === 'clients'
                  ? 'bg-[#0071E3] text-white'
                  : 'border border-black/[0.08] bg-white dark:border-white/[0.1] dark:bg-[#15171C]'
              }`}
            >
              Клиенты
            </button>
          )}
          {empCanWarehouse && (
            <button
              type="button"
              onClick={() => setActiveTab('warehouse')}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                activeTab === 'warehouse'
                  ? 'bg-[#0071E3] text-white'
                  : 'border border-black/[0.08] bg-white dark:border-white/[0.1] dark:bg-[#15171C]'
              }`}
            >
              Склад и инструменты
            </button>
          )}
        </div>
      )}

      {activeTab === 'calendar' && (
        <CalendarView
          user={user}
          orders={orders}
          shifts={shifts}
          activeShift={activeShift}
          materials={materials}
          onOpenCreateOrder={(d) => {
            setCreateOrderDate(d);
            setCreateOrderOpen(true);
          }}
          onOpenOrder={setSelectedOrder}
          onShiftChanged={() => void loadWorkspaceData(user)}
        />
      )}

      {activeTab === 'chat' && <ChatView user={user} onRead={refreshChatUnread} />}

      {activeTab === 'reports' && (
        <ReportsView
          user={user}
          directory={directory}
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
        />
      )}

      {activeTab === 'clients' && (isAdmin || empCanClients) && (
        <ClientsView
          user={user}
          companies={companies}
          contacts={contacts}
          onRefresh={() => void loadWorkspaceData(user)}
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
        />
      )}

      {activeTab === 'warehouse' && (isAdmin || empCanWarehouse) && (
        <WarehouseView
          user={user}
          materials={materials}
          tools={tools}
          operations={warehouseOps}
          units={settings.units || ['шт', 'м', 'м²', 'л', 'кг', 'рулон', 'уп']}
          categories={settings.material_categories || ['Прочее']}
          onRefresh={() => void loadWorkspaceData(user)}
        />
      )}

      {activeTab === 'finance' && isAdmin && (
        <FinanceView
          orders={orders}
          expenseCategories={
            settings.expense_categories || [
              { key: 'materials', label: 'Материалы' },
              { key: 'fuel', label: 'Бензин' },
              { key: 'rent', label: 'Аренда' },
              { key: 'other', label: 'Другие расходы' },
            ]
          }
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
        />
      )}

      {activeTab === 'employees' && isAdmin && (
        <EmployeesView onOpenOrderById={(id) => void handleOpenOrderById(id)} />
      )}

      {activeTab === 'salary' && !isAdmin && <EmployeeSalaryView />}

      {activeTab === 'settings' && (
        <SettingsView
          user={user}
          settings={settings}
          onUserUpdated={setUser}
          onSettingsUpdated={() => void loadWorkspaceData(user)}
          onLogout={() => void handleLogout()}
          onManageEmployees={() => setActiveTab('employees')}
        />
      )}

      <CreateOrderModal
        open={createOrderOpen}
        defaultDate={createOrderDate}
        user={user}
        directory={directory}
        companies={companies}
        contacts={contacts}
        materials={materials}
        tools={tools}
        availableTags={settings.order_tags || []}
        onClose={() => setCreateOrderOpen(false)}
        onCreated={(ord) => {
          setOrders((prev) => [ord, ...prev]);
          setSelectedOrder(ord);
        }}
      />

      <OrderDetailModal
        order={selectedOrder}
        user={user}
        directory={directory}
        companies={companies}
        contacts={contacts}
        materials={materials}
        tools={tools}
        availableTags={settings.order_tags || []}
        onClose={() => setSelectedOrder(null)}
        onOrderUpdated={handleOrderUpdated}
        onOrderDeleted={handleOrderDeleted}
        onWarehouseRefresh={() => void loadWorkspaceData(user)}
      />
    </AppShell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <CRMWorkspace />
    </ThemeProvider>
  );
}
