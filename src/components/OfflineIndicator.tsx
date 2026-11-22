import { useEffect, useState } from 'react';
import { AlertCircle, ChevronUp, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { formatDateTimeRu, syncOfflineQueue } from '../lib/api';
import {
  listQueuedMutations,
  removeQueuedMutation,
  updateQueuedMutation,
  type QueuedMutation,
} from '../lib/offlineDb';

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  const [queue, setQueue] = useState<QueuedMutation[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [confirmReservedId, setConfirmReservedId] = useState<string | null>(null);

  const refreshQueue = async () => {
    try { const items = await listQueuedMutations(); setQueue(items); setStorageError(''); }
    catch(error) {setStorageError(error instanceof Error ? error.message : 'Ошибка локального хранилища.');}
  };

  useEffect(() => {
    void refreshQueue();
    const onQueueChanged = () => void refreshQueue();
    window.addEventListener('pv:queue-changed', onQueueChanged);
    return () => window.removeEventListener('pv:queue-changed', onQueueChanged);
  }, []);

  useEffect(() => {
    if (isOnline && queue.some((q) => q.status === 'pending')) {
      setSyncing(true);
      void syncOfflineQueue().catch(error=>setStorageError(String(error))).finally(() => setSyncing(false));
    }
  }, [isOnline, queue.length]);
  useEffect(() => {
    if(!isOnline || !queue.some(item=>item.status==='pending')) return;
    const timer=setInterval(()=>{
      void syncOfflineQueue().catch(error=>setStorageError(String(error)));
    },15_000);
    return ()=>clearInterval(timer);
  },[isOnline,queue.length]);

  const pendingCount = queue.filter((q) => q.status === 'pending').length;
  const failedCount = queue.filter((q) => q.status === 'failed').length;

  if (isOnline && queue.length === 0 && !storageError) return null;

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await syncOfflineQueue({ includeFailed: true });
    } catch(error) {
      setStorageError(error instanceof Error ? error.message : 'Ошибка синхронизации.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="fixed bottom-20 left-1/2 z-50 w-[calc(100%-24px)] max-w-md -translate-x-1/2 md:bottom-5">
      {storageError && <div role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-800">{storageError}</div>}
      {expanded && queue.length > 0 && (
        <div className="mb-2 max-h-60 overflow-y-auto rounded-2xl border border-black/[0.08] bg-white p-3 shadow-2xl dark:border-white/[0.1] dark:bg-[#15171C]">
          <div className="mb-2 flex items-center justify-between border-b border-black/[0.06] pb-2 text-xs font-bold dark:border-white/[0.08]">
            <span>Офлайн-очередь ({queue.length})</span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-zinc-400 hover:text-zinc-600"
            >
              Свернуть
            </button>
          </div>
          <div className="space-y-1.5">
            {queue.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-2 rounded-xl border border-black/[0.05] px-2.5 py-2 text-xs dark:border-white/[0.06]"
              >
                <div className="min-w-0">
                  <div className="truncate font-semibold">{item.label}</div>
                  <div className="text-[11px] text-zinc-400 tabular-nums">
                    {formatDateTimeRu(item.createdAt)}
                  </div>
                  {item.status === 'failed' && item.lastError && (
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      <span>{item.lastError}</span>
                    </div>
                  )}
                  {item.status === 'failed' && item.lastError?.includes('зарезервирована') && Boolean(item.body) && typeof item.body === 'object' && (
                    confirmReservedId !== item.id ? (
                      <button
                        type="button"
                        className="mt-1 text-blue-600 underline dark:text-blue-300"
                        onClick={() => setConfirmReservedId(item.id)}
                      >
                        Подтвердить выдачу и повторить
                      </button>
                    ) : (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px]">
                        <span className="text-amber-800 dark:text-amber-200">Выдать из резерва?</span>
                        <button
                          type="button"
                          className="font-semibold text-amber-700 underline dark:text-amber-300"
                          onClick={() => {
                            setConfirmReservedId(null);
                            void updateQueuedMutation(item.id, {
                              body: { ...(item.body as Record<string, unknown>), confirmReserved: true },
                              status: 'pending',
                              lastError: undefined,
                            })
                              .then(() => syncOfflineQueue())
                              .catch((error) => setStorageError(String(error)));
                          }}
                        >
                          Подтвердить
                        </button>
                        <button
                          type="button"
                          className="text-zinc-500 underline"
                          onClick={() => setConfirmReservedId(null)}
                        >
                          Отмена
                        </button>
                      </div>
                    )
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void removeQueuedMutation(item.id)}
                  title="Удалить из очереди"
                  className="shrink-0 rounded-lg p-1 text-zinc-400 hover:bg-red-500/10 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        className={`flex items-center justify-between gap-2 rounded-2xl border px-3.5 py-2 text-xs font-medium shadow-lg ${
          failedCount > 0 && isOnline
            ? 'border-red-500/30 bg-red-50 text-red-800 dark:bg-red-950/90 dark:text-red-200'
            : 'border-amber-500/30 bg-amber-50 text-amber-800 dark:bg-amber-950/90 dark:text-amber-200'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {!isOnline ? (
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${syncing ? 'animate-spin' : ''}`} />
          )}
          <span className="truncate">
            {!isOnline
              ? pendingCount > 0
                ? `Офлайн · в очереди: ${pendingCount}`
                : 'Офлайн-режим · кеш IndexedDB'
              : syncing
                ? `Синхронизация (${pendingCount})...`
                : failedCount > 0
                  ? `Ошибки синхронизации: ${failedCount}`
                  : `Ожидают отправки: ${pendingCount}`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isOnline && queue.length > 0 && (
            <button
              type="button"
              disabled={syncing}
              onClick={() => void handleManualSync()}
              className="rounded-lg bg-black/10 px-2 py-1 text-[11px] font-semibold hover:bg-black/15 dark:bg-white/15"
            >
              Синхр.
            </button>
          )}
          {queue.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="flex h-6 w-6 items-center justify-center rounded-lg bg-black/10 dark:bg-white/15"
              title="Показать очередь"
            >
              <ChevronUp className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
