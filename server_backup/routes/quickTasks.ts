import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { notifyUser, writeAuditLog } from '../security.ts';

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function createQuickTasksRouter(db: DatabaseSync): express.Router {
  const router = express.Router();
  router.use(requireAuth);
  function visible(taskId: string, user: NonNullable<AuthedRequest['authUser']>) {
    return db.prepare(`SELECT * FROM quick_tasks WHERE id=? AND
      (?='admin' OR created_by=? OR EXISTS(SELECT 1 FROM quick_task_assignees a WHERE a.task_id=quick_tasks.id AND a.user_id=?))`)
      .get(taskId,user.role,user.id,user.id) as Record<string, unknown> | undefined;
  }
  function enrich(task: Record<string, unknown>) {
    return { ...task, status:task.cancelled_at ? 'cancelled' : task.status, assignees: db.prepare(`SELECT u.id,u.full_name FROM quick_task_assignees a JOIN users u ON u.id=a.user_id
      WHERE a.task_id=? ORDER BY u.full_name`).all(String(task.id)),
      completed_by_name: task.completed_by ? (db.prepare('SELECT full_name FROM users WHERE id=?').get(String(task.completed_by)) as {full_name:string} | undefined)?.full_name || null : null };
  }
  router.get('/', (req: AuthedRequest,res) => {
    const user=req.authUser!;
    const rows=db.prepare(`SELECT * FROM quick_tasks WHERE ?='admin' OR created_by=? OR
      EXISTS(SELECT 1 FROM quick_task_assignees a WHERE a.task_id=quick_tasks.id AND a.user_id=?)
      ORDER BY due_date,created_at`).all(user.role,user.id,user.id) as Array<Record<string,unknown>>;
    res.json({tasks:rows.map(enrich)});
  });
  router.get('/:id', (req: AuthedRequest,res) => {
    const row=visible(String(req.params.id),req.authUser!);
    if(!row){res.status(404).json({error:'Задача не найдена.'});return;}
    res.json({task:enrich(row)});
  });
  router.post('/', (req: AuthedRequest,res) => {
    const user=req.authUser!, body=req.body || {};
    const title=typeof body.title==='string' ? body.title.trim() : '';
    const description=typeof body.description==='string' ? body.description.trim() : '';
    const assignees=Array.isArray(body.assigneeIds) ? [...new Set(body.assigneeIds)] : [];
    if(!title || title.length>200 || description.length>4000 || !validDate(body.dueDate) || !assignees.length ||
      assignees.some(id=>typeof id!=='string' || !db.prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(id))) {
      res.status(400).json({error:'Укажите название, корректный срок и хотя бы одного действующего исполнителя.'});return;
    }
    const id=crypto.randomUUID(), now=new Date().toISOString();
    withTransaction(db,()=>{
      db.prepare('INSERT INTO quick_tasks(id,title,description,due_date,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id,title,description,body.dueDate,user.id,now,now);
      const insert=db.prepare('INSERT INTO quick_task_assignees(task_id,user_id) VALUES (?,?)');
      for(const assignee of assignees as string[]) {
        insert.run(id,assignee);
        if(assignee!==user.id) notifyUser(db,assignee,'quick_task_assigned','Новая быстрая задача',title,'quick_task',id);
      }
      writeAuditLog(db,user.id,'quick_task',id,'quick_task_created',{});
    });
    res.status(201).json({task:enrich(visible(id,user)!)});
  });
  router.patch('/:id', (req: AuthedRequest,res) => {
    const user=req.authUser!, id=String(req.params.id), task=visible(id,user);
    if(!task){res.status(404).json({error:'Задача не найдена.'});return;}
    if(!validDate(req.body?.dueDate)){res.status(400).json({error:'Укажите корректный срок.'});return;}
    withTransaction(db,()=>{
      db.prepare('UPDATE quick_tasks SET due_date=?,updated_at=? WHERE id=?').run(req.body.dueDate,new Date().toISOString(),id);
      writeAuditLog(db,user.id,'quick_task',id,'quick_task_rescheduled',{from:task.due_date,to:req.body.dueDate});
    });
    res.json({task:enrich(visible(id,user)!)});
  });
  router.post('/:id/complete', (req: AuthedRequest,res) => {
    const user=req.authUser!, id=String(req.params.id), task=visible(id,user);
    if(!task){res.status(404).json({error:'Задача не найдена.'});return;}
    if(!db.prepare('SELECT 1 FROM quick_task_assignees WHERE task_id=? AND user_id=?').get(id,user.id)) {
      res.status(403).json({error:'Завершить задачу может только назначенный исполнитель.'});return;
    }
    const comment=typeof req.body?.comment==='string' ? req.body.comment.trim() : '';
    if(!comment || comment.length>4000){res.status(400).json({error:'Опишите выполненную работу.'});return;}
    if(task.status!=='open' || task.cancelled_at){res.status(409).json({error:'Задача уже завершена или отменена. Обновите данные.'});return;}
    const now=new Date().toISOString();
    withTransaction(db,()=>{
      const result=db.prepare("UPDATE quick_tasks SET status='completed',completed_by=?,completed_at=?,completion_comment=?,updated_at=? WHERE id=? AND status='open'")
        .run(user.id,now,comment,now,id);
      if(!result.changes) throw new Error('Задача уже завершена.');
      if(task.created_by!==user.id) notifyUser(db,String(task.created_by),'quick_task_completed','Быстрая задача выполнена',String(task.title),'quick_task',id);
      writeAuditLog(db,user.id,'quick_task',id,'quick_task_completed',{});
    });
    res.json({task:enrich(visible(id,user)!)});
  });
  router.post('/:id/assignees', (req:AuthedRequest,res)=>{
    const user=req.authUser!,id=String(req.params.id),task=visible(id,user);
    if(!task){res.status(404).json({error:'Задача не найдена.'});return;}
    const ids=Array.isArray(req.body?.assigneeIds) ? [...new Set(req.body.assigneeIds)] : [];
    if(!ids.length || ids.some(id=>typeof id!=='string' || !db.prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(id))) {
      res.status(400).json({error:'Выберите хотя бы одного действующего исполнителя.'});return;
    }
    const before=(enrich(task).assignees as Array<{id:string}>).map(a=>a.id);
    withTransaction(db,()=>{
      db.prepare('DELETE FROM quick_task_assignees WHERE task_id=?').run(id);
      for(const assignee of ids as string[]) {
        db.prepare('INSERT INTO quick_task_assignees(task_id,user_id) VALUES (?,?)').run(id,assignee);
        if(!before.includes(assignee) && assignee!==user.id) notifyUser(db,assignee,'quick_task_assigned','Новая быстрая задача',String(task.title),'quick_task',id);
      }
      const now=new Date().toISOString();
      db.prepare('UPDATE quick_tasks SET updated_at=? WHERE id=?').run(now,id);
      db.prepare('INSERT INTO quick_task_events(id,task_id,actor_id,event_type,details_json,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),id,user.id,'assignees_changed',JSON.stringify({before,after:ids}),now);
      writeAuditLog(db,user.id,'quick_task',id,'quick_task_assignees_changed',{before,after:ids});
    });
    const updated=db.prepare('SELECT * FROM quick_tasks WHERE id=?').get(id) as Record<string,unknown>;
    res.json({task:enrich(updated),stillVisible:Boolean(visible(id,user))});
  });
  router.post('/:id/:action(cancel|reopen)', (req:AuthedRequest,res)=>{
    const user=req.authUser!,id=String(req.params.id),task=visible(id,user);
    if(!task){res.status(404).json({error:'Задача не найдена.'});return;}
    const action=String(req.params.action),cancelled=Boolean(task.cancelled_at);
    if(action==='cancel' && (cancelled || task.status==='completed')){res.status(409).json({error:'Отменить можно только открытую задачу.'});return;}
    if(action==='reopen' && !cancelled && task.status!=='completed'){res.status(409).json({error:'Задача уже открыта.'});return;}
    const now=new Date().toISOString();
    withTransaction(db,()=>{
      const details={previousStatus:cancelled?'cancelled':task.status,completedBy:task.completed_by,completedAt:task.completed_at,comment:task.completion_comment};
      db.prepare('INSERT INTO quick_task_events(id,task_id,actor_id,event_type,details_json,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),id,user.id,action,JSON.stringify(details),now);
      if(action==='cancel') db.prepare('UPDATE quick_tasks SET cancelled_at=?,updated_at=? WHERE id=?').run(now,now,id);
      else db.prepare("UPDATE quick_tasks SET cancelled_at=NULL,status='open',completed_by=NULL,completed_at=NULL,completion_comment='',updated_at=? WHERE id=?").run(now,id);
      writeAuditLog(db,user.id,'quick_task',id,`quick_task_${action}`,details);
    });
    res.json({task:enrich(visible(id,user)!)});
  });
  return router;
}
