import React, { useEffect, useState } from 'react';
import { apiRequest, formatRub } from '../lib/api';

export function DismissedScreen({ onLogout }: { onLogout: () => void }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const load = async () => {
    try {
      const result = await apiRequest<{remainingKopecks:number;settlementPending:boolean}>('/api/auth/dismissal-balance', {useCache:false});
      setBalance(result.remainingKopecks); setPending(result.settlementPending); setError('');
    } catch { setBalance(null); setPending(false); setError('Не удалось получить остаток. Проверьте подключение или войдите заново.'); }
  };
  useEffect(() => { void load(); const timer=window.setInterval(() => void load(),30000); return () => clearInterval(timer); }, []);
  return <main className="flex min-h-screen items-center justify-center bg-[#F5F5F7] p-5 text-[#1D1D1F] dark:bg-[#0B0C10] dark:text-[#F5F5F7]">
    <div className="w-full max-w-md rounded-3xl border border-black/10 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-[#15171C]">
      <h1 className="font-display text-2xl font-bold">Вы уволены</h1>
      <p className="mt-5 text-sm text-zinc-600 dark:text-zinc-300">Остаток к выплате</p>
      <p className="mt-1 text-3xl font-bold tabular-nums">{balance === null ? '—' : formatRub(balance)}</p>
      {pending && <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">Есть незавершённые начисления. Окончательная сумма может измениться.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-6 flex gap-2"><button type="button" onClick={() => void load()} className="rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white">Обновить</button><button type="button" onClick={onLogout} className="rounded-xl border border-zinc-400 px-4 py-2 text-sm font-semibold">Выйти</button></div>
    </div>
  </main>;
}
