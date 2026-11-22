import React, { useCallback, useEffect, useState } from 'react';
import { apiRequest, formatDateTimeRu } from '../lib/api';

interface DocumentItem {
  id: string;
  original_name: string;
  size_bytes: number;
  created_at: string;
  category?: string;
}

export function DocumentsView() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [category, setCategory] = useState<'acts' | 'drawings'>('acts');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ q: query, sort, category });
      const result = await apiRequest<{ documents: DocumentItem[] }>(`/api/documents?${params}`, { useCache: false });
      setDocuments(result.documents);
      setError('');
    } catch (err) {
      setDocuments([]);
      setError(err instanceof Error ? err.message : 'Не удалось загрузить документы.');
    }
  }, [query, sort, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const data = new FormData();
      data.append('file', file);
      data.append('category', category);
      await apiRequest('/api/documents', { method: 'POST', formData: data, skipOfflineQueue: true });
      setFile(null);
      setInputKey((key) => key + 1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setConfirmDeleteId(null);
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/documents/${id}`, { method: 'DELETE' });
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
      await apiRequest(`/api/documents/${id}`, { method: 'PATCH', body: { category: category === 'acts' ? 'drawings' : 'acts' }, skipOfflineQueue: true });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переместить документ.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCategory('acts')}
          className={`rounded-xl px-3.5 py-2 text-sm ${category === 'acts' ? 'bg-[#0071E3] text-white' : 'border border-zinc-400'}`}
        >
          Акты
        </button>
        <button
          type="button"
          onClick={() => setCategory('drawings')}
          className={`rounded-xl px-3.5 py-2 text-sm ${category === 'drawings' ? 'bg-[#0071E3] text-white' : 'border border-zinc-400'}`}
        >
          Чертежи
        </button>
        <label className="relative flex items-center gap-2">
          <input
            key={inputKey}
            type="file"
            aria-label="Выбрать документ"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="hidden"
          />
          <button
            type="button"
            disabled={busy || !file}
            onClick={() => void upload()}
            className="rounded-xl bg-[#0071E3] px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? 'Загрузка…' : (file ? `Загрузить ${file.name}` : 'Выберите файл и загрузить')}
          </button>
        </label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по названию"
          aria-label="Поиск по названию"
          className="rounded-xl border border-zinc-400 bg-white px-3 py-2 dark:bg-[#0B0C10]"
        />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Сортировка по дате" className="rounded-xl border border-zinc-400 bg-white px-3 py-2 dark:bg-[#0B0C10]">
          <option value="newest">Сначала новые</option>
          <option value="oldest">Сначала старые</option>
        </select>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <ul className="divide-y divide-zinc-300 dark:divide-zinc-700">
        {documents.map((doc) => (
          <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <div className="break-all font-medium">{doc.original_name}</div>
              <div className="text-xs text-zinc-500">{formatDateTimeRu(doc.created_at)}</div>
            </div>
            <div className="flex items-center gap-4">
              <a href={`/api/documents/${encodeURIComponent(doc.id)}/download`} className="text-sm font-semibold text-[#0071E3]">Скачать</a>
              <button type="button" disabled={busy} onClick={() => void move(doc.id)} className="text-sm font-semibold text-[#0071E3] disabled:opacity-50">{category === 'acts' ? 'В чертежи' : 'В акты'}</button>
              <button
                type="button"
                onClick={() => void remove(doc.id)}
                disabled={busy}
                className="text-sm font-semibold text-red-600 hover:underline disabled:opacity-50"
              >
                {confirmDeleteId === doc.id ? 'Точно удалить?' : 'Удалить'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!error && documents.length === 0 && <p className="text-sm text-zinc-500">Документы не найдены.</p>}
    </section>
  );
}
