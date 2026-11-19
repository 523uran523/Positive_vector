import React, { useEffect, useState } from 'react';
import { CheckCircle2, ListTodo, Plus, X } from 'lucide-react';
import { apiRequest } from '../lib/api';
import type { AuthUser, DirectoryUser, QuickTask } from '../types/crm';

interface Props {
  user: AuthUser;
  directory: DirectoryUser[];
  selectedDate: string;
  dayTasks: QuickTask[];
  openTaskId: string | null;
  onConsumeOpenTask: () => void;
  onRefresh: () => void;
}

export function QuickTasks({ user, directory, selectedDate, dayTasks, openTaskId, onConsumeOpenTask, onRefresh }: Props) {
  const [creating, setCreating] = useState(false);
  const [task, setTask] = useState<QuickTask | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState(selectedDate);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingAssignees, setEditingAssignees] = useState(false);

  const openTask = async (id: string) => {
    setError('');
    try {
      const result = await apiRequest<{task:QuickTask}>(`/api/quick-tasks/${id}`);
      setCreating(false); setTask(result.task); setDueDate(result.task.due_date); setComment('');
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Не удалось открыть задачу'); }
  };
  useEffect(() => {
    if (openTaskId) { void openTask(openTaskId); onConsumeOpenTask(); }
  }, [openTaskId]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!assignees.length) { setError('Выберите хотя бы одного исполнителя.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiRequest<{task?:QuickTask;offlineQueued?:boolean}>('/api/quick-tasks', {
        method:'POST',body:{title,description,dueDate,assigneeIds:assignees},offlineLabel:`Создание задачи «${title.trim()}»`,
      });
      setCreating(false); setTitle(''); setDescription(''); setAssignees([]);
      if(result.offlineQueued) setNotice('Задача в офлайн-очереди и появится после отправки на сервер.');
      else if(result.task) { setTask(result.task); setDueDate(result.task.due_date); }
      onRefresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось создать задачу'); }
    finally { setBusy(false); }
  };
  const reschedule = async (event: React.FormEvent) => {
    event.preventDefault(); if(!task) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result=await apiRequest<{task?:QuickTask;offlineQueued?:boolean}>(`/api/quick-tasks/${task.id}`,{
        method:'PATCH',body:{dueDate},offlineLabel:`Перенос задачи «${task.title}»`,
      });
      if(result.offlineQueued) { setTask(null); setNotice('Перенос в офлайн-очереди; срок изменится после отправки.'); }
      else if(result.task) { setTask(result.task); setDueDate(result.task.due_date); }
      onRefresh();
    } catch(err) { setError(err instanceof Error ? err.message : 'Не удалось перенести срок'); }
    finally { setBusy(false); }
  };
  const complete = async (event: React.FormEvent) => {
    event.preventDefault(); if(!task) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result=await apiRequest<{task?:QuickTask;offlineQueued?:boolean}>(`/api/quick-tasks/${task.id}/complete`,{
        method:'POST',body:{comment},offlineLabel:`Завершение задачи «${task.title}»`,
      });
      if(result.offlineQueued) { setTask(null); setNotice('Завершение в офлайн-очереди; задача закроется после отправки.'); }
      else if(result.task) { setTask(result.task); setComment(''); }
      onRefresh();
    } catch(err) { setError(err instanceof Error ? err.message : 'Не удалось завершить задачу'); }
    finally { setBusy(false); }
  };
  const close = () => { setCreating(false); setTask(null); setError(''); setEditingAssignees(false); };
  const changeAssignees = async () => {
    if(!task || !assignees.length) {setError('Выберите хотя бы одного исполнителя.');return;}
    setBusy(true);setError('');
    try {
      const result=await apiRequest<{task?:QuickTask;stillVisible?:boolean;offlineQueued?:boolean}>(`/api/quick-tasks/${task.id}/assignees`,{method:'POST',body:{assigneeIds:assignees},offlineLabel:`Исполнители задачи «${task.title}»`});
      setEditingAssignees(false);
      if(result.offlineQueued){setTask(null);setNotice('Изменение исполнителей сохранено в офлайн-очередь.');}
      else if(result.stillVisible === false){setTask(null);setNotice('Исполнители изменены; задача больше вам не назначена.');}
      else if(result.task) setTask(result.task);
      onRefresh();
    } catch(err){setError(err instanceof Error ? err.message : 'Не удалось изменить исполнителей');}
    finally {setBusy(false);}
  };
  const transition = async (action:'cancel'|'reopen') => {
    if(!task) return;
    setBusy(true);setError('');
    try {
      const result=await apiRequest<{task?:QuickTask;offlineQueued?:boolean}>(`/api/quick-tasks/${task.id}/${action}`,{method:'POST',body:{},offlineLabel:`${action==='cancel'?'Отмена':'Возобновление'} задачи «${task.title}»`});
      if(result.offlineQueued){setTask(null);setNotice('Действие сохранено в офлайн-очередь.');}
      else if(result.task) setTask(result.task);
      onRefresh();
    } catch(err){setError(err instanceof Error ? err.message : 'Не удалось изменить задачу');}
    finally {setBusy(false);}
  };
  const canComplete=Boolean(task?.status==='open' && task.assignees.some(a=>a.id===user.id));

  return <>
    <button type="button" onClick={() => { setTask(null);setCreating(true);setDueDate(selectedDate);setError('');setNotice(''); }}
      className="mb-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-violet-500/40 px-4 py-3 text-sm font-semibold text-violet-700 dark:text-violet-300">
      <Plus className="h-4 w-4" /> Быстрая задача
    </button>
    {notice && <p role="status" className="mb-3 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">{notice}</p>}
    {dayTasks.length > 0 && <section className="mt-4 space-y-2">
      <h4 className="text-sm font-semibold text-violet-700 dark:text-violet-300">Быстрые задачи</h4>
      {dayTasks.map(item => <button key={item.id} type="button" onClick={() => { setError('');setNotice('');setCreating(false);setTask(item);setDueDate(item.due_date);setComment(''); }} className="w-full rounded-2xl border border-violet-500/20 bg-violet-500/5 p-3.5 text-left text-sm">
        <span className="flex items-center justify-between gap-2"><span className="font-semibold">{item.title}</span><span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{item.status==='completed' ? 'Выполнена' : item.status==='cancelled' ? 'Отменена' : 'Открыта'}</span></span>
        <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">{item.assignees.map(a=>a.full_name).join(', ')}</span>
      </button>)}
    </section>}

    {(creating || task) && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-black/10 bg-white p-5 shadow-2xl sm:rounded-3xl dark:border-white/10 dark:bg-[#15171C]">
        <div className="mb-4 flex items-start justify-between gap-3"><h2 className="font-display text-lg font-bold">{creating ? 'Новая быстрая задача' : task?.title}</h2><button type="button" onClick={close} aria-label="Закрыть" className="rounded-xl p-1.5 text-zinc-500"><X className="h-5 w-5" /></button></div>
        {error && <p role="alert" className="mb-3 rounded-xl bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {creating ? <form onSubmit={create} className="space-y-4">
          <label className="block text-sm font-semibold">Название <input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal outline-none focus:border-blue-500 dark:border-white/10 dark:bg-[#0B0C10]" /></label>
          <label className="block text-sm font-semibold">Описание <textarea maxLength={4000} rows={3} value={description} onChange={e=>setDescription(e.target.value)} className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal outline-none focus:border-blue-500 dark:border-white/10 dark:bg-[#0B0C10]" /></label>
          <label className="block text-sm font-semibold">Срок <input type="date" required value={dueDate} onChange={e=>setDueDate(e.target.value)} className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal dark:border-white/10 dark:bg-[#0B0C10]" /></label>
          <fieldset><legend className="text-sm font-semibold">Исполнители</legend><div className="mt-2 flex flex-wrap gap-2">{directory.map(person=><label key={person.id} className="flex min-h-10 items-center gap-2 rounded-xl border border-black/10 px-3 text-sm dark:border-white/10"><input type="checkbox" checked={assignees.includes(person.id)} onChange={e=>setAssignees(prev=>e.target.checked?[...prev,person.id]:prev.filter(id=>id!==person.id))} />{person.fullName}</label>)}</div>{!directory.length && <p className="mt-1 text-sm text-zinc-500">Список сотрудников недоступен. Подключитесь к сети.</p>}</fieldset>
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-[#0071E3] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Сохраняем…' : 'Создать задачу'}</button>
        </form> : task && <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2 font-semibold text-violet-700 dark:text-violet-300">{task.status==='completed' ? <CheckCircle2 className="h-4 w-4" /> : <ListTodo className="h-4 w-4" />}{task.status==='completed' ? 'Выполнена' : task.status==='cancelled' ? 'Отменена' : 'Открыта'}</div>
          {task.description && <p className="whitespace-pre-wrap break-words">{task.description}</p>}
          <p><span className="text-zinc-500">Исполнители: </span>{task.assignees.map(a=>a.full_name).join(', ')}</p>
          {!editingAssignees ? <button type="button" onClick={()=>{setAssignees(task.assignees.map(a=>a.id));setEditingAssignees(true);}} className="text-blue-600 dark:text-blue-300">Изменить исполнителей</button> : <div className="space-y-2"><div className="flex flex-wrap gap-2">{directory.map(person=><label key={person.id} className="flex items-center gap-2 rounded-xl border border-black/10 px-3 py-2 dark:border-white/10"><input type="checkbox" checked={assignees.includes(person.id)} onChange={e=>setAssignees(prev=>e.target.checked?[...prev,person.id]:prev.filter(id=>id!==person.id))} />{person.fullName}</label>)}</div><button type="button" disabled={busy} onClick={()=>void changeAssignees()} className="rounded-xl bg-blue-600 px-3 py-2 text-white">Сохранить исполнителей</button><button type="button" onClick={()=>setEditingAssignees(false)} className="ml-2">Отмена</button></div>}
          <form onSubmit={reschedule} className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 font-semibold">Срок <input type="date" required value={dueDate} onChange={e=>setDueDate(e.target.value)} className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal dark:border-white/10 dark:bg-[#0B0C10]" /></label><button type="submit" disabled={busy || dueDate===task.due_date} className="min-h-10 rounded-xl border border-blue-500/40 px-3 font-semibold text-blue-700 disabled:opacity-50 dark:text-blue-300">Перенести срок</button></form>
          {task.status==='completed' && <div className="rounded-xl bg-emerald-500/10 p-3"><p className="font-semibold">Завершил: {task.completed_by_name || 'Сотрудник'}</p><p className="mt-1 whitespace-pre-wrap break-words">{task.completion_comment}</p></div>}
          {canComplete && <form onSubmit={complete} className="space-y-2"><label className="block font-semibold">Что выполнено <textarea required maxLength={4000} rows={3} value={comment} onChange={e=>setComment(e.target.value)} placeholder="Напишите, что сделано" className="mt-1 w-full rounded-xl border border-black/10 bg-[#F5F5F7] px-3 py-2.5 font-normal dark:border-white/10 dark:bg-[#0B0C10]" /></label><button type="submit" disabled={busy} className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white disabled:opacity-50">Завершить задачу</button></form>}
          <button type="button" disabled={busy} onClick={()=>void transition(task.status==='open'?'cancel':'reopen')} className="rounded-xl border border-zinc-400 px-4 py-2">{task.status==='open'?'Отменить задачу':'Вернуть задачу в работу'}</button>
        </div>}
      </div>
    </div>}
  </>;
}
