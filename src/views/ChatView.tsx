import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, ChevronDown, ChevronLeft, ChevronRight, FileText, MessageSquare, Mic, Paperclip, Pencil, Plus, Reply, Send, Square, Trash2, Users, X } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { apiRequest, formatDateTimeRu } from '../lib/api';
import { disablePushNotifications, enablePushNotifications, isPushNotificationsEnabled } from '../lib/push';
import { uploadWithRetry } from '../lib/upload';
import type { AuthUser, DirectoryUser } from '../types/crm';

const MAX_CHAT_FILES = 10;

type ChatAttachment = {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes?: number;
};

type Message = {
  seq: number;
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  file_id: string | null;
  original_name: string | null;
  mime_type: string | null;
  size_bytes?: number | null;
  attachments?: ChatAttachment[];
  created_at: string;
  edited_at: string | null;
  reply_to_id: string | null;
  reply_body: string | null;
  reply_author: string | null;
};
type Response = { messages: Message[]; unreadCount: number; hasMore: boolean };
type Room = { id: string; name: string; unreadCount: number; isMember: boolean };
type ViewerItem = { url: string; kind: 'image' | 'video'; name: string };

function getMessageAttachments(m: Message): ChatAttachment[] {
  if (Array.isArray(m.attachments) && m.attachments.length > 0) return m.attachments;
  if (m.file_id) {
    return [
      {
        id: m.file_id,
        original_name: m.original_name || 'Файл',
        mime_type: m.mime_type || 'application/octet-stream',
        size_bytes: m.size_bytes ?? undefined,
      },
    ];
  }
  return [];
}

function formatFileSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function ChatView({
  user,
  onRead,
  attachedOrder,
  onClearOrder,
  onOpenOrder,
}: {
  user: AuthUser;
  onRead: () => void;
  attachedOrder: { id: string; number: string } | null;
  onClearOrder: () => void;
  onOpenOrder: (id: string) => void;
}) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState(() => {
    const id = new URLSearchParams(window.location.search).get('chat');
    return id && id !== '1' ? id : 'general';
  });
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [mode, setMode] = useState<'create' | 'members' | null>(null);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [existingMembers, setExistingMembers] = useState<string[]>([]);
  const [confirmDeleteRoom, setConfirmDeleteRoom] = useState(false);
  const [confirmRemoveMemberId, setConfirmRemoveMemberId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState('');
  const [roomsMenuOpen, setRoomsMenuOpen] = useState(false);
  const roomsMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!roomsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (roomsMenuRef.current && !roomsMenuRef.current.contains(e.target as Node | null)) {
        setRoomsMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRoomsMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [roomsMenuOpen]);

  const refresh = async () => {
    const data = await apiRequest<{ rooms: Room[] }>('/api/chat/rooms', { useCache: false });
    setRooms(data.rooms);
  };

  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    void isPushNotificationsEnabled().then(setPushEnabled).catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, []);

  const togglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushMessage('');
    try {
      if (pushEnabled) {
        await disablePushNotifications();
        setPushEnabled(false);
        setPushMessage('Уведомления на этом устройстве отключены.');
      } else {
        await enablePushNotifications();
        setPushEnabled(true);
        setPushMessage('Уведомления на этом устройстве включены.');
      }
    } catch (e) {
      setPushMessage(e instanceof Error ? e.message : 'Не удалось изменить настройки уведомлений.');
    } finally {
      setPushBusy(false);
    }
  };

  const open = async (next: 'create' | 'members') => {
    setBusy(true);
    setConfirmDeleteRoom(false);
    setConfirmRemoveMemberId(null);
    try {
      const [dir, existing] = await Promise.all([
        apiRequest<{ items: DirectoryUser[] }>('/api/users/directory', { useCache: false }),
        next === 'members'
          ? apiRequest<{ memberIds: string[] }>(
              `/api/chat/rooms/${encodeURIComponent(selected)}/members`,
              { useCache: false }
            )
          : Promise.resolve({ memberIds: [] }),
      ]);
      setDirectory(dir.items);
      setMembers(existing.memberIds);
      setExistingMembers(existing.memberIds);
      setName('');
      setError('');
      setMode(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки участников');
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'create') {
        const result = await apiRequest<{ id: string }>('/api/chat/rooms', {
          method: 'POST',
          body: { name, memberIds: members },
          skipOfflineQueue: true,
        });
        setSelected(result.id);
      } else {
        await apiRequest(`/api/chat/rooms/${encodeURIComponent(selected)}/members`, {
          method: 'POST',
          body: { memberIds: members },
          skipOfflineQueue: true,
        });
      }
      setMode(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (memberId: string) => {
    try {
      await apiRequest(
        `/api/chat/rooms/${encodeURIComponent(selected)}/members/${encodeURIComponent(memberId)}`,
        { method: 'DELETE', skipOfflineQueue: true }
      );
      setConfirmRemoveMemberId(null);
      setMembers((prev) => prev.filter((id) => id !== memberId));
      setExistingMembers((prev) => prev.filter((id) => id !== memberId));
      await refresh();
      onRead();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка исключения участника');
    }
  };

  const deleteRoom = async () => {
    try {
      await apiRequest(`/api/chat/rooms/${encodeURIComponent(selected)}`, {
        method: 'DELETE',
        skipOfflineQueue: true,
      });
      setConfirmDeleteRoom(false);
      setMode(null);
      setSelected('general');
      await refresh();
      onRead();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка удаления чата');
    }
  };

  const room = rooms.find((item) => item.id === selected);
  const totalRoomUnread = rooms.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title={room?.name || 'Общий чат'}
        actions={
          <>
            <div ref={roomsMenuRef} className="relative inline-block">
              <button
                type="button"
                onClick={() => setRoomsMenuOpen((prev) => !prev)}
                aria-expanded={roomsMenuOpen}
                aria-haspopup="true"
                aria-label="Чаты"
                className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.04] dark:border-white/[0.1] dark:bg-[#0B0C10] dark:hover:bg-white/[0.06]"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span>Чаты</span>
                {totalRoomUnread > 0 && (
                  <span className="rounded-md bg-[#0071E3] px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums dark:bg-[#2997FF] dark:text-[#0B0C10]">
                    {totalRoomUnread}
                  </span>
                )}
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${roomsMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {roomsMenuOpen && (
                <div
                  className="absolute top-[calc(100%+8px)] left-0 z-50 w-60 max-w-[calc(100vw-3rem)] rounded-xl border border-black/[0.08] bg-white p-1 shadow-xl dark:border-white/[0.1] dark:bg-[#15171C]"
                  role="menu"
                  aria-label="Чаты"
                >
                  {rooms.map((item) => {
                    const active = item.id === selected;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMode(null);
                          setConfirmDeleteRoom(false);
                          setSelected(item.id);
                          setRoomsMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
                          active ? 'bg-[#0071E3]/10 text-[#0071E3] dark:text-[#2997FF]' : ''
                        }`}
                      >
                        <span className="truncate">{item.name}</span>
                        {item.unreadCount > 0 && (
                          <span className="shrink-0 rounded-md bg-[#0071E3] px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums dark:bg-[#2997FF] dark:text-[#0B0C10]">
                            {item.unreadCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              disabled={pushBusy}
              aria-label={pushEnabled ? 'Отключить уведомления' : 'Включить уведомления'}
              aria-pressed={pushEnabled}
              title={pushEnabled ? 'Отключить уведомления' : 'Включить уведомления'}
              onClick={() => void togglePush()}
              className={`inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-xl border transition disabled:opacity-50 ${
                pushEnabled
                  ? 'border-[#0071E3]/30 bg-[#0071E3]/10 text-[#0071E3] hover:bg-[#0071E3]/15 dark:border-[#2997FF]/35 dark:bg-[#2997FF]/15 dark:text-[#2997FF]'
                  : 'border-black/[0.08] text-zinc-500 hover:bg-black/[0.03] hover:text-[#1D1D1F] dark:border-white/[0.1] dark:text-zinc-400 dark:hover:text-white'
              }`}
            >
              {pushEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </button>
            {user.role === 'admin' && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void open('create')}
                  className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Создать чат</span>
                </button>
                {selected !== 'general' && room && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void open('members')}
                      className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]"
                    >
                      <Users className="h-3.5 w-3.5" />
                      <span>Участники</span>
                    </button>
                    {!confirmDeleteRoom ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteRoom(true)}
                        className="inline-flex min-h-[36px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-500/10 dark:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Удалить чат</span>
                      </button>
                    ) : (
                      <div className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs">
                        <span className="truncate font-semibold text-red-600 dark:text-red-400">
                          Удалить «{room.name}»?
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void deleteRoom()}
                          className="shrink-0 rounded-lg bg-red-600 px-2 py-1 font-semibold text-white"
                        >
                          Да
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteRoom(false)}
                          className="shrink-0 px-1.5 text-zinc-600 dark:text-zinc-300"
                        >
                          Нет
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        }
      />

      {pushMessage && <p className="text-xs text-zinc-500 dark:text-zinc-400">{pushMessage}</p>}
      {error && (
        <p role="alert" className="rounded-xl bg-red-500/10 px-3.5 py-2.5 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {mode && (
        <form
          onSubmit={save}
          className="space-y-3 rounded-2xl border border-black/[0.08] bg-white p-4 shadow-sm dark:border-white/[0.1] dark:bg-[#15171C]"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-bold">
              {mode === 'create' ? 'Новый чат' : `Участники: ${room?.name || ''}`}
            </h3>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-lg p-1 text-zinc-400 hover:text-zinc-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {mode === 'create' && (
            <input
              aria-label="Название чата"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название чата"
              className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
            />
          )}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Выбранные участники увидят всю историю этого чата. Создатель включается автоматически.
          </p>
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-black/[0.06] p-3 dark:border-white/[0.08]">
            {directory
              .filter((person) => mode === 'members' || person.id !== user.id)
              .map((person) => {
                const alreadyIn = mode === 'members' && existingMembers.includes(person.id);
                return (
                  <div key={person.id} className="flex items-center justify-between gap-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={alreadyIn}
                        checked={members.includes(person.id)}
                        onChange={(e) =>
                          setMembers((prev) =>
                            e.target.checked ? [...prev, person.id] : prev.filter((id) => id !== person.id)
                          )
                        }
                      />
                      <span>
                        {person.fullName}
                        {alreadyIn ? ' · участник' : ''}
                      </span>
                    </label>
                    {alreadyIn &&
                      (confirmRemoveMemberId !== person.id ? (
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveMemberId(person.id)}
                          className="text-xs font-semibold text-red-600 hover:underline dark:text-red-400"
                        >
                          Исключить
                        </button>
                      ) : (
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-red-600 dark:text-red-400">Исключить?</span>
                          <button
                            type="button"
                            onClick={() => void removeMember(person.id)}
                            className="rounded bg-red-600 px-2 py-0.5 font-semibold text-white"
                          >
                            Да
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRemoveMemberId(null)}
                            className="text-zinc-500"
                          >
                            Нет
                          </button>
                        </div>
                      ))}
                  </div>
                );
              })}
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {mode === 'create' ? 'Создать' : 'Добавить'}
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-xl border border-black/[0.1] px-4 py-2 text-xs font-semibold dark:border-white/[0.12]"
            >
              Отмена
            </button>
          </div>
        </form>
      )}

      {room?.isMember && (
        <ChatRoom
          key={room.id}
          room={room}
          user={user}
          attachedOrder={attachedOrder}
          onClearOrder={onClearOrder}
          onOpenOrder={onOpenOrder}
          onRead={() => {
            void refresh();
            onRead();
          }}
        />
      )}
      {room && !room.isMember && (
        <p className="rounded-2xl border border-black/[0.06] bg-white p-6 text-sm text-zinc-500 dark:border-white/[0.08] dark:bg-[#15171C]">
          Вы не участник этого чата. Администратор может добавить участников кнопкой выше.
        </p>
      )}
      {!room && rooms.length > 0 && (
        <p className="rounded-2xl border border-black/[0.06] bg-white p-6 text-sm text-zinc-500 dark:border-white/[0.08] dark:bg-[#15171C]">
          Чат недоступен. Выберите другой чат.
        </p>
      )}
    </div>
  );
}

function ChatRoom({
  user,
  room,
  onRead,
  attachedOrder,
  onClearOrder,
  onOpenOrder,
}: {
  user: AuthUser;
  room: Room;
  onRead: () => void;
  attachedOrder: { id: string; number: string } | null;
  onClearOrder: () => void;
  onOpenOrder: (id: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const filePreviews = useMemo(
    () =>
      files.map((f, index) => ({
        key: `${f.name}-${f.size}-${f.lastModified}-${index}`,
        file: f,
        url: f.type.startsWith('image/') || f.type.startsWith('video/') ? URL.createObjectURL(f) : null,
      })),
    [files]
  );
  useEffect(() => {
    return () => {
      for (const item of filePreviews) {
        if (item.url) URL.revokeObjectURL(item.url);
      }
    };
  }, [filePreviews]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<Message | null>(null);
  const [confirmDeleteMsgId, setConfirmDeleteMsgId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const initial = useRef(true);
  const atBottom = useRef(true);
  const pendingMessage = useRef<{
    id: string;
    body: string;
    files: File[];
    replyToId: string | null;
  } | null>(null);

  const load = async () => {
    const data = await apiRequest<Response>(`/api/chat/messages?room=${encodeURIComponent(room.id)}`, {
      useCache: false,
    });
    const firstLoad = initial.current;
    setMessages((prev) => {
      const older = prev.filter((m) => data.messages.length && m.seq < data.messages[0].seq);
      return [...older, ...data.messages];
    });
    if (firstLoad) setHasMore(data.hasMore);
    if (document.visibilityState === 'visible' && (firstLoad || atBottom.current) && data.messages.length) {
      await apiRequest('/api/chat/read', {
        method: 'POST',
        body: { roomId: room.id, seq: data.messages[data.messages.length - 1].seq },
        skipOfflineQueue: true,
      });
      onRead();
    }
    if (firstLoad) {
      initial.current = false;
      setTimeout(() => end.current?.scrollIntoView(), 0);
    }
  };

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      atBottom.current = entries[0].isIntersecting;
    });
    if (end.current) observer.observe(end.current);
    void load().catch((e) => setError(e.message));
    const timer = window.setInterval(() => void load().catch(() => {}), 5000);
    return () => {
      observer.disconnect();
      clearInterval(timer);
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const older = async () => {
    try {
      const result = await apiRequest<Response>(
        `/api/chat/messages?room=${encodeURIComponent(room.id)}&before=${messages[0].seq}`,
        { useCache: false }
      );
      setMessages((prev) => [...result.messages, ...prev]);
      setHasMore(result.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    }
  };

  const addPickedFiles = (pickedList: FileList | null) => {
    if (!pickedList || pickedList.length === 0) return;
    const incoming = Array.from(pickedList);
    setFiles((prev) => {
      const merged = [...prev];
      for (const f of incoming) {
        if (merged.length >= MAX_CHAT_FILES) break;
        const exists = merged.some(
          (item) => item.name === f.name && item.size === f.size && item.lastModified === f.lastModified
        );
        if (!exists) merged.push(f);
      }
      if (prev.length + incoming.length > MAX_CHAT_FILES) {
        setError(`Можно прикрепить не более ${MAX_CHAT_FILES} файлов к одному сообщению.`);
      } else {
        setError('');
      }
      return merged;
    });
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || (!body.trim() && files.length === 0 && !attachedOrder)) return;
    setBusy(true);
    setError('');
    setUploadProgress(files.length > 0 ? 0 : null);
    try {
      if (editing) {
        await apiRequest(`/api/chat/messages/${editing}`, {
          method: 'PATCH',
          body: { body },
          skipOfflineQueue: true,
        });
      } else {
        const fullBody = attachedOrder
          ? `${body.trim()}${body.trim() ? '\n' : ''}[[order:${attachedOrder.id}]]`
          : body;
        const replyToId = replying?.id || null;
        const sameFiles =
          pendingMessage.current &&
          pendingMessage.current.files.length === files.length &&
          pendingMessage.current.files.every((f, idx) => f === files[idx]);
        if (
          !pendingMessage.current ||
          pendingMessage.current.body !== fullBody ||
          !sameFiles ||
          pendingMessage.current.replyToId !== replyToId
        ) {
          pendingMessage.current = { id: crypto.randomUUID(), body: fullBody, files: [...files], replyToId };
        }
        const data = new FormData();
        data.set('body', fullBody);
        data.set('roomId', room.id);
        data.set('clientMessageId', pendingMessage.current.id);
        for (const f of files) {
          data.append('files', f);
        }
        if (replyToId) data.set('replyToId', replyToId);

        if (files.length > 0) {
          await uploadWithRetry({
            url: '/api/chat/messages',
            formData: data,
            onProgress: (pct) => setUploadProgress(pct),
          });
        } else {
          await apiRequest('/api/chat/messages', {
            method: 'POST',
            formData: data,
            skipOfflineQueue: true,
          });
        }
        pendingMessage.current = null;
        onClearOrder();
      }
      setBody('');
      setFiles([]);
      setEditing(null);
      setReplying(null);
      try {
        await load();
        end.current?.scrollIntoView({ behavior: 'smooth' });
      } catch {
        setError('Сообщение отправлено, но не удалось обновить чат.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка отправки');
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  const record = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error('Запись недоступна в этом браузере.');
      }
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
        MediaRecorder.isTypeSupported(t)
      );
      const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recorder.current = r;
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      r.onstop = () => {
        const type = r.mimeType.split(';')[0];
        const blob = new Blob(chunks, { type });
        if (blob.size) {
          const voiceFile = new File(
            [blob],
            `Голосовое.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`,
            { type }
          );
          setFiles((prev) => (prev.length < MAX_CHAT_FILES ? [...prev, voiceFile] : prev));
        }
        stream.current?.getTracks().forEach((t) => t.stop());
        stream.current = null;
        setRecording(false);
      };
      r.start();
      setRecording(true);
      setError('');
    } catch {
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      setError('Не удалось включить микрофон. Проверьте разрешение браузера.');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="min-h-[45vh] space-y-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
        {hasMore && (
          <button
            type="button"
            className="text-xs font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
            onClick={() => void older()}
          >
            Загрузить более ранние сообщения
          </button>
        )}
        {!messages.length && (
          <p className="py-10 text-center text-sm text-zinc-400">
            Пока нет сообщений. Начните общение.
          </p>
        )}
        {messages.map((m) => {
          const mine = m.author_id === user.id;
          const canEdit =
            mine && Date.now() - Date.parse(m.created_at) < (user.role === 'admin' ? 86400000 : 300000);
          return (
            <div id={`chat-message-${m.id}`} key={m.id} className={`flex gap-2.5 ${mine ? 'flex-row-reverse' : ''}`}>
              <img
                src={`/api/chat/avatar/${m.author_id}`}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.visibility = 'hidden';
                }}
                className="h-9 w-9 shrink-0 rounded-full bg-zinc-200 object-cover dark:bg-zinc-700"
              />
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                  mine
                    ? 'bg-[#0071E3]/12 text-[#1D1D1F] dark:bg-[#193c5f] dark:text-white'
                    : 'bg-[#F5F5F7] text-[#1D1D1F] dark:bg-[#22252C] dark:text-white'
                }`}
              >
                <div className="text-xs font-semibold text-[#0071E3] dark:text-[#71b5ff]">
                  {m.author_name}
                </div>
                {m.reply_to_id && (
                  <button
                    type="button"
                    className="my-1 block max-w-full border-l-2 border-[#0071E3] pl-2 text-left text-xs opacity-90"
                    onClick={() =>
                      document
                        .getElementById(`chat-message-${m.reply_to_id}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }
                  >
                    <span className="block font-semibold">{m.reply_author || 'Сообщение недоступно'}</span>
                    <span className="line-clamp-2">{m.reply_author ? m.reply_body || 'Вложение' : ''}</span>
                  </button>
                )}
                {m.body && (
                  <p className="whitespace-pre-wrap break-words">
                    {m.body.split(/(\[\[order:[0-9a-f-]{36}\]\])/gi).map((part, index) => {
                      const match = /^\[\[order:([0-9a-f-]{36})\]\]$/i.exec(part);
                      return match ? (
                        <button
                          key={index}
                          type="button"
                          onClick={() => onOpenOrder(match[1])}
                          className="font-semibold text-[#0071E3] underline dark:text-[#71b5ff]"
                        >
                          Открыть заказ
                        </button>
                      ) : (
                        part
                      );
                    })}
                  </p>
                )}
                {(() => {
                  const atts = getMessageAttachments(m);
                  if (atts.length === 0) return null;
                  const visuals = atts.filter(
                    (a) => a.mime_type.startsWith('image/') || a.mime_type.startsWith('video/')
                  );
                  const audios = atts.filter((a) => a.mime_type.startsWith('audio/'));
                  const docs = atts.filter(
                    (a) =>
                      !a.mime_type.startsWith('image/') &&
                      !a.mime_type.startsWith('video/') &&
                      !a.mime_type.startsWith('audio/')
                  );
                  const viewerItems: ViewerItem[] = visuals.map((a) => ({
                    url: `/api/chat/files/${a.id}`,
                    kind: a.mime_type.startsWith('video/') ? 'video' : 'image',
                    name: a.original_name,
                  }));
                  return (
                    <div className="mt-1.5 space-y-2">
                      {visuals.length > 0 && (
                        <div className={visuals.length > 1 ? 'grid grid-cols-2 gap-1.5' : 'space-y-1'}>
                          {visuals.map((att, idx) => {
                            const isVideo = att.mime_type.startsWith('video/');
                            const fileUrl = `/api/chat/files/${att.id}`;
                            return (
                              <div key={att.id} className="space-y-1">
                                <div className="relative overflow-hidden rounded-xl border border-black/10 bg-white dark:border-white/10 dark:bg-[#0B0C10]">
                                  {isVideo ? (
                                    <video
                                      controls
                                      preload="metadata"
                                      src={fileUrl}
                                      className={`${visuals.length > 1 ? 'h-36' : 'max-h-48'} w-full object-contain`}
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setViewer({ items: viewerItems, index: idx })}
                                      className="block w-full cursor-zoom-in"
                                    >
                                      <img
                                        src={fileUrl}
                                        alt={att.original_name}
                                        loading="lazy"
                                        className={`${visuals.length > 1 ? 'h-36 object-cover' : 'max-h-48 object-contain'} w-full`}
                                      />
                                    </button>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  {isVideo && (
                                    <button
                                      type="button"
                                      onClick={() => setViewer({ items: viewerItems, index: idx })}
                                      className="text-[#0071E3] underline dark:text-[#71b5ff]"
                                    >
                                      Во весь экран
                                    </button>
                                  )}
                                  <a
                                    className="block truncate text-[#0071E3] underline dark:text-[#71b5ff]"
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={att.original_name}
                                  >
                                    {att.original_name}
                                  </a>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {audios.map((att) => (
                        <audio
                          key={att.id}
                          controls
                          preload="metadata"
                          src={`/api/chat/files/${att.id}`}
                          className="max-w-full"
                        />
                      ))}
                      {docs.length > 0 && (
                        <div className="space-y-1">
                          {docs.map((att) => (
                            <a
                              key={att.id}
                              className="flex items-center gap-2 rounded-xl border border-black/[0.08] bg-white/80 px-2.5 py-1.5 text-xs text-[#0071E3] hover:bg-white dark:border-white/[0.1] dark:bg-[#0B0C10]/60 dark:text-[#71b5ff]"
                              href={`/api/chat/files/${att.id}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <FileText className="h-3.5 w-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate underline">{att.original_name}</span>
                              {att.size_bytes ? (
                                <span className="shrink-0 text-[11px] text-zinc-400">
                                  {formatFileSize(att.size_bytes)}
                                </span>
                              ) : null}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span className="tabular-nums">
                    {formatDateTimeRu(m.created_at)}
                    {m.edited_at ? ' · изменено' : ''}
                  </span>
                  <button
                    type="button"
                    aria-label="Ответить на сообщение"
                    onClick={() => {
                      setEditing(null);
                      setReplying(m);
                    }}
                    className="hover:text-[#0071E3]"
                  >
                    <Reply size={13} />
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      aria-label="Редактировать сообщение"
                      onClick={() => {
                        setReplying(null);
                        setEditing(m.id);
                        setBody(m.body);
                        setFiles([]);
                      }}
                      className="hover:text-[#0071E3]"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {(mine || user.role === 'admin') &&
                    (confirmDeleteMsgId !== m.id ? (
                      <button
                        type="button"
                        aria-label="Удалить сообщение"
                        onClick={() => setConfirmDeleteMsgId(m.id)}
                        className="hover:text-red-600"
                      >
                        <Trash2 size={13} />
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px]">
                        <button
                          type="button"
                          onClick={() =>
                            void apiRequest(`/api/chat/messages/${m.id}`, {
                              method: 'DELETE',
                              skipOfflineQueue: true,
                            })
                              .then(() => {
                                setConfirmDeleteMsgId(null);
                                return load();
                              })
                              .catch((e) => setError(e.message))
                          }
                          className="font-semibold text-red-600 dark:text-red-400"
                        >
                          Удалить
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteMsgId(null)}
                          className="text-zinc-500"
                        >
                          Нет
                        </button>
                      </span>
                    ))}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      <form
        onSubmit={send}
        className="sticky bottom-20 flex flex-wrap items-end gap-2 rounded-2xl border border-black/[0.08] bg-white p-3 shadow-lg dark:border-white/[0.1] dark:bg-[#15171C] md:bottom-3"
      >
        {editing && (
          <div className="w-full text-xs">
            Редактирование сообщения{' '}
            <button
              type="button"
              className="font-semibold text-[#0071E3]"
              onClick={() => {
                setEditing(null);
                setBody('');
              }}
            >
              Отмена
            </button>
          </div>
        )}
        {replying && !editing && (
          <div className="w-full text-xs">
            Ответ для {replying.author_name}: {(replying.body || 'Вложение').slice(0, 100)}{' '}
            <button
              type="button"
              className="font-semibold text-[#0071E3]"
              onClick={() => setReplying(null)}
            >
              Отмена
            </button>
          </div>
        )}
        {!editing && attachedOrder && (
          <div className="w-full text-xs">
            Прикреплён заказ <span className="font-mono font-semibold">{attachedOrder.number}</span>{' '}
            <button type="button" onClick={onClearOrder} className="font-semibold text-red-500">
              Убрать
            </button>
          </div>
        )}
        {files.length > 0 && (
          <div className="w-full space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
              <span>
                Выбрано файлов: {files.length} / {MAX_CHAT_FILES}
                {uploadProgress !== null ? ` · загрузка ${uploadProgress}%` : ''}
              </span>
              {files.length > 1 && !busy && (
                <button
                  type="button"
                  onClick={() => setFiles([])}
                  className="font-semibold text-red-500 hover:underline"
                >
                  Очистить все
                </button>
              )}
            </div>
            {uploadProgress !== null && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full bg-[#0071E3] transition-all dark:bg-[#2997FF]"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {filePreviews.map((item, idx) => (
                <div
                  key={item.key}
                  className="relative flex max-w-[200px] items-center gap-2 rounded-xl border border-black/[0.08] bg-[#F5F5F7] p-1.5 pr-7 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                >
                  {item.url ? (
                    item.file.type.startsWith('image/') ? (
                      <img src={item.url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <video src={item.url} className="h-10 w-10 shrink-0 rounded-lg bg-black object-cover" />
                    )
                  ) : (
                    <FileText className="h-5 w-5 shrink-0 text-[#0071E3] dark:text-[#2997FF]" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.file.name}</div>
                    <div className="text-[10px] text-zinc-400">{formatFileSize(item.file.size)}</div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Убрать файл ${item.file.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                    className="absolute right-1.5 top-1.5 rounded-full p-0.5 text-zinc-400 hover:bg-black/10 hover:text-red-500 dark:hover:bg-white/10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {!editing && (
          <label
            className="cursor-pointer rounded-xl p-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            title={`Прикрепить файлы (до ${MAX_CHAT_FILES})`}
          >
            <Paperclip size={20} />
            <input
              type="file"
              multiple
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
              className="hidden"
              onChange={(e) => {
                addPickedFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        )}
        <textarea
          aria-label="Сообщение"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && !recording) e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
          maxLength={5000}
          placeholder="Напишите сообщение"
          className="min-w-0 flex-1 resize-y rounded-xl bg-[#F5F5F7] p-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0071E3] dark:bg-[#0B0C10]"
        />
        {!editing && (
          <button
            type="button"
            aria-label={recording ? 'Остановить запись' : 'Записать голосовое сообщение'}
            onClick={() => void record()}
            className={`rounded-xl p-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${recording ? 'text-red-500' : ''}`}
          >
            {recording ? <Square size={20} /> : <Mic size={20} />}
          </button>
        )}
        <button
          type="submit"
          disabled={busy || recording}
          aria-label="Отправить"
          className="rounded-xl bg-[#0071E3] p-2.5 text-white hover:bg-[#0077ED] disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
        >
          <Send size={20} />
        </button>
      </form>

      {viewer && viewer.items[viewer.index] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setViewer(null)}
        >
          <div className="relative flex max-w-4xl flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex w-full items-center justify-between gap-4">
              <span className="text-xs text-white/75">
                {viewer.items.length > 1 ? `${viewer.index + 1} / ${viewer.items.length}` : ''}
              </span>
              <button
                type="button"
                aria-label="Закрыть просмотр"
                onClick={() => setViewer(null)}
                className="rounded-xl bg-white/15 p-2 text-white hover:bg-white/25"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              {viewer.items.length > 1 && (
                <button
                  type="button"
                  aria-label="Предыдущее вложение"
                  onClick={() =>
                    setViewer((prev) =>
                      prev
                        ? { ...prev, index: (prev.index - 1 + prev.items.length) % prev.items.length }
                        : null
                    )
                  }
                  className="rounded-xl bg-white/15 p-2 text-white hover:bg-white/25"
                >
                  <ChevronLeft size={22} />
                </button>
              )}
              {viewer.items[viewer.index].kind === 'video' ? (
                <video
                  controls
                  autoPlay
                  src={viewer.items[viewer.index].url}
                  className="max-h-[85vh] max-w-full rounded-xl bg-black"
                />
              ) : (
                <img
                  src={viewer.items[viewer.index].url}
                  alt={viewer.items[viewer.index].name}
                  className="max-h-[85vh] max-w-full rounded-xl object-contain"
                />
              )}
              {viewer.items.length > 1 && (
                <button
                  type="button"
                  aria-label="Следующее вложение"
                  onClick={() =>
                    setViewer((prev) =>
                      prev ? { ...prev, index: (prev.index + 1) % prev.items.length } : null
                    )
                  }
                  className="rounded-xl bg-white/15 p-2 text-white hover:bg-white/25"
                >
                  <ChevronRight size={22} />
                </button>
              )}
            </div>
            <div className="text-center text-xs text-white/80">{viewer.items[viewer.index].name}</div>
          </div>
        </div>
      )}
    </div>
  );
}
