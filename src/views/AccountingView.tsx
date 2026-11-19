import React, { useCallback, useEffect, useState } from 'react';
import { apiRequest, formatDateTimeRu } from '../lib/api';

interface DocumentItem { id: string; original_name: string; size_bytes: number; created_at: string }

export function AccountingView() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({q:query,sort});
      const result = await apiRequest<{documents: DocumentItem[]}>(`/api/accounting?${params}`, {useCache:false});
      setDocuments(result.documents); setError('');
    } catch (err) { setDocuments([]); setError(err instanceof Error ? err.message : 'Не удалось загрузить документы.'); }
  }, [query, sort]);
  useEffect(() => { void load(); }, [load]);
  const upload = async () => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const data = new FormData(); data.append('file',file);
      await apiRequest('/api/accounting',{method:'POST',formData:data,skipOfflineQueue:true});
      setFile(null); setInputKey((key) => key + 1); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось загрузить файл.'); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4">
    <h2 className="text-xl font-bold">Документы бухгалтерии</h2>
    <p className="text-sm text-zinc-500">Файлы доступны администраторам, которым открыт доступ к бухгалтерии. Максимальный размер файла — 12 МБ.</p>
    <div className="flex flex-wrap items-center gap-3"><input key={inputKey} type="file" aria-label="Выбрать документ" onChange={(e) => setFile(e.target.files?.[0] || null)} /><button type="button" disabled={!file || busy} onClick={() => void upload()} className="rounded-xl bg-[#0071E3] px-4 py-2 text-white disabled:opacity-50">{busy ? 'Загрузка…' : 'Загрузить файл'}</button></div>
    <div className="flex flex-wrap gap-2"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию" aria-label="Поиск по названию" className="rounded-xl border border-zinc-400 bg-white px-3 py-2 dark:bg-[#0B0C10]" /><select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Сортировка по дате" className="rounded-xl border border-zinc-400 bg-white px-3 py-2 dark:bg-[#0B0C10]"><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option></select></div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <ul className="divide-y divide-zinc-300 dark:divide-zinc-700">{documents.map((doc) => <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><div className="break-all font-medium">{doc.original_name}</div><div className="text-xs text-zinc-500">{formatDateTimeRu(doc.created_at)}</div></div><a href={`/api/accounting/${encodeURIComponent(doc.id)}/download`} className="text-sm font-semibold text-[#0071E3]">Скачать</a></li>)}</ul>
    {!error && documents.length === 0 && <p className="text-sm text-zinc-500">Документы не найдены.</p>}
  </section>;
}
