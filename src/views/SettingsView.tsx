import React, { useEffect, useState } from 'react';
import { Download, LogOut, Moon, Save, Sun } from 'lucide-react';
import { PWAInstallButton } from '../components/PWAInstallButton';
import { useTheme } from '../components/ThemeContext';
import { apiRequest, formatDateTimeRu } from '../lib/api';
import type { AppSettings, AuthUser } from '../types/crm';

interface SettingsViewProps {
  user: AuthUser;
  settings: AppSettings;
  onUserUpdated: (user: AuthUser) => void;
  onSettingsUpdated: () => void;
  onLogout: () => void;
}

export function SettingsView({
  user,
  settings,
  onUserUpdated,
  onSettingsUpdated,
  onLogout,
}: SettingsViewProps) {
  const isAdmin = user.role === 'admin';
  const { theme, setTheme } = useTheme();

  // Profile self-service
  const [login, setLogin] = useState(user.login);
  const [fullName, setFullName] = useState(user.fullName);
  const [phone, setPhone] = useState(user.phone);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileErr, setProfileErr] = useState('');
  const [busy, setBusy] = useState(false);

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
    <div className="space-y-5">
      {/* Appearance & PWA */}
      <div className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold">Внешний вид и приложение</h3>
            <p className="text-xs text-zinc-500">Переключение светлой/тёмной темы и установка PWA</p>
          </div>
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
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/10 px-3.5 py-2 text-xs font-semibold text-red-600 dark:text-red-400"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Выйти</span>
            </button>
          </div>
        </div>
      </div>

      {/* Self-service Login / Password / Profile */}
      <form
        onSubmit={handleSaveProfile}
        className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]"
      >
        <h3 className="font-display text-base font-bold">Мой аккаунт и пароль</h3>
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

      {/* Admin-only Company Settings, XLSX Exports & Audit Log */}
      {isAdmin && (
        <>
          <form
            onSubmit={handleSaveSettings}
            className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]"
          >
            <h3 className="font-display text-base font-bold">Справочники и параметры компании</h3>
            {settingsMsg && <div className="mt-2 text-xs text-emerald-600">{settingsMsg}</div>}

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                  <span>Дублировать уведомления на Email (SMTP-параметры для сервера)</span>
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
                <p className="mt-1.5 text-[11px] text-zinc-400">
                  Доставка писем ещё не подключена. Уведомления доступны в приложении.
                </p>
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

          {/* XLSX Export Hub */}
          <div className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
            <h3 className="font-display text-base font-bold">Экспорт данных в XLSX</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Без паролей, хешей и токенов сессий. Можно выгрузить всю базу или отдельный раздел.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={expFrom}
                onChange={(e) => setExpFrom(e.target.value)}
                className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              />
              <span className="text-xs text-zinc-400">—</span>
              <input
                type="date"
                value={expTo}
                onChange={(e) => setExpTo(e.target.value)}
                className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
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

          {/* Audit Log */}
          <div className="rounded-2xl border border-black/[0.06] bg-white p-5 dark:border-white/[0.08] dark:bg-[#15171C]">
            <h3 className="mb-3 font-display text-base font-bold">Журнал действий (Аудит)</h3>
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
        </>
      )}
    </div>
  );
}
