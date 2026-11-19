import React, { useEffect, useRef, useState } from 'react';
import { Mic, Paperclip, Send, Square, Trash2, Pencil } from 'lucide-react';
import { apiRequest, formatDateTimeRu } from '../lib/api';
import type { AuthUser, DirectoryUser } from '../types/crm';

type Message = { seq: number; id: string; author_id: string; author_name: string; body: string; file_id: string | null; original_name: string | null; mime_type: string | null; created_at: string; edited_at: string | null };
type Response = { messages: Message[]; unreadCount: number; hasMore: boolean };
type Room = { id: string; name: string; unreadCount: number; isMember: boolean };
export function ChatView({ user, onRead }: { user: AuthUser; onRead: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState(() => { const id = new URLSearchParams(window.location.search).get('chat'); return id && id !== '1' ? id : 'general'; });
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [mode, setMode] = useState<'create' | 'members' | null>(null);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [existingMembers, setExistingMembers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { const data = await apiRequest<{ rooms: Room[] }>('/api/chat/rooms', { useCache: false }); setRooms(data.rooms); };
  useEffect(() => { void refresh().catch(e => setError(e.message)); const timer = window.setInterval(() => void refresh().catch(() => {}), 10000); return () => clearInterval(timer); }, []);
  const open = async (next: 'create' | 'members') => {
    setBusy(true);
    try {
      const [dir, existing] = await Promise.all([
        apiRequest<{items: DirectoryUser[]}>('/api/users/directory', { useCache: false }),
        next === 'members' ? apiRequest<{memberIds: string[]}>(`/api/chat/rooms/${encodeURIComponent(selected)}/members`, { useCache: false }) : Promise.resolve({memberIds: []}),
      ]);
      setDirectory(dir.items); setMembers(existing.memberIds); setExistingMembers(existing.memberIds); setName(''); setError(''); setMode(next);
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка загрузки участников'); }
    finally { setBusy(false); }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (mode === 'create') { const result = await apiRequest<{id:string}>('/api/chat/rooms', { method:'POST', body:{name,memberIds:members}, skipOfflineQueue:true }); setSelected(result.id); }
      else await apiRequest(`/api/chat/rooms/${encodeURIComponent(selected)}/members`, {method:'POST',body:{memberIds:members},skipOfflineQueue:true});
      setMode(null); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка сохранения'); } finally { setBusy(false); }
  };
  const removeMember = async (memberId: string, memberName: string) => {
    if (!window.confirm(`Исключить ${memberName} из этого чата? Переписка сохранится.`)) return;
    try {
      await apiRequest(`/api/chat/rooms/${encodeURIComponent(selected)}/members/${encodeURIComponent(memberId)}`, {method:'DELETE',skipOfflineQueue:true});
      setMembers(prev => prev.filter(id => id !== memberId)); setExistingMembers(prev => prev.filter(id => id !== memberId)); await refresh(); onRead();
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка исключения участника'); }
  };
  const deleteRoom = async () => {
    if (!window.confirm(`Удалить чат «${room?.name}»? Он станет недоступен участникам, история сохранится в базе.`)) return;
    try {
      await apiRequest(`/api/chat/rooms/${encodeURIComponent(selected)}`, {method:'DELETE',skipOfflineQueue:true});
      setMode(null); setSelected('general'); await refresh(); onRead();
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка удаления чата'); }
  };
  const room = rooms.find(item => item.id === selected);
  return <div className="mx-auto max-w-4xl space-y-3">
    <div className="flex flex-wrap items-center gap-2" aria-label="Чаты">
      {rooms.map(item => <button key={item.id} type="button" disabled={busy} onClick={() => { setMode(null); setSelected(item.id); }} className={`rounded-xl px-3 py-2 text-sm font-semibold ${selected===item.id ? 'bg-[#0071E3] text-white' : 'bg-zinc-200 dark:bg-[#282b32]'}`}>{item.name}{item.unreadCount > 0 && ` (${item.unreadCount})`}</button>)}
      {user.role === 'admin' && <button type="button" disabled={busy} onClick={() => void open('create')} className="rounded-xl border border-zinc-400 px-3 py-2 text-sm">+ Создать чат</button>}
      {user.role === 'admin' && selected !== 'general' && room && <><button type="button" disabled={busy} onClick={() => void open('members')} className="rounded-xl border border-zinc-400 px-3 py-2 text-sm">Участники</button><button type="button" disabled={busy} onClick={() => void deleteRoom()} className="rounded-xl border border-red-400 px-3 py-2 text-sm text-red-600 dark:text-red-400">Удалить чат</button></>}
    </div>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {mode && <form onSubmit={save} className="space-y-3 rounded-2xl border border-zinc-400 bg-white p-4 dark:bg-[#15171C]">
      <h3 className="font-semibold">{mode === 'create' ? 'Новый чат' : `Участники: ${room?.name || ''}`}</h3>
      {mode === 'create' && <input aria-label="Название чата" required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="Название чата" className="w-full rounded-xl border border-zinc-400 bg-transparent p-2" />}
      <p className="text-xs text-zinc-500">Выбранные участники увидят всю историю этого чата. Создатель включается автоматически.</p>
      <div className="max-h-48 space-y-2 overflow-y-auto">{directory.filter(person => mode === 'members' || person.id !== user.id).map(person => <div key={person.id} className="flex items-center justify-between gap-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" disabled={mode === 'members' && existingMembers.includes(person.id)} checked={members.includes(person.id)} onChange={e => setMembers(prev => e.target.checked ? [...prev,person.id] : prev.filter(id => id !== person.id))} /><span>{person.fullName}{mode === 'members' && existingMembers.includes(person.id) ? ' · участник' : ''}</span></label>{mode === 'members' && existingMembers.includes(person.id) && <button type="button" onClick={() => void removeMember(person.id,person.fullName)} className="text-red-600 dark:text-red-400">Исключить</button>}</div>)}</div>
      <div className="flex gap-2"><button type="submit" disabled={busy} className="rounded-xl bg-[#0071E3] px-4 py-2 text-white">{mode === 'create' ? 'Создать' : 'Добавить'}</button><button type="button" onClick={() => setMode(null)} className="rounded-xl border border-zinc-400 px-4 py-2">Отмена</button></div>
    </form>}
    {room?.isMember && <ChatRoom key={room.id} room={room} user={user} onRead={() => { void refresh(); onRead(); }} />}
    {room && !room.isMember && <p className="text-sm text-zinc-500">Вы не участник этого чата. Администратор может добавить участников кнопкой выше.</p>}
    {!room && rooms.length > 0 && <p className="text-sm text-zinc-500">Чат недоступен. Выберите другой чат.</p>}
  </div>;
}

function ChatRoom({ user, room, onRead }: { user: AuthUser; room: Room; onRead: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const initial = useRef(true);
  const atBottom = useRef(true);
  const pendingMessage = useRef<{id:string;body:string;file:File|null} | null>(null);
  const load = async () => {
    const data = await apiRequest<Response>(`/api/chat/messages?room=${encodeURIComponent(room.id)}`, { useCache: false });
    const firstLoad = initial.current;
    setMessages(prev => {
      const older = prev.filter(m => data.messages.length && m.seq < data.messages[0].seq);
      return [...older, ...data.messages];
    });
    if (firstLoad) setHasMore(data.hasMore);
    if (document.visibilityState === 'visible' && (firstLoad || atBottom.current) && data.messages.length) {
      await apiRequest('/api/chat/read', { method: 'POST', body: { roomId: room.id, seq: data.messages[data.messages.length - 1].seq }, skipOfflineQueue: true });
      onRead();
    }
    if (firstLoad) { initial.current = false; setTimeout(() => end.current?.scrollIntoView(), 0); }
  };
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { atBottom.current = entries[0].isIntersecting; });
    if (end.current) observer.observe(end.current);
    void load().catch(e => setError(e.message));
    const timer = window.setInterval(() => void load().catch(() => {}), 5000);
    return () => { observer.disconnect(); clearInterval(timer); stream.current?.getTracks().forEach(track => track.stop()); };
  }, []);
  const older = async () => {
    try { const result = await apiRequest<Response>(`/api/chat/messages?room=${encodeURIComponent(room.id)}&before=${messages[0].seq}`, { useCache: false }); setMessages(prev => [...result.messages, ...prev]); setHasMore(result.hasMore); }
    catch (e) { setError(e instanceof Error ? e.message : 'Ошибка загрузки'); }
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy || (!body.trim() && !file)) return; setBusy(true); setError('');
    try {
      if (editing) await apiRequest(`/api/chat/messages/${editing}`, { method: 'PATCH', body: { body }, skipOfflineQueue: true });
      else {
        if (!pendingMessage.current || pendingMessage.current.body !== body || pendingMessage.current.file !== file) pendingMessage.current = {id:crypto.randomUUID(),body,file};
        const data = new FormData(); data.set('body', body); data.set('roomId', room.id); data.set('clientMessageId',pendingMessage.current.id); if (file) data.set('file', file);
        await apiRequest('/api/chat/messages', { method: 'POST', formData: data, skipOfflineQueue: true });
        pendingMessage.current = null;
      }
      setBody(''); setFile(null); setEditing(null);
      try { await load(); end.current?.scrollIntoView({ behavior: 'smooth' }); }
      catch { setError('Сообщение отправлено, но не удалось обновить чат.'); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка отправки'); } finally { setBusy(false); }
  };
  const record = async () => {
    if (recording) { recorder.current?.stop(); return; }
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Запись недоступна в этом браузере.');
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined), chunks: Blob[] = [];
      recorder.current = r;
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      r.onstop = () => { const type = r.mimeType.split(';')[0]; const blob = new Blob(chunks, { type }); if (blob.size) setFile(new File([blob], `Голосовое.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type })); stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setRecording(false); };
      r.start(); setRecording(true); setError('');
    } catch { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setError('Не удалось включить микрофон. Проверьте разрешение браузера.'); }
  };
  const enablePush = async () => {
    try {
      const { publicKey } = await apiRequest<{ publicKey: string | null }>('/api/chat/push-key', { useCache: false });
      if (!publicKey) throw new Error('Push пока не настроен на сервере.');
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('На этом устройстве push недоступен. На iPhone добавьте приложение на экран «Домой».');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      await apiRequest('/api/chat/push-subscription', { method: 'POST', body: subscription.toJSON(), skipOfflineQueue: true });
      setPushMessage('Уведомления на этом устройстве включены.');
    } catch (e) { setPushMessage(e instanceof Error ? e.message : 'Не удалось включить уведомления.'); }
  };
  return <div className="mx-auto flex max-w-4xl flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-display text-lg font-bold">{room.name}</h2><p className="text-xs text-zinc-500">{room.id === 'general' ? 'Доступен всем сотрудникам с учётной записью' : 'Доступен выбранным участникам'}</p></div><button onClick={() => void enablePush()} className="rounded-xl border border-zinc-400 px-3 py-2 text-xs">Включить уведомления</button></div>
    {pushMessage && <p className="text-sm text-zinc-500">{pushMessage}</p>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="min-h-[45vh] space-y-3 rounded-2xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-[#15171C]">
      {hasMore && <button className="text-sm text-[#0071E3]" onClick={() => void older()}>Загрузить более ранние сообщения</button>}
      {!messages.length && <p className="py-10 text-center text-sm text-zinc-500">Пока нет сообщений. Начните общение.</p>}
      {messages.map(m => { const mine = m.author_id === user.id; const canEdit = mine && Date.now() - Date.parse(m.created_at) < (user.role === 'admin' ? 86400000 : 300000); return <div key={m.id} className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
        <img src={`/api/chat/avatar/${m.author_id}`} alt="" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} className="h-9 w-9 rounded-full bg-zinc-300 object-cover" />
        <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-[#dfefff] dark:bg-[#193c5f]' : 'bg-zinc-100 dark:bg-[#282b32]'}`}>
          <div className="text-xs font-semibold text-[#0071E3] dark:text-[#71b5ff]">{m.author_name}</div>
          {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
          {m.file_id && (m.mime_type?.startsWith('audio/') ? <audio controls preload="metadata" src={`/api/chat/files/${m.file_id}`} className="max-w-full" /> : <a className="block break-all text-[#0071E3] underline dark:text-[#71b5ff]" href={`/api/chat/files/${m.file_id}`} target="_blank" rel="noreferrer">{m.original_name}</a>)}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500"><span>{formatDateTimeRu(m.created_at)}{m.edited_at ? ' · изменено' : ''}</span>{canEdit && <button aria-label="Редактировать сообщение" onClick={() => { setEditing(m.id); setBody(m.body); setFile(null); }}><Pencil size={13} /></button>}{(mine || user.role === 'admin') && <button aria-label="Удалить сообщение" onClick={() => { if (window.confirm('Удалить сообщение?')) void apiRequest(`/api/chat/messages/${m.id}`, { method: 'DELETE', skipOfflineQueue: true }).then(load).catch(e => setError(e.message)); }}><Trash2 size={13} /></button>}</div>
        </div></div>; })}<div ref={end} />
    </div>
    <form onSubmit={send} className="sticky bottom-20 flex flex-wrap items-end gap-2 rounded-2xl border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-[#15171C] md:bottom-3">
      {editing && <div className="w-full text-xs">Редактирование сообщения <button type="button" className="text-[#0071E3]" onClick={() => { setEditing(null); setBody(''); }}>Отмена</button></div>}
      {file && <div className="w-full text-xs">{file.name} <button type="button" className="text-red-500" onClick={() => setFile(null)}>Убрать</button></div>}
      {!editing && <label className="cursor-pointer rounded-xl p-2" title="Прикрепить файл"><Paperclip size={20} /><input type="file" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} /></label>}
      <textarea aria-label="Сообщение" value={body} onChange={e => setBody(e.target.value)} rows={2} maxLength={5000} placeholder="Напишите сообщение" className="min-w-0 flex-1 resize-y rounded-xl bg-zinc-100 p-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:bg-[#0B0C10]" />
      {!editing && <button type="button" aria-label={recording ? 'Остановить запись' : 'Записать голосовое сообщение'} onClick={() => void record()} className={`rounded-xl p-2 ${recording ? 'text-red-500' : ''}`}>{recording ? <Square size={20} /> : <Mic size={20} />}</button>}
      <button type="submit" disabled={busy || recording} aria-label="Отправить" className="rounded-xl bg-[#0071E3] p-2.5 text-white disabled:opacity-50"><Send size={20} /></button>
    </form>
  </div>;
}
