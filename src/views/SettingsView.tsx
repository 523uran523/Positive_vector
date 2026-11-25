import React, { useEffect, useState } from 'react';
import { Bell, ChevronDown, Download, LogOut, Moon, RefreshCw, Save, Sun } from 'lucide-react';
import { DatePresets } from '../components/DatePresets';
import { PWAInstallButton } from '../components/PWAInstallButton';
import { useTheme } from '../components/ThemeContext';
import { apiRequest, formatDateTimeRu } from '../lib/api';
import { enablePushNotifications } from '../lib/push';
import type { AppSettings, AuthUser } from '../types/crm';

type MessengerChannel = 'telegram' | 'max';

interface MessengerChannelStatus {
  configured: boolean;
  linked: boolean;
  username: string;
  botUsername: string;
}

interface MessengerStatus {
  telegram: MessengerChannelStatus;
  max: MessengerChannelStatus;
}

interface MessengerLinkInfo {
  channel: MessengerChannel;
  code: string;
  url: string | null;
  botUsername: string;
  expiresAt: string;
}

interface SettingsViewProps {
  user: AuthUser;
  settings: AppSettings;
  onUserUpdated: (user: AuthUser) => void;
  onSettingsUpdated: () => void;
  onLogout: () => void;
  onManageEmployees: () => void;
}

