import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Download, Eye, FileText, PencilRuler, Search, Trash2, Upload, X } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { apiRequest, formatDateTimeRu } from '../lib/api';
import type { Order } from '../types/crm';

interface DocumentItem {
  id: string;
  original_name: string;
  size_bytes: number;
  created_at: string;
  category?: string;
  order_id?: string | null;
  order_number?: string | null;
  order_title?: string | null;
}

interface DocumentsViewProps {
  orders?: Order[];
  onOpenOrderById?: (orderId: string) => void;
}

function getPreviewKind(filename: string): 'image' | 'frame' | 'unsupported' {
  const lower = filename.toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return 'image';
  if (/\.(pdf|txt)$/.test(lower)) return 'frame';
  return 'unsupported';
}

export function DocumentsView({ orders = [], onOpenOrderById }: DocumentsViewProps) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [category, setCategory] = useState<'acts' | 'drawings'>('acts');
  const [orderFilter, setOrderFilter] = useState('');
  const [uploadOrderId, setUploadOrderId] = useState('');
  const [previewDoc, setPreviewDoc] = useState<DocumentItem | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ q: query, sort, category });
      if (orderFilter) params.set('orderId', orderFilter);
      const result = await apiRequest<{ documents: DocumentItem[] }>(`/api/documents?${params}`, {
        useCache: false,
      });
      setDocuments(result.documents);
      setError('');
    } catch (err) {
      setDocuments([]);
      setError(err instanceof Error ? err.message : 'Не удалось загрузить документы.');
    }
  }, [query, sort, category, orderFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const uploadFiles = async (fileList: FileList | null) => {
    const selectedFiles = fileList ? Array.from(fileList) : [];
    if (selectedFiles.length === 0) return;
    setBusy(true);
    setError('');
    try {
      for (const targetFile of selectedFiles) {
        const data = new FormData();
        data.append('file', targetFile);
        data.append('category', category);
        if (uploadOrderId) data.append('orderId', uploadOrderId);
        await apiRequest('/api/documents', { method: 'POST', formData: data, skipOfflineQueue: true });
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/documents/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      if (previewDoc?.id === id) setPreviewDoc(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить документ.');
    } finally {
      setBusy(false);
    }
  };

  const move = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/documents/${id}`, {
        method: 'PATCH',
        body: { category: category === 'acts' ? 'drawings' : 'acts' },
        skipOfflineQueue: true,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переместить документ.');
    } finally {
      setBusy(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  };

  return (
    <section className="space-y-4">
      <SectionHeader<'acts' | 'drawings'>
        title="Документы"
        description="Акты выполненных работ и чертежи. Доступно администраторам с правом работы с документами."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {orders.length > 0 && (
              <select
                aria-label="Заказ при загрузке"
                value={uploadOrderId}
                onChange={(e) => setUploadOrderId(e.target.value)}
                className="max-w-[200px] rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              >
                <option value="">Без привязки к заказу</option>
                {orders.map((ord) => (
                  <option key={ord.id} value={ord.id}>
                    {ord.order_number} · {ord.title}
                  </option>
                ))}
              </select>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              aria-label="Выбрать документ"
              className="hidden"
              onChange={(e) => void uploadFiles(e.target.files)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex min-h-[40px] cursor-pointer items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#0077ED] disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>{busy ? 'Загрузка…' : 'Загрузить файл'}</span>
            </button>
          </div>
        }
        tabs={[
          { id: 'acts', label: 'Акты', icon: FileText },
          { id: 'drawings', label: 'Чертежи', icon: PencilRuler },
        ]}
        activeTab={category}
        onSelectTab={(tab) => {
          setConfirmDeleteId(null);
          setCategory(tab);
        }}
        filters={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по названию или заказу"
                aria-label="Поиск по названию"
                className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-2 pl-8 pr-3 text-xs outline-none focus:border-[#0071E3] focus:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10]"
              />
            </div>
            {orders.length > 0 && (
              <select
                value={orderFilter}
                onChange={(e) => setOrderFilter(e.target.value)}
                aria-label="Фильтр по заказу"
                className="max-w-[220px] rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
              >
                <option value="">Все заказы</option>
                {orders.map((ord) => (
                  <option key={ord.id} value={ord.id}>
                    {ord.order_number} · {ord.title}
                  </option>
                ))}
              </select>
            )}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              aria-label="Сортировка по дате"
              className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
            >
              <option value="newest">Сначала новые</option>
              <option value="oldest">Сначала старые</option>
            </select>
          </div>
        }
      />

      {error && (
        <p role="alert" className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
        {!error && documents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
            Документы в разделе «{category === 'acts' ? 'Акты' : 'Чертежи'}» не найдены
          </div>
        ) : (
          <ul className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
                <div className="min-w-0">
                  <div className="break-all text-sm font-semibold">{doc.original_name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                    <span>
                      {formatDateTimeRu(doc.created_at)}
                      {doc.size_bytes > 0 ? ` · ${formatSize(doc.size_bytes)}` : ''}
                    </span>
                    {doc.order_number && (
                      doc.order_id && onOpenOrderById ? (
                        <button
                          type="button"
                          onClick={() => onOpenOrderById(doc.order_id!)}
                          className="rounded-md bg-[#0071E3]/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#0071E3] hover:bg-[#0071E3]/15 dark:text-[#2997FF]"
                        >
                          {doc.order_number}
                          {doc.order_title ? ` · ${doc.order_title}` : ''}
                        </button>
                      ) : (
                        <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/[0.08]">
                          {doc.order_number}
                        </span>
                      )
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewDoc(doc)}
                    className="inline-flex items-center gap-1 rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>Просмотр</span>
                  </button>
                  <a
                    href={`/api/documents/${encodeURIComponent(doc.id)}/download`}
                    className="inline-flex items-center gap-1 rounded-xl bg-[#0071E3]/10 px-3 py-1.5 text-xs font-semibold text-[#0071E3] hover:bg-[#0071E3]/15 dark:text-[#2997FF]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Скачать</span>
                  </a>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void move(doc.id)}
                    className="inline-flex items-center gap-1 rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/[0.1]"
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    <span>{category === 'acts' ? 'В чертежи' : 'В акты'}</span>
                  </button>
                  {confirmDeleteId !== doc.id ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(doc.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-xl border border-red-500/25 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Удалить</span>
                    </button>
                  ) : (
                    <div className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs">
                      <span className="font-semibold text-red-600 dark:text-red-400">Удалить?</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(doc.id)}
                        className="rounded-lg bg-red-600 px-2 py-0.5 font-semibold text-white"
                      >
                        Да
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-1 text-zinc-500"
                      >
                        Нет
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {previewDoc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
          onClick={() => setPreviewDoc(null)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-black/[0.08] bg-white shadow-2xl dark:border-white/[0.1] dark:bg-[#15171C]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5 dark:border-white/[0.08]">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{previewDoc.original_name}</div>
                <div className="text-[11px] text-zinc-500">
                  {formatDateTimeRu(previewDoc.created_at)}
                  {previewDoc.order_number ? ` · ${previewDoc.order_number}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={`/api/documents/${encodeURIComponent(previewDoc.id)}/download`}
                  className="inline-flex items-center gap-1 rounded-xl bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Скачать</span>
                </a>
                <button
                  type="button"
                  aria-label="Закрыть просмотр"
                  onClick={() => setPreviewDoc(null)}
                  className="flex h-8 w-8 items-center justify-center rounded-xl bg-black/[0.05] text-zinc-500 hover:text-zinc-800 dark:bg-white/[0.08] dark:text-zinc-300"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex flex-1 items-center justify-center overflow-auto bg-[#F5F5F7] p-4 dark:bg-[#0B0C10]">
              {(() => {
                const kind = getPreviewKind(previewDoc.original_name);
                const inlineUrl = `/api/documents/${encodeURIComponent(previewDoc.id)}/download?inline=1`;
                if (kind === 'image') {
                  return (
                    <img
                      src={inlineUrl}
                      alt={previewDoc.original_name}
                      className="max-h-[75vh] max-w-full rounded-xl object-contain"
                    />
                  );
                }
                if (kind === 'frame') {
                  return (
                    <iframe
                      title={previewDoc.original_name}
                      src={inlineUrl}
                      className="h-[75vh] w-full rounded-xl bg-white"
                    />
                  );
                }
                return (
                  <div className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    Предпросмотр этого формата файла не поддерживается браузером. Используйте кнопку «Скачать».
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
