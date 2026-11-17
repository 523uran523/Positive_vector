import React, { useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, Moon, ShieldCheck, Sun } from 'lucide-react';
import { apiRequest, setCsrfToken } from '../lib/api';
import type { AuthUser } from '../types/crm';
import { PWAInstallButton } from './PWAInstallButton';
import { useTheme } from './ThemeContext';

interface AuthScreenProps {
  needsSetup: boolean;
  onAuthenticated: (user: AuthUser) => void | Promise<void>;
}

export function AuthScreen({ needsSetup, onAuthenticated }: AuthScreenProps) {
  const { theme, toggleTheme } = useTheme();
  const [login, setLogin] = useState(needsSetup ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('Руководитель');
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [generatedCreds, setGeneratedCreds] = useState<{
    login: string;
    temporaryPassword: string;
    user: AuthUser;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const verifyCookieSession = async (): Promise<boolean> => {
    try {
      await apiRequest('/api/auth/me');
      return true;
    } catch {
      setCsrfToken(null);
      setError(
        'Браузер заблокировал cookie авторизации в окне предпросмотра. Разрешите сторонние cookie или откройте приложение по прямой ссылке в отдельной вкладке.'
      );
      return false;
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiRequest<{ user: AuthUser; csrfToken: string }>('/api/auth/login', {
        method: 'POST',
        body: { login, password },
      });
      setCsrfToken(res.csrfToken);
      if (await verifyCookieSession()) {
        await onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа');
    } finally {
      setLoading(false);
    }
  };

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiRequest<{
        user: AuthUser;
        csrfToken: string;
        generatedCredentials: { login: string; temporaryPassword: string } | null;
      }>('/api/auth/setup', {
        method: 'POST',
        body: { login, fullName, password, autoGenerate },
      });
      setCsrfToken(res.csrfToken);
      const cookieOk = await verifyCookieSession();
      if (res.generatedCredentials) {
        setGeneratedCreds({
          ...res.generatedCredentials,
          user: res.user,
        });
      } else if (cookieOk) {
        await onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка настройки');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCreds = async () => {
    if (!generatedCreds) return;
    await navigator.clipboard.writeText(
      `Позитив Вектор\nЛогин: ${generatedCreds.login}\nВременный пароль: ${generatedCreds.temporaryPassword}`
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex min-h-screen flex-col justify-between bg-[#F5F5F7] px-4 py-6 text-[#1D1D1F] transition-colors dark:bg-[#0B0C10] dark:text-[#F5F5F7]">
      <div className="mx-auto flex w-full max-w-md items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#0071E3] text-sm font-bold text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]">
            ПВ
          </div>
          <span className="font-display text-base font-bold tracking-tight">Позитив Вектор</span>
        </div>
        <div className="flex items-center gap-2">
          <PWAInstallButton compact />
          <button
            type="button"
            onClick={toggleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-black/[0.08] bg-white text-zinc-600 transition hover:bg-zinc-50 dark:border-white/[0.1] dark:bg-[#15171C] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
            aria-label="Сменить тему"
          >
            {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <main className="mx-auto my-auto w-full max-w-md py-8">
        {generatedCreds ? (
          <div className="rounded-3xl border border-black/[0.06] bg-white p-6 shadow-[0_8px_30px_rgba(0,0,0,0.06)] sm:p-8 dark:border-white/[0.08] dark:bg-[#15171C]">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">
              Администратор создан
            </h1>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
              Сохраните одноразовые учётные данные. После закрытия этого окна пароль больше не будет показан.
            </p>

            <div className="mt-5 space-y-3 rounded-2xl border border-black/[0.06] bg-[#F5F5F7] p-4 dark:border-white/[0.08] dark:bg-[#0B0C10]">
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">Логин</div>
                <div className="font-mono text-base font-semibold">{generatedCreds.login}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">Временный пароль</div>
                <div className="font-mono text-base font-semibold tracking-wide text-[#0071E3] dark:text-[#2997FF]">
                  {generatedCreds.temporaryPassword}
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
              <button
                type="button"
                onClick={() => void handleCopyCreds()}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-black/[0.08] bg-white px-4 py-3 text-sm font-semibold transition hover:bg-zinc-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                <span>{copied ? 'Скопировано' : 'Скопировать'}</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  try { if(await verifyCookieSession()) await onAuthenticated(generatedCreds.user); }
                  catch(error) { setError(error instanceof Error ? error.message : 'Не удалось открыть локальное хранилище.'); }
                }}
                className="flex-1 rounded-2xl bg-[#0071E3] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0077ED] dark:bg-[#2997FF] dark:text-[#0B0C10]"
              >
                Перейти в CRM
              </button>
            </div>
          </div>
        ) : needsSetup ? (
          <form
            onSubmit={handleSetupSubmit}
            className="rounded-3xl border border-black/[0.06] bg-white p-6 shadow-[0_8px_30px_rgba(0,0,0,0.06)] sm:p-8 dark:border-white/[0.08] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0071E3]/10 text-[#0071E3] dark:bg-[#2997FF]/15 dark:text-[#2997FF]">
              <KeyRound className="h-6 w-6" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">Первоначальная настройка</h1>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              Создайте первого администратора для запуска CRM/ERP «Позитив Вектор».
            </p>

            {error && (
              <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}

            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  ФИО руководителя
                </label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-3 text-sm outline-none transition focus:border-[#0071E3] focus:bg-white dark:border-white/[0.12] dark:bg-[#0B0C10] dark:focus:border-[#2997FF]"
                  placeholder="Иванов Сергей Петрович"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Логин администратора
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-3 text-sm outline-none transition focus:border-[#0071E3] focus:bg-white dark:border-white/[0.12] dark:bg-[#0B0C10] dark:focus:border-[#2997FF]"
                  placeholder="admin"
                />
              </div>

              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/[0.06] bg-[#F5F5F7]/70 px-3.5 py-3 text-sm dark:border-white/[0.08] dark:bg-[#0B0C10]">
                <input
                  type="checkbox"
                  checked={autoGenerate}
                  onChange={(e) => setAutoGenerate(e.target.checked)}
                  className="h-4 w-4 rounded accent-[#0071E3]"
                />
                <span>Сгенерировать безопасный одноразовый пароль автоматически</span>
              </label>

              {!autoGenerate && (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Пароль (минимум 6 символов)
                  </label>
                  <div className="relative">
                    <input
                      type={showPass ? 'text' : 'password'}
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-3 pr-11 text-sm outline-none transition focus:border-[#0071E3] focus:bg-white dark:border-white/[0.12] dark:bg-[#0B0C10] dark:focus:border-[#2997FF]"
                      placeholder="••••••"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass(!showPass)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                    >
                      {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-6 w-full rounded-2xl bg-[#0071E3] py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0077ED] disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {loading ? 'Создаём аккаунт...' : 'Создать администратора и войти'}
            </button>
          </form>
        ) : (
          <form
            onSubmit={handleLoginSubmit}
            className="rounded-3xl border border-black/[0.06] bg-white p-6 shadow-[0_8px_30px_rgba(0,0,0,0.06)] sm:p-8 dark:border-white/[0.08] dark:bg-[#15171C]"
          >
            <h1 className="font-display text-2xl font-bold tracking-tight">Вход в систему</h1>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              Управление производством, монтажами, складом и финансами.
            </p>

            {error && (
              <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}

            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Логин
                </label>
                <input
                  type="text"
                  required
                  autoComplete="username"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-3 text-sm outline-none transition focus:border-[#0071E3] focus:bg-white dark:border-white/[0.12] dark:bg-[#0B0C10] dark:focus:border-[#2997FF]"
                  placeholder="Введите логин"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Пароль
                </label>
                <div className="relative">
                  <input
                    type={showPass ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-3 pr-11 text-sm outline-none transition focus:border-[#0071E3] focus:bg-white dark:border-white/[0.12] dark:bg-[#0B0C10] dark:focus:border-[#2997FF]"
                    placeholder="Введите пароль"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                  >
                    {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-6 w-full rounded-2xl bg-[#0071E3] py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0077ED] disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {loading ? 'Выполняем вход...' : 'Войти'}
            </button>
          </form>
        )}
      </main>

      <footer className="text-center text-xs text-zinc-400 dark:text-zinc-500">
        Позитив Вектор · Изготовление и монтаж рекламы
      </footer>
    </div>
  );
}