export function SettingsView({
  user,
  settings,
  onUserUpdated,
  onSettingsUpdated,
  onLogout,
  onManageEmployees,
}: SettingsViewProps) {
  const isAdmin = user.role === 'admin';
  const { theme, setTheme } = useTheme();
  // no Yandex disconnect needed
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    appearance: true,
    network: true,
    account: true,
    company: false,
    exportAudit: false,
  });
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  // Profile self-service
  const [login, setLogin] = useState(user.login);
  const [fullName, setFullName] = useState(user.fullName);
  const [phone, setPhone] = useState(user.phone);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileErr, setProfileErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);

  // Admin global settings
  const [companyName, setCompanyName] = useState(settings.company_name || 'Позитив Вектор');
  const [defaultRateRub, setDefaultRateRub] = useState(
    String(Math.round((settings.default_shift_rate_kopecks || 300000) / 100))
  );
  const [tagsText, setTagsText] = useState((settings.order_tags || []).join(', '));
  const [unitsText, setUnitsText] = useState((settings.units || []).join(', '));
  const [matCatsText, setMatCatsText] = useState((settings.material_categories || []).join(', '));
  const [expCatsText, setExpCatsText] = useState(
    (settings.expense_categories || []).map((c) => c.label).join(', ')
  );
  const [emailEnabled, setEmailEnabled] = useState(Boolean(settings.email_notifications?.enabled));
  const [emailHost, setEmailHost] = useState(settings.email_notifications?.smtpHost || '');
  const [emailFrom, setEmailFrom] = useState(settings.email_notifications?.fromAddress || '');
  const [settingsMsg, setSettingsMsg] = useState('');
  const [pushMsg, setPushMsg] = useState('');
  const [pushBusy, setPushBusy] = useState(false);
  // nothing - no Yandex Disk status

  // Deploy from GitHub
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState('');
  const [deployErr, setDeployErr] = useState('');

  const triggerDeploy = async () => {
    setDeployBusy(true);
    setDeployMsg('');
    setDeployErr('');
    try {
      await apiRequest('/api/deploy/from-git', { method: 'POST' });
      setDeployMsg('Обновление запущено. Сервер будет перезапущен автоматически.');
    } catch (err) {
      setDeployErr(err instanceof Error ? err.message : 'Не удалось запустить обновление.');
    } finally {
      setDeployBusy(false);
    }
  };

  const handleEnablePush = async () => {
    setPushBusy(true);
    setPushMsg('');
    try {
      await enablePushNotifications();
      setPushMsg('Push-уведомления на этом устройстве включены.');
    } catch (err) {
      setPushMsg(err instanceof Error ? err.message : 'Не удалось включить push-уведомления.');
    } finally {
      setPushBusy(false);
    }
  };

  // Messenger notifications
  const [messengerStatus, setMessengerStatus] = useState<MessengerStatus | null>(null);
  const [messengerLink, setMessengerLink] = useState<MessengerLinkInfo | null>(null);
  const [messengerMsg, setMessengerMsg] = useState('');
  const [messengerBusy, setMessengerBusy] = useState<MessengerChannel | ''>('');

  const loadMessengers = async () => {
    try {
      setMessengerStatus(await apiRequest<MessengerStatus>('/api/messengers/status', { useCache: false }));
    } catch {
      // Мессенджеры необязательны: молча пропускаем, если сервер их не отдал.
    }
  };
  useEffect(() => {
    void loadMessengers();
  }, []);

  useEffect(() => {
    if (!messengerLink) return;
    const timer = window.setInterval(() => {
      void loadMessengers();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [messengerLink]);

  useEffect(() => {
    if (!messengerLink || !messengerStatus) return;
    if (messengerStatus[messengerLink.channel].linked) {
      setMessengerLink(null);
      setMessengerMsg('Готово! Мессенджер подключён.');
    }
  }, [messengerStatus, messengerLink]);

  const connectMessenger = async (channel: MessengerChannel) => {
    setMessengerBusy(channel);
    setMessengerMsg('');
    try {
      const info = await apiRequest<MessengerLinkInfo>('/api/messengers/link', {
        method: 'POST',
        body: { channel },
        skipOfflineQueue: true,
      });
      setMessengerLink(info);
    } catch (err) {
      setMessengerMsg(err instanceof Error ? err.message : 'Не удалось начать подключение.');
    } finally {
      setMessengerBusy('');
    }
  };

  const disconnectMessenger = async (channel: MessengerChannel) => {
    setMessengerBusy(channel);
    setMessengerMsg('');
    try {
      await apiRequest('/api/messengers/unlink', {
        method: 'POST',
        body: { channel },
        skipOfflineQueue: true,
      });
      setMessengerLink(null);
      await loadMessengers();
      setMessengerMsg('Мессенджер отключён.');
    } catch (err) {
      setMessengerMsg(err instanceof Error ? err.message : 'Не удалось отключить мессенджер.');
    } finally {
      setMessengerBusy('');
    }
  };

  const testMessenger = async (channel: MessengerChannel) => {
    setMessengerBusy(channel);
    setMessengerMsg('');
    try {
      await apiRequest('/api/messengers/test', {
        method: 'POST',
        body: { channel },
        skipOfflineQueue: true,
      });
      setMessengerMsg('Тестовое сообщение отправлено.');
    } catch (err) {
      setMessengerMsg(err instanceof Error ? err.message : 'Не удалось отправить сообщение.');
    } finally {
      setMessengerBusy('');
    }
  };

  // Export filter & audit logs
  const [expFrom, setExpFrom] = useState('');
  const [expTo, setExpTo] = useState('');
  const [auditLogs, setAuditLogs] = useState<
    Array<{ id: string; actor_name: string; entity_type: string; action: string; created_at: string }>
  >([]);

  useEffect(() => {
    if (isAdmin) {
      void apiRequest<{ logs: any[] }>('/api/settings/audit-log')
        .then((r) => setAuditLogs(r.logs))
        .catch(() => {});
    }
  }, [isAdmin]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProfileMsg('');
    setProfileErr('');
    try {
      const res = await apiRequest<{ user: AuthUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: {
          login,
          fullName,
          phone,
          currentPassword: currentPassword || undefined,
          newPassword: newPassword || undefined,
        },
      });
      onUserUpdated(res.user);
      setCurrentPassword('');
      setNewPassword('');
      setProfileMsg('Профиль и учётные данные обновлены.');
    } catch (err) {
      setProfileErr(err instanceof Error ? err.message : 'Ошибка обновления профиля');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSettingsMsg('');
    try {
      const existingByLabel = new Map(
        (settings.expense_categories || []).map((c) => [c.label.toLowerCase(), c.key])
      );
      const expenseCategories = expCatsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((label, idx) => ({
          key: existingByLabel.get(label.toLowerCase()) || `cat_${idx + 1}`,
          label,
        }));

      const res = await apiRequest<{ offlineQueued?: boolean }>('/api/settings', {
        method: 'PUT',
        body: {
          company_name: companyName.trim() || 'Позитив Вектор',
          default_shift_rate_kopecks: Math.round(Number(defaultRateRub || 3000) * 100),
          order_tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
          units: unitsText.split(',').map((s) => s.trim()).filter(Boolean),
          material_categories: matCatsText.split(',').map((s) => s.trim()).filter(Boolean),
          ...(expenseCategories.length > 0 ? { expense_categories: expenseCategories } : {}),
          email_notifications: {
            enabled: emailEnabled,
            smtpHost: emailHost.trim(),
            fromAddress: emailFrom.trim(),
          },
        },
      });
      if (res?.offlineQueued) {
        setSettingsMsg('Настройки сохранены в офлайн-очередь и будут применены при появлении сети.');
      } else {
        setSettingsMsg('Настройки компании сохранены.');
        onSettingsUpdated();
      }
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : 'Ошибка сохранения настроек');
    } finally {
      setBusy(false);
    }
  };

  const qs = expFrom || expTo ? `?from=${expFrom}&to=${expTo}` : '';

  return (
    <div className="space-y-3">
      {/* 1. Внешний вид и приложение */}
      <div className="rounded-2xl border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#15171C]">
        <button
          type="button"
          onClick={() => toggleGroup('appearance')}
          aria-expanded={Boolean(openGroups.appearance)}
          className="flex w-full items-center justify-between gap-3 p-5 text-left"
        >
          <h3 className="font-display text-base font-bold">Внешний вид и приложение</h3>
          <ChevronDown
            className={`h-4 w-4 text-zinc-400 transition-transform ${openGroups.appearance ? 'rotate-180' : ''}`}
          />
        </button>
        {openGroups.appearance && (
          <div className="border-t border-black/[0.05] px-5 pb-5 pt-4 dark:border-white/[0.06]">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setTheme('light')}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold ${
                  theme === 'light'
                    ? 'bg-[#0071E3] text-white'
                    : 'border border-black/[0.08] dark:border-white/[0.1]'
                }`}
              >
                <Sun className="h-3.5 w-3.5" />
                <span>Светлая</span>
              </button>
              <button
                type="button"
                onClick={() => setTheme('dark')}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold ${
                  theme === 'dark'
                    ? 'bg-[#2997FF] text-[#0B0C10]'
                    : 'border border-black/[0.08] dark:border-white/[0.1]'
                }`}
              >
                <Moon className="h-3.5 w-3.5" />
                <span>Тёмная</span>
              </button>
              <PWAInstallButton compact />
              <button
                type="button"
                disabled={pushBusy}
                onClick={() => void handleEnablePush()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-black/[0.08] px-3.5 py-2 text-xs font-semibold hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/[0.1]"
              >
                <Bell className="h-3.5 w-3.5" />
                <span>Включить push-уведомления</span>
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/10 px-3.5 py-2 text-xs font-semibold text-red-600 dark:text-red-400"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Выйти</span>
              </button>
            </div>
            {pushMsg && <p role="status" className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400">{pushMsg}</p>}
          </div>
        )}
      </div>

      {/* 2. Мой аккаунт и пароль */}
      <div className="rounded-2xl border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#15171C]">
        <button
          type="button"
          onClick={() => toggleGroup('account')}
          aria-expanded={Boolean(openGroups.account)}
          className="flex w-full items-center justify-between gap-3 p-5 text-left"
        >
          <h3 className="font-display text-base font-bold">Мой аккаунт и пароль</h3>
          <ChevronDown
            className={`h-4 w-4 text-zinc-400 transition-transform ${openGroups.account ? 'rotate-180' : ''}`}
          />
        </button>
        {openGroups.account && (
          <form onSubmit={handleSaveProfile} className="border-t border-black/[0.05] px-5 pb-5 pt-4 dark:border-white/[0.06]">
            <div className="flex items-center gap-3">
              <img src={`/api/chat/avatar/${user.id}?v=${avatarVersion}`} alt="Аватар профиля" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} onLoad={e => { e.currentTarget.style.visibility = 'visible'; }} className="h-14 w-14 rounded-full bg-zinc-300 object-cover" />
              <label className="cursor-pointer rounded-xl border border-zinc-400 px-3 py-2 text-sm">Выбрать аватар
                <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (!file) return; const form = new FormData(); form.set('file', file); void apiRequest('/api/chat/avatar', { method: 'POST', formData: form, skipOfflineQueue: true }).then(() => { setAvatarVersion(Date.now()); setProfileMsg('Аватар обновлён.'); }).catch(err => setProfileErr(err.message)); e.target.value = ''; }} />
              </label>
            </div>
            {profileErr && <div className="mt-2 text-xs text-red-600">{profileErr}</div>}
            {profileMsg && <div className="mt-2 text-xs text-emerald-600">{profileMsg}</div>}

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-500">Логин</label>
                <input
                  type="text"
                  required
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-500">ФИО</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-500">Телефон</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Текущий пароль (если меняете пароль)"
                className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Новый пароль (минимум 6 символов)"
                className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              <Save className="h-3.5 w-3.5" />
              <span>Сохранить профиль</span>
            </button>
          </form>
        )}
      </div>

      {/* Категории администратора */}
      {isAdmin && (
        <>
          {/* 3. Справочники и параметры компании */}
          <div className="rounded-2xl border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#15171C]">
            <button
              type="button"
              onClick={() => toggleGroup('company')}
              aria-expanded={Boolean(openGroups.company)}
              className="flex w-full items-center justify-between gap-3 p-5 text-left"
            >
              <h3 className="font-display text-base font-bold">Справочники и параметры компании</h3>
              <ChevronDown
                className={`h-4 w-4 text-zinc-400 transition-transform ${openGroups.company ? 'rotate-180' : ''}`}
              />
            </button>
            {openGroups.company && (
              <div className="space-y-4 border-t border-black/[0.05] px-5 pb-5 pt-4 dark:border-white/[0.06]">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.06] bg-[#F5F5F7]/50 p-3.5 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                  <h4 className="text-sm font-bold">Учётные записи сотрудников</h4>
                  <button
                    type="button"
                    onClick={onManageEmployees}
                    className="rounded-xl border border-black/[0.1] bg-white px-4 py-2 text-xs font-semibold dark:border-white/[0.12] dark:bg-[#15171C]"
                  >
                    Управлять сотрудниками
                  </button>
                </div>

                <form onSubmit={handleSaveSettings}>
                  {settingsMsg && <div className="mb-3 text-xs text-emerald-600">{settingsMsg}</div>}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-zinc-500">
                        Название компании
                      </label>
                      <input
                        type="text"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-zinc-500">
                        Базовая ставка смены по умолчанию, ₽
                      </label>
                      <input
                        type="number"
                        value={defaultRateRub}
                        onChange={(e) => setDefaultRateRub(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-semibold text-zinc-500">
                        Теги заказов (через запятую)
                      </label>
                      <input
                        type="text"
                        value={tagsText}
                        onChange={(e) => setTagsText(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-zinc-500">
                        Единицы измерения склада
                      </label>
                      <input
                        type="text"
                        value={unitsText}
                        onChange={(e) => setUnitsText(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-zinc-500">
                        Категории материалов
                      </label>
                      <input
                        type="text"
                        value={matCatsText}
                        onChange={(e) => setMatCatsText(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-semibold text-zinc-500">
                        Категории расходов (через запятую)
                      </label>
                      <input
                        type="text"
                        value={expCatsText}
                        onChange={(e) => setExpCatsText(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      />
                    </div>
                    <div className="rounded-xl border border-black/[0.06] bg-[#F5F5F7]/50 p-3.5 sm:col-span-2 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold">
                        <input
                          type="checkbox"
                          checked={emailEnabled}
                          onChange={(e) => setEmailEnabled(e.target.checked)}
                          className="h-4 w-4 accent-[#0071E3]"
                        />
                        <span>Дублировать уведомления на Email</span>
                      </label>
                      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <input
                          type="text"
                          value={emailHost}
                          onChange={(e) => setEmailHost(e.target.value)}
                          placeholder="SMTP-хост (напр. smtp.yandex.ru)"
                          className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        />
                        <input
                          type="email"
                          value={emailFrom}
                          onChange={(e) => setEmailFrom(e.target.value)}
                          placeholder="Email отправителя"
                          className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
                  >
                    <Save className="h-3.5 w-3.5" />
                    <span>Сохранить справочники</span>
                  </button>
                </form>
              </div>
            )}
          </div>

          {/* 4. Сеть: Telegram, обновления */}
          <div className="rounded-2xl border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#15171C]">
            <button
              type="button"
              onClick={() => toggleGroup('network')}
              aria-expanded={Boolean(openGroups.network)}
              className="flex w-full items-center justify-between gap-3 p-5 text-left"
            >
              <h3 className="font-display text-base font-bold">Сеть</h3>
              <ChevronDown
                className={`h-4 w-4 text-zinc-400 transition-transform ${openGroups.network ? 'rotate-180' : ''}`}
              />
            </button>
            {openGroups.network && (
              <div className="space-y-4 border-t border-black/[0.05] px-5 pb-5 pt-4 dark:border-white/[0.06]">
                <div className="space-y-2.5">
                  <div className="text-xs font-bold text-zinc-500">Telegram</div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Задачи и сообщения из чата будут приходить в Telegram с кнопкой «Перейти». Подключение
                    занимает полминуты и делается один раз.
                  </p>
                  {(() => {
                    const channel = 'telegram' as const;
                    const status = messengerStatus?.[channel];
                    const busy = messengerBusy === channel;
                    const pending = messengerLink?.channel === channel ? messengerLink : null;
                    const badge = status?.linked
                      ? { text: 'Подключён', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' }
                      : status?.configured
                        ? { text: 'Не подключён', cls: 'bg-black/[0.04] text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400' }
                        : { text: 'Не настроен', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' };
                    return (
                      <div className="rounded-xl border border-black/[0.08] p-4 dark:border-white/[0.1]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold">Telegram</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
                            {badge.text}
                          </span>
                        </div>
                        {status?.linked ? (
                          <>
                            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              {status.username ? `@${status.username}` : 'Аккаунт привязан'}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void testMessenger(channel)}
                                className="rounded-xl border border-black/[0.08] px-3 py-2 text-xs font-semibold hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/[0.1]"
                              >
                                Проверить
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void disconnectMessenger(channel)}
                                className="rounded-xl bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 disabled:opacity-50 dark:text-red-400"
                              >
                                Отключить
                              </button>
                            </div>
                          </>
                        ) : status?.configured ? (
                          <>
                            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              Бот: @{status.botUsername}
                            </p>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void connectMessenger(channel)}
                              className="mt-3 rounded-xl bg-[#0071E3] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
                            >
                              Подключить
                            </button>
                            {pending && (
                              <div className="mt-3 rounded-xl bg-black/[0.03] p-3 text-xs dark:bg-white/[0.06]">
                                <div className="text-zinc-500 dark:text-zinc-400">Отправьте боту код:</div>
                                <div className="mt-1 font-mono text-base font-bold tracking-widest">{pending.code}</div>
                                {pending.url && (
                                  <a
                                    href={pending.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-2 inline-block font-semibold text-[#0071E3] dark:text-[#2997FF]"
                                  >
                                    Открыть Telegram
                                  </a>
                                )}
                                <div className="mt-1 text-[11px] text-zinc-400">
                                  Код действует 30 минут. Страница обновится сама.
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            Бот не настроен на сервере. Добавьте токен в .env и перезапустите.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  {messengerMsg && (
                    <p role="status" className="text-xs text-zinc-500 dark:text-zinc-400">
                      {messengerMsg}
                    </p>
                  )}
                </div>

                <div className="space-y-2.5">
                  <div className="text-xs font-bold text-zinc-500">Резервное копирование</div>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Локальная копия создаётся каждый день в 04:00 МСК на втором диске сервера (папка D:\PositiveVectorBackups). Хранятся копии за последние 3 дня, более старые удаляются автоматически.</p>
                </div>

                <div className="space-y-2.5 border-t border-black/[0.05] pt-4 dark:border-white/[0.06]">
                  <div className="text-xs font-bold text-zinc-500">Обновление из GitHub</div>
                  {deployMsg && <div role="status" className="text-xs text-emerald-600">{deployMsg}</div>}
                  {deployErr && <div role="alert" className="text-xs text-red-600">{deployErr}</div>}
                  <button
                    type="button"
                    disabled={deployBusy}
                    onClick={() => void triggerDeploy()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${deployBusy ? 'animate-spin' : ''}`} />
                    <span>{deployBusy ? 'Обновляется…' : 'Обновить из GitHub'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 5. Экспорт данных и журнал действий */}
          <div className="rounded-2xl border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#15171C]">
            <button
              type="button"
              onClick={() => toggleGroup('exportAudit')}
              aria-expanded={Boolean(openGroups.exportAudit)}
              className="flex w-full items-center justify-between gap-3 p-5 text-left"
            >
              <h3 className="font-display text-base font-bold">Экспорт данных в XLSX и журнал аудита</h3>
              <ChevronDown
                className={`h-4 w-4 text-zinc-400 transition-transform ${openGroups.exportAudit ? 'rotate-180' : ''}`}
              />
            </button>
            {openGroups.exportAudit && (
              <div className="space-y-5 border-t border-black/[0.05] px-5 pb-5 pt-4 dark:border-white/[0.06]">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      aria-label="Экспорт с"
                      value={expFrom}
                      onChange={(e) => setExpFrom(e.target.value)}
                      className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                    />
                    <span className="text-xs text-zinc-400">—</span>
                    <input
                      type="date"
                      aria-label="Экспорт по"
                      value={expTo}
                      onChange={(e) => setExpTo(e.target.value)}
                      className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                    />
                    <DatePresets
                      from={expFrom}
                      to={expTo}
                      onChange={(f, t) => {
                        setExpFrom(f);
                        setExpTo(t);
                      }}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <a
                      href={`/api/export/database.xlsx${qs}`}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Вся база данных (.xlsx)</span>
                    </a>
                    {[
                      { key: 'orders', label: 'Заказы' },
                      { key: 'clients', label: 'Клиенты' },
                      { key: 'warehouse', label: 'Склад' },
                      { key: 'salaries', label: 'Зарплаты' },
                      { key: 'finance', label: 'Финансы' },
                    ].map((s) => (
                      <a
                        key={s.key}
                        href={`/api/export/${s.key}.xlsx${qs}`}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-black/[0.08] px-3.5 py-2.5 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>{s.label}</span>
                      </a>
                    ))}
                  </div>
                </div>

                <div className="border-t border-black/[0.05] pt-4 dark:border-white/[0.06]">
                  <h4 className="mb-3 text-sm font-bold">Журнал действий (Аудит)</h4>
                  <div className="max-h-64 space-y-1.5 overflow-y-auto text-xs">
                    {auditLogs.map((log) => (
                      <div
                        key={log.id}
                        className="flex items-center justify-between rounded-xl border border-black/[0.05] px-3 py-2 dark:border-white/[0.06]"
                      >
                        <div>
                          <span className="font-semibold">{log.actor_name || 'Система'}</span>
                          <span className="mx-1.5 text-zinc-300">·</span>
                          <span className="font-mono text-[#0071E3]">{log.action}</span>
                          <span className="mx-1.5 text-zinc-300">·</span>
                          <span className="text-zinc-500">{log.entity_type}</span>
                        </div>
                        <span className="text-zinc-400 tabular-nums">{formatDateTimeRu(log.created_at)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
