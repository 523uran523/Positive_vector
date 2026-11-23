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
import { WorkView, type WorkSubTab } from './views/WorkView';
import { ClientsView } from './views/ClientsView';
import { EmployeeSalaryView } from './views/EmployeeSalaryView';
import { EmployeesView, type EmployeesTab } from './views/EmployeesView';
import { FinanceView } from './views/FinanceView';
import { CreateOrderModal, OrderDetailModal } from './views/OrderModals';
import { SettingsView } from './views/SettingsView';
import { WarehouseView } from './views/WarehouseView';
import { ChatView } from './views/ChatView';
import { DocumentsView } from './views/DocumentsView';

function CRMWorkspace() {
  const [booting, setBooting] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('yandex_connection') || params.has('settings')) return 'settings';
    if (params.has('chat')) return 'chat';
    return 'work';
  });
  const [workTab, setWorkTab] = useState<WorkSubTab>('calendar');
  const [employeesInitialTab, setEmployeesInitialTab] = useState<EmployeesTab>('active');
  const [uiError, setUiError] = useState('');

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
  const [createOrderCompanyId, setCreateOrderCompanyId] = useState<string | undefined>(undefined);
  const [createOrderContactId, setCreateOrderContactId] = useState<string | undefined>(undefined);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [chatOrder, setChatOrder] = useState<{ id: string; number: string } | null>(null);
  const [openQuickTaskId, setOpenQuickTaskId] = useState<string | null>(null);
  const clearWorkspace = useCallback(() => {
    setOrders([]);setCompanies([]);setContacts([]);setMaterials([]);setTools([]);
    setWarehouseOps([]);setShifts([]);setActiveShift(null);setNotifications([]);
    setUnreadCount(0);setSettings({});setDirectory([]);setSelectedOrder(null);
    setCreateOrderOpen(false);setCreateOrderCompanyId(undefined);setCreateOrderContactId(undefined);
    setOpenQuickTaskId(null);setActiveTab('work');setWorkTab('calendar');
    setEmployeesInitialTab('active');setUiError('');
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
      else {setOfflineOwner(null);localStorage.removeItem('pv-offline-session-v2');clearWorkspace();}
      setUser(status.user);
    } catch {
      const saved = restoredOfflineSession();
      if (saved) { setOfflineOwner(saved.id); setUser(saved); }
      else {setOfflineOwner(null);setCsrfToken(null);setUser(null);clearWorkspace();}
    } finally {
      setBooting(false);
    }
  }, [clearWorkspace]);

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
    if(!user || user.dismissedAt) return;
    const timer=window.setInterval(()=>void checkSession(),60_000);
    return ()=>window.clearInterval(timer);
  }, [user?.id,user?.dismissedAt,checkSession]);

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

  const consumeDeepLink = useCallback(
    (search: string, currentUser: AuthUser) => {
      const params = new URLSearchParams(search);
      const orderId = params.get('order');
      const taskId = params.get('task');
      const chatId = params.get('chat');
      const salaryFlag = params.get('salary');
      const shiftsFlag = params.get('shifts');
      const settingsFlag = params.get('settings');

      if (chatId) {
        setActiveTab('chat');
      } else if (settingsFlag) {
        setActiveTab('settings');
      } else if (shiftsFlag) {
        setActiveTab('work');
        setWorkTab('shifts');
      } else if (salaryFlag) {
        if (currentUser.role === 'admin') {
          setEmployeesInitialTab('salaries');
          setActiveTab('employees');
        } else {
          setActiveTab('salary');
        }
      } else if (taskId) {
        setActiveTab('work');
        setWorkTab('tasks');
        setOpenQuickTaskId(taskId);
      } else if (orderId) {
        setActiveTab('work');
        void apiRequest<{ order: Order }>(`/api/orders/${orderId}`, { useCache: false })
          .then((res) => setSelectedOrder(res.order))
          .catch(() => {});
      }

      if (orderId || taskId || salaryFlag || shiftsFlag || settingsFlag) {
        params.delete('order');
        params.delete('task');
        params.delete('salary');
        params.delete('shifts');
        params.delete('settings');
        const nextQs = params.toString();
        window.history.replaceState({}, '', `${window.location.pathname}${nextQs ? `?${nextQs}` : ''}`);
      }
    },
    []
  );

  useEffect(() => {
    if (!user || user.dismissedAt) return;
    consumeDeepLink(window.location.search, user);
    if (!('serviceWorker' in navigator)) return;
    const onSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'pv:navigate' && typeof event.data.url === 'string') {
        try {
          const parsed = new URL(event.data.url, window.location.origin);
          window.history.replaceState({}, '', `${parsed.pathname}${parsed.search}`);
          consumeDeepLink(parsed.search, user);
        } catch {
          // Ignore malformed navigation URL.
        }
      }
    };
    navigator.serviceWorker.addEventListener('message', onSwMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onSwMessage);
  }, [user, consumeDeepLink]);

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
    try {
      const res = await apiRequest<{ order: Order }>(`/api/orders/${orderId}`, { useCache: false });
      setSelectedOrder(res.order);
    } catch {
      const existing = orders.find((o) => o.id === orderId);
      if (existing) setSelectedOrder(existing);
    }
  };

  const handleOpenChatOrder = async (orderId: string) => {
    try {
      setUiError('');
      const res = await apiRequest<{ order: Order }>(`/api/orders/${orderId}`, { useCache: false });
      setSelectedOrder(res.order);
    } catch {
      setUiError('Не удалось открыть заказ. Проверьте подключение и доступ к заказу.');
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
          setActiveTab('work');
          setWorkTab('calendar');
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
      onSelectTab={(nextTab) => {
        if (nextTab === 'employees' && activeTab !== 'employees') {
          setEmployeesInitialTab('active');
        }
        setUiError('');
        setActiveTab(nextTab);
      }}
      notifications={notifications}
      unreadCount={unreadCount}
      chatUnread={chatUnread}
      onMarkNotificationRead={(id) => void handleMarkNotifRead(id)}
      onMarkAllNotificationsRead={() => void handleMarkAllRead()}
      onOpenOrderLink={(id) => void handleOpenOrderById(id)}
      onOpenTaskLink={(id) => {
        setActiveTab('work');
        setWorkTab('tasks');
        setOpenQuickTaskId(id);
      }}
      onOpenSalaryLink={() => {
        if (isAdmin) {
          setEmployeesInitialTab('salaries');
          setActiveTab('employees');
        } else {
          setActiveTab('salary');
        }
      }}
      onOpenShiftsLink={() => {
        setActiveTab('work');
        setWorkTab('shifts');
      }}
      onOpenChatLink={(roomId) => {
        const params = new URLSearchParams(window.location.search);
        params.set('chat', roomId);
        window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
        setActiveTab('chat');
      }}
      onOpenSettingsLink={() => setActiveTab('settings')}
      onLogout={() => void handleLogout()}
    >
      {uiError && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          <span>{uiError}</span>
          <button
            type="button"
            onClick={() => setUiError('')}
            className="text-xs font-semibold underline"
          >
            Скрыть
          </button>
        </div>
      )}

      {activeTab === 'work' && (
        <WorkView
          user={user}
          workTab={workTab}
          onSelectWorkTab={setWorkTab}
          orders={orders}
          companies={companies}
          shifts={shifts}
          activeShift={activeShift}
          materials={materials}
          directory={directory}
          openTaskId={openQuickTaskId}
          onConsumeOpenTask={() => setOpenQuickTaskId(null)}
          onOpenCreateOrder={(d) => {
            setCreateOrderDate(d);
            setCreateOrderCompanyId(undefined);
            setCreateOrderContactId(undefined);
            setCreateOrderOpen(true);
          }}
          onOpenOrder={setSelectedOrder}
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
          onShiftChanged={() => void loadWorkspaceData(user)}
        />
      )}

      {activeTab === 'chat' && (
        <ChatView
          user={user}
          onRead={refreshChatUnread}
          attachedOrder={chatOrder}
          onClearOrder={() => setChatOrder(null)}
          onOpenOrder={(id) => void handleOpenChatOrder(id)}
        />
      )}

      {activeTab === 'clients' && (isAdmin || empCanClients) && (
        <ClientsView
          user={user}
          companies={companies}
          contacts={contacts}
          onRefresh={() => void loadWorkspaceData(user)}
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
          onCreateOrderForClient={(companyId, contactId) => {
            setCreateOrderDate(undefined);
            setCreateOrderCompanyId(companyId || undefined);
            setCreateOrderContactId(contactId || undefined);
            setCreateOrderOpen(true);
          }}
        />
      )}

      {activeTab === 'warehouse' && (isAdmin || empCanWarehouse) && (
        <WarehouseView
          user={user}
          materials={materials}
          tools={tools}
          operations={warehouseOps}
          orders={orders}
          units={settings.units || ['шт', 'м', 'м²', 'л', 'кг', 'рулон', 'уп']}
          categories={settings.material_categories || ['Прочее']}
          onRefresh={() => void loadWorkspaceData(user)}
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
        />
      )}

      {activeTab === 'finance' && isAdmin && (
        <FinanceView
          user={user}
          directory={directory}
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
          onOpenSalaries={() => {
            setEmployeesInitialTab('salaries');
            setActiveTab('employees');
          }}
        />
      )}

      {activeTab === 'documents' && isAdmin && user.documentsAccess && (
        <DocumentsView
          orders={orders}
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
        />
      )}

      {activeTab === 'employees' && isAdmin && (
        <EmployeesView
          onOpenOrderById={(id) => void handleOpenOrderById(id)}
          currentUserId={user.id}
          onCurrentUserUpdated={setUser}
          initialTab={employeesInitialTab}
        />
      )}

      {activeTab === 'salary' && !isAdmin && (
        <EmployeeSalaryView onOpenOrderById={(id) => void handleOpenOrderById(id)} />
      )}

      {activeTab === 'settings' && (
        <SettingsView
          user={user}
          settings={settings}
          onUserUpdated={setUser}
          onSettingsUpdated={() => void loadWorkspaceData(user)}
          onLogout={() => void handleLogout()}
          onManageEmployees={() => {
            setEmployeesInitialTab('active');
            setActiveTab('employees');
          }}
        />
      )}

      <CreateOrderModal
        open={createOrderOpen}
        defaultDate={createOrderDate}
        defaultCompanyId={createOrderCompanyId}
        defaultContactId={createOrderContactId}
        user={user}
        directory={directory}
        companies={companies}
        contacts={contacts}
        materials={materials}
        tools={tools}
        availableTags={settings.order_tags || []}
        onClose={() => {
          setCreateOrderOpen(false);
          setCreateOrderCompanyId(undefined);
          setCreateOrderContactId(undefined);
        }}
        onRefreshWorkspace={() => void loadWorkspaceData(user)}
        onCreated={(ord) => {
          setOrders((prev) => [ord, ...prev]);
          setSelectedOrder(ord);
          void loadWorkspaceData(user);
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
        onDiscussOrder={(order) => { setChatOrder({id:order.id,number:order.order_number}); setSelectedOrder(null); setActiveTab('chat'); }}
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
